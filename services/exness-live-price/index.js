// NEGUS AI — persistent Exness EUR/USD live-tick alert worker.
// Runs as a Render Background Worker (not a Vercel serverless function).
// READ-ONLY: signed GET WebSocket handshake; no trading operations.

const crypto = require("node:crypto");
const WebSocket = require("ws");

const {
  EXN_API_KEY, EXN_PRIVATE_KEY, EXN_ACCOUNT_ID, EXN_DISCOVERY_BASE_URL,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY,
  NEGUS_APP_URL = "https://amhasilasienigus-ops.github.io/negus-ai-assistant/"
} = process.env;

const required = {
  EXN_API_KEY, EXN_PRIVATE_KEY, EXN_ACCOUNT_ID, EXN_DISCOVERY_BASE_URL,
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY
};
for (const [name, value] of Object.entries(required)) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}
if (!/^\d{1,20}$/.test(EXN_ACCOUNT_ID)) throw new Error("EXN_ACCOUNT_ID must be the numeric trading account ID.");

const dbBase = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/price_alerts";
const authHeaders = SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_secret_")
  ? {} : { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

function base64url(buffer) {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function privateKey() {
  const value = EXN_PRIVATE_KEY;
  if (/^[0-9a-fA-F]{128}$/.test(value)) {
    const raw = Buffer.from(value, "hex");
    const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const key = crypto.createPrivateKey({ key: Buffer.concat([prefix, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
    const derived = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
    if (!crypto.timingSafeEqual(derived, raw.subarray(32, 64))) throw new Error("EXN_PRIVATE_KEY public half mismatch.");
    return key;
  }
  return crypto.createPrivateKey(value);
}
function signedHeaders(path) {
  const timestamp = Date.now();
  const payload = {
    api_key: EXN_API_KEY, idempotency_key: "", timestamp,
    sign_version: 1, method: "GET", path,
    body_hash: base64url(crypto.createHash("sha256").update("").digest())
  };
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    "EXN-API-KEY": EXN_API_KEY,
    "EXN-IDEMPOTENCY-KEY": "",
    "EXN-TIMESTAMP": String(timestamp),
    "EXN-SIGN-VERSION": "1",
    "EXN-DATA": base64url(data),
    "EXN-SIGN": base64url(crypto.sign(null, data, privateKey()))
  };
}
async function discoverAccessPoint() {
  const gateway = new URL(EXN_DISCOVERY_BASE_URL.trim());
  if (gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.search || gateway.hash || (gateway.pathname !== "/" && gateway.pathname !== "")) {
    throw new Error("EXN_DISCOVERY_BASE_URL must be the HTTPS Gateway host copied from Exness Key Management.");
  }
  const path = "/v1/trading/access-point?account_id=" + encodeURIComponent(EXN_ACCOUNT_ID);
  const response = await fetch(gateway.origin + path, { headers: signedHeaders(path), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_point !== "string" || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(body.access_point)) {
    throw new Error(`Exness access-point discovery failed: HTTP ${response.status} ${body.error_message || body.message || body.error_code || ""}`);
  }
  return body.access_point.replace(/\/+$/, "");
}
async function supabase(path, options = {}) {
  const response = await fetch(dbBase + path, {
    ...options, cache: "no-store",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY, ...authHeaders,
      "Content-Type": "application/json", ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function loadAlerts() {
  const rows = await supabase("?select=id,onesignal_subscription_id,upper_price,lower_price,is_armed&is_armed=eq.true");
  return Array.isArray(rows) ? rows : [];
}
async function sendAlert(row, direction, target, price) {
  const sid = String(row.onesignal_subscription_id || "");
  if (!sid) throw new Error(`Armed alert ${row.id} has no OneSignal subscription ID.`);
  const key = `negus-exness-live-${row.id}-${direction}-${target}`;
  const response = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST",
    headers: { Authorization: `Key ${ONESIGNAL_REST_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID, include_subscription_ids: [sid],
      headings: { en: "NEGUS AI — EXNESS LIVE PRICE ALERT" },
      contents: { en: `Exness EUR/USD ${price.toFixed(5)} reached your ${direction} target ${target.toFixed(5)}.` },
      url: NEGUS_APP_URL, idempotency_key: key
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) throw new Error(`OneSignal HTTP ${response.status}: ${JSON.stringify(result).slice(0, 250)}`);
  await supabase(`?id=eq.${encodeURIComponent(row.id)}&is_armed=eq.true`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ is_armed: false, last_triggered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  });
  console.log(`PUSH SENT: ${direction} target ${target.toFixed(5)}; Exness EUR/USD ${price.toFixed(5)}; alert disarmed.`);
}

function findTick(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findTick(item, depth + 1); if (found) return found; }
    return null;
  }
  const symbol = String(value.instrument ?? value.symbol ?? value.instrument_name ?? value.name ?? "").toUpperCase();
  const bid = Number(value.bid ?? value.bid_price ?? value.b);
  const ask = Number(value.ask ?? value.ask_price ?? value.a);
  if ((!symbol || symbol === "EURUSD" || symbol === "EUR/USD") && Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid) {
    return { bid, ask, mid: (bid + ask) / 2, symbol: symbol || "EURUSD" };
  }
  for (const key of ["data", "tick", "ticks", "payload", "result", "event", "market_data"]) {
    if (value[key] && typeof value[key] === "object") {
      const found = findTick(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

let stopped = false;
let reconnectDelay = 1000;
let alerts = [];
let lastAlertRefresh = 0;
const pending = new Set();

async function refreshAlerts() {
  alerts = await loadAlerts();
  lastAlertRefresh = Date.now();
  console.log(`Loaded ${alerts.length} armed price alert(s).`);
}
async function handleTick(tick) {
  if (Date.now() - lastAlertRefresh > 5000) {
    try { await refreshAlerts(); } catch (error) { console.error("Alert refresh failed:", error.message); }
  }
  const price = tick.mid;
  for (const row of alerts) {
    const upper = row.upper_price == null ? null : Number(row.upper_price);
    const lower = row.lower_price == null ? null : Number(row.lower_price);
    const direction = upper !== null && Number.isFinite(upper) && price >= upper
      ? "upper"
      : lower !== null && Number.isFinite(lower) && price <= lower ? "lower" : null;
    if (!direction) continue;
    const target = direction === "upper" ? upper : lower;
    const token = String(row.id);
    if (pending.has(token)) continue;
    pending.add(token);
    try {
      await sendAlert(row, direction, target, price);
      alerts = alerts.filter(item => String(item.id) !== token);
    } catch (error) {
      console.error("Price alert delivery failed:", error.message);
    } finally { pending.delete(token); }
  }
}

async function connectLoop() {
  while (!stopped) {
    let socket;
    try {
      const accessPoint = await discoverAccessPoint();
      const path = `/v1/server-events/accounts/${encodeURIComponent(EXN_ACCOUNT_ID)}/ws/ticks`;
      const wsUrl = accessPoint.replace(/^https:/, "wss:") + path;
      console.log("Connecting to Exness EURUSD live tick stream.");
      socket = new WebSocket(wsUrl, { headers: signedHeaders(path), handshakeTimeout: 15000 });
      await new Promise((resolve, reject) => {
        let opened = false;
        const timer = setTimeout(() => reject(new Error("Exness WebSocket connection timed out.")), 20000);
        socket.once("open", () => {
          opened = true; clearTimeout(timer); reconnectDelay = 1000;
          socket.send(JSON.stringify({ id: "negus-eurusd-live-ticks", subscribe: { event: "ticks", instruments: ["EURUSD"] } }));
          console.log("Exness WebSocket connected; EURUSD ticks subscription sent.");
          resolve();
        });
        socket.once("error", error => { clearTimeout(timer); if (!opened) reject(error); });
        socket.once("unexpected-response", (_req, response) => { clearTimeout(timer); reject(new Error(`Exness WebSocket rejected handshake: HTTP ${response.statusCode}`)); });
      });
      await new Promise(resolve => {
        socket.on("message", raw => {
          let message;
          try { message = JSON.parse(raw.toString()); } catch (_) { console.error("Ignored non-JSON Exness tick message."); return; }
          const tick = findTick(message);
          if (!tick) { console.log("Exness message received; no EURUSD Bid/Ask tick found in this payload."); return; }
          handleTick(tick).catch(error => console.error("Tick processing failed:", error.message));
        });
        socket.once("close", (code, reason) => { console.error(`Exness WebSocket closed: ${code} ${reason.toString()}`); resolve(); });
        socket.once("error", error => { console.error("Exness WebSocket error:", error.message); resolve(); });
      });
    } catch (error) {
      console.error("Live tick worker connection error:", error.message);
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    }
    if (!stopped) {
      console.log(`Reconnecting to Exness in ${reconnectDelay}ms.`);
      await new Promise(resolve => setTimeout(resolve, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }
  }
}
process.on("SIGTERM", () => { stopped = true; console.log("SIGTERM received; stopping live tick worker."); });
process.on("SIGINT", () => { stopped = true; console.log("SIGINT received; stopping live tick worker."); });

(async () => {
  await refreshAlerts();
  await connectLoop();
})().catch(error => { console.error("Fatal live tick worker error:", error); process.exit(1); });
