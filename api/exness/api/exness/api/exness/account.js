// NEGUS AI — Exness read-only account endpoint for Vercel
// Save as: api/exness/account.js
// Configure these as Vercel Environment Variables (never put secrets in GitHub):
// NEGUS_ACCESS_PIN, EXN_API_KEY, EXN_PRIVATE_KEY, EXN_ACCOUNT_ID,
// EXN_DISCOVERY_BASE_URL (exact Gateway host shown in the Exness DNS widget).
 
const crypto = require("crypto");
 
let cachedAccessPoint = "";
let cachedAt = 0;
 
function send(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.end(JSON.stringify(body));
}
 
function allowedOrigin(origin) {
  if (!origin) return true;
  return origin === "https://amhasilasienigus-ops.github.io" ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
}
 
function getPrivateKey() {
  const value = process.env.EXN_PRIVATE_KEY;
  if (!value) throw new Error("Missing server configuration");
  if (/^[0-9a-fA-F]{128}$/.test(value)) {
    const raw = Buffer.from(value, "hex");
    const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    return crypto.createPrivateKey({
      key: Buffer.concat([prefix, raw.subarray(0, 32)]),
      format: "der",
      type: "pkcs8"
    });
  }
  return crypto.createPrivateKey(value);
}
 
function base64url(buffer) {
  return buffer.toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
 
function signRequest(method, path, timestamp, body = "") {
  const apiKey = process.env.EXN_API_KEY;
  const privateKey = getPrivateKey();
  const payload = {
    api_key: apiKey,
    idempotency_key: "",
    timestamp,
    sign_version: 1,
    method,
    path,
    body_hash: base64url(crypto.createHash("sha256").update(body).digest())
  };
  const data = Buffer.from(JSON.stringify(payload));
  const signature = crypto.sign(null, data, privateKey);
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
  const response = await fetch(baseUrl + path, { method: "GET", headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { message: "Unexpected response from provider" }; }
  if (!response.ok) {
    const error = new Error("Exness request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}
 
async function discoverAccessPoint(accountId) {
  if (cachedAccessPoint && Date.now() - cachedAt < 60 * 60 * 1000) {
    return cachedAccessPoint;
  }
  const gateway = process.env.EXN_DISCOVERY_BASE_URL;
  if (!gateway) throw new Error("Missing server configuration");
  const path = "/v1/trading/access-point?account_id=" +
    encodeURIComponent(accountId);
  const result = await exnessGet(gateway.replace(/\/+$/, ""), path);
  const accessPoint = result.access_point;
  if (typeof accessPoint !== "string" ||
      !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(accessPoint)) {
    throw new Error("Access point discovery failed");
  }
  cachedAccessPoint = accessPoint.replace(/\/+$/, "");
  cachedAt = Date.now();
  return cachedAccessPoint;
}
 
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (!allowedOrigin(origin)) {
    return send(res, 403, { ok: false, error: "Origin not allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", origin || "https://amhasilasienigus-ops.github.io");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "X-NEGUS-ACCESS-PIN, Content-Type");
 
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "Method not allowed" });
 
  const required = [
    "NEGUS_ACCESS_PIN", "EXN_API_KEY", "EXN_PRIVATE_KEY",
    "EXN_ACCOUNT_ID", "EXN_DISCOVERY_BASE_URL"
  ];
  if (required.some((name) => !process.env[name])) {
    return send(res, 503, { ok: false, error: "Server configuration incomplete" });
  }
  const suppliedPin = req.headers["x-negus-access-pin"];
  if (!suppliedPin ||
      suppliedPin !== process.env.NEGUS_ACCESS_PIN) {
    return send(res, 401, { ok: false, error: "Access PIN required or incorrect" });
  }
 
  try {
    const accountId = process.env.EXN_ACCOUNT_ID;
    const accessPoint = await discoverAccessPoint(accountId);
    const path = "/v1/configuration/accounts/" +
      encodeURIComponent(accountId) + "/account";
    const account = await exnessGet(accessPoint, path);
    return send(res, 200, { ok: true, account });
  } catch (error) {
    const status = Number.isInteger(error.status) ? 502 : 500;
    return send(res, status, {
      ok: false,
      error: status === 502
        ? "Exness rejected or could not complete the request"
        : "Backend request failed"
    });
  }
};
