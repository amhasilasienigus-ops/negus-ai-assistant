
// NEGUS AI — Exness Read-Only Backend
// Vercel serverless function
// File: api/exness/account.js
// READ-ONLY: signed GET requests only. No trade execution or modification.

const crypto = require("crypto");

let cachedAccessPoint = "";
let cachedAt = 0;
let cachedAccountId = "";
let cachedGateway = "";

function send(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  return res.end(JSON.stringify(body));
}

function allowedOrigin(origin) {
  if (!origin) return true;
  return origin === "https://amhasilasienigus-ops.github.io";
}

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getPrivateKey() {
  const value = process.env.EXN_PRIVATE_KEY;

  if (!value) {
    throw makeError("Private key is missing", "PRIVATE_KEY_MISSING");
  }

  try {
    if (/^[0-9a-fA-F]{128}$/.test(value)) {
      const raw = Buffer.from(value, "hex");
      const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
      const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([prefix, raw.subarray(0, 32)]),
        format: "der",
        type: "pkcs8"
      });

      // Confirm that the supplied public half matches the seed-derived key.
      const derivedPublicKey = crypto.createPublicKey(privateKey);
      const publicDer = derivedPublicKey.export({ format: "der", type: "spki" });
      const derivedPublicRaw = publicDer.subarray(-32);
      const suppliedPublicRaw = raw.subarray(32, 64);

      if (!crypto.timingSafeEqual(derivedPublicRaw, suppliedPublicRaw)) {
        throw new Error("Private key public half mismatch");
      }

      return privateKey;
    }

    return crypto.createPrivateKey(value);
  } catch (_) {
    throw makeError("Private key format or key pair is invalid", "PRIVATE_KEY_INVALID");
  }
}

function base64url(buffer) {
  return buffer.toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signRequest(method, path, timestamp, body = "") {
  const apiKey = process.env.EXN_API_KEY;

  if (!apiKey) {
    throw makeError("API key is missing", "API_KEY_MISSING");
  }

  const privateKey = getPrivateKey();
  const payload = {
    api_key: apiKey,
    idempotency_key: "",
    timestamp,
    sign_version: 1,
    method,
    path,
    body_hash: base64url(
      crypto.createHash("sha256").update(body).digest()
    )
  };

  const data = Buffer.from(JSON.stringify(payload), "utf8");
  let signature;

  try {
    signature = crypto.sign(null, data, privateKey);
  } catch (_) {
    throw makeError("Request signing failed", "SIGNING_FAILED");
  }

  return {
    "EXN-API-KEY": apiKey,
    "EXN-IDEMPOTENCY-KEY": "",
    "EXN-TIMESTAMP": String(timestamp),
    "EXN-SIGN-VERSION": "1",
    "EXN-DATA": base64url(data),
    "EXN-SIGN": base64url(signature)
  };
}

async function exnessGet(baseUrl, path) {
  const timestamp = Date.now();
  const headers = signRequest("GET", path, timestamp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response;
  let responseText;

  try {
    response = await fetch(baseUrl + path, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    });
    responseText = await response.text();
  } catch (cause) {
    const error = makeError("Could not reach Exness API", "EXNESS_NETWORK_ERROR");
    error.cause = cause;
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const contentType = response.headers.get("content-type") || "";
  let data = {};

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch (_) {
    data = {};
  }

  if (!response.ok) {
    const error = makeError("Exness API returned an HTTP error", "EXNESS_HTTP_ERROR");
    error.status = response.status;

    const errorCode =
      data.error_code ?? data.code ?? data.error?.code ?? null;
    const errorMessage =
      data.error_message ?? data.description ?? data.message ?? data.error?.message ?? null;

    error.upstreamErrorCode =
      typeof errorCode === "string" || typeof errorCode === "number"
        ? String(errorCode).slice(0, 100)
        : null;
    error.upstreamErrorMessage =
      typeof errorMessage === "string"
        ? errorMessage.slice(0, 300)
        : null;
    error.upstreamContentType = contentType.slice(0, 100);
    throw error;
  }

  return data;
}

async function discoverAccessPoint(accountId) {
  const gateway = process.env.EXN_DISCOVERY_BASE_URL;

  if (!gateway) {
    throw makeError("Discovery URL is missing", "DISCOVERY_URL_MISSING");
  }

  // Cache only for the same account and gateway; avoid reusing a stale AP
  // if the Vercel environment configuration changes.
  if (
    cachedAccessPoint &&
    cachedAccountId === accountId &&
    cachedGateway === gateway &&
    Date.now() - cachedAt < 60 * 60 * 1000
  ) {
    return cachedAccessPoint;
  }

  let parsedGateway;
  try {
    parsedGateway = new URL(gateway.trim());
    if (
      parsedGateway.protocol !== "https:" ||
      !parsedGateway.hostname ||
      parsedGateway.username ||
      parsedGateway.password ||
      parsedGateway.search ||
      parsedGateway.hash ||
      (parsedGateway.pathname !== "/" && parsedGateway.pathname !== "")
    ) {
      throw new Error("Invalid discovery URL format");
    }
  } catch (error) {
    console.error("NEGUS_DISCOVERY_URL_DIAGNOSTIC", {
      valuePresent: Boolean(gateway),
      hasHttpsScheme: typeof gateway === "string" && /^https:\/\//i.test(gateway.trim()),
      parseError: error.name || "Error",
      errorCode: error.code || null
    });
    throw makeError("Discovery URL format is invalid", "DISCOVERY_URL_INVALID");
  }

  const baseUrl = parsedGateway.origin;
  const path = "/v1/trading/access-point?account_id=" + encodeURIComponent(accountId);
  const result = await exnessGet(baseUrl, path);
  const accessPoint = result.access_point;

  if (
    typeof accessPoint !== "string" ||
    !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(accessPoint)
  ) {
    throw makeError("Invalid Exness access point", "ACCESS_POINT_INVALID");
  }

  cachedAccessPoint = accessPoint.replace(/\/+$/, "");
  cachedAt = Date.now();
  cachedAccountId = accountId;
  cachedGateway = gateway;
  return cachedAccessPoint;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";

  if (!allowedOrigin(origin)) {
    return send(res, 403, { ok: false, error: "Origin not allowed" });
  }

  res.setHeader(
    "Access-Control-Allow-Origin",
    origin || "https://amhasilasienigus-ops.github.io"
  );
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "X-NEGUS-ACCESS-PIN, Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return send(res, 405, { ok: false, error: "Method not allowed" });
  }

  const required = [
    "NEGUS_ACCESS_PIN",
    "EXN_API_KEY",
    "EXN_PRIVATE_KEY",
    "EXN_ACCOUNT_ID",
    "EXN_DISCOVERY_BASE_URL"
  ];

  if (required.some(name => !process.env[name])) {
    return send(res, 503, {
      ok: false,
      error: "Server configuration incomplete"
    });
  }

  const suppliedPin = req.headers["x-negus-access-pin"];
  if (!suppliedPin || suppliedPin !== process.env.NEGUS_ACCESS_PIN) {
    return send(res, 401, {
      ok: false,
      error: "Access PIN required or incorrect"
    });
  }

  let stage = "ACCOUNT_REQUEST";

  try {
    const accountId = process.env.EXN_ACCOUNT_ID;

    stage = "ACCESS_POINT_DISCOVERY";
    const accessPoint = await discoverAccessPoint(accountId);

    stage = "ACCOUNT_DATA_REQUEST";
    const accountPath =
      "/v1/configuration/accounts/" + encodeURIComponent(accountId) + "/account";
    const account = await exnessGet(accessPoint, accountPath);

    // Required V12.3 addition: fetch the live trading snapshot separately.
    // Exness snapshot includes account_state (balance/equity/used_margin),
    // open positions and orders, subject to account/API permissions.
    stage = "TRADING_SNAPSHOT_REQUEST";
    const snapshotPath =
      "/v1/trading/accounts/" + encodeURIComponent(accountId) + "/snapshot";
    const snapshot = await exnessGet(accessPoint, snapshotPath);

    return send(res, 200, {
      ok: true,
      account,
      snapshot
    });

  } catch (error) {
    const diagnostic = error.code || stage;
    const upstreamStatus = Number.isInteger(error.status) ? error.status : null;
    const cause = error.cause || {};
    const nestedCause = cause.cause || {};

    // Never log API keys, PINs, private keys or signed headers.
    console.error("NEGUS_EXNESS_BACKEND_ERROR", {
      diagnostic,
      stage,
      upstreamStatus,
      upstreamErrorCode: error.upstreamErrorCode || null,
      upstreamErrorMessage: error.upstreamErrorMessage || null,
      upstreamContentType: error.upstreamContentType || null,
      errorName: error.name || "Error",
      causeName: cause.name || null,
      causeCode: cause.code || null,
      nestedCauseCode: nestedCause.code || null
    });

    const status = upstreamStatus ? 502 : 500;
    return send(res, status, {
      ok: false,
      error: "Backend request failed",
      diagnostic,
      stage,
      upstreamStatus,
      upstreamErrorCode: error.upstreamErrorCode || null,
      upstreamErrorMessage: error.upstreamErrorMessage || null
    });
  }
};
