// NEGUS AI background dual-threshold EUR/USD alert monitor.
// Runs alongside (does not replace) the existing BUY/SELL setup monitor.
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_KEY = process.env.ONESIGNAL_REST_API_KEY;
const APP_URL = "https://amhasilasienigus-ops.github.io/negus-ai-assistant/";
if (!SUPABASE_URL || !SERVICE_KEY || !APP_ID || !ONESIGNAL_KEY) {
  console.log("Background price alerts skipped: required secrets are not fully configured.");
  process.exit(0);
}
async function supabase(url, options = {}) {
  // New sb_secret_* keys are API keys, not JWTs: send only via apikey.
  // Legacy service_role JWTs continue to work with both headers.
  const authHeaders = SERVICE_KEY.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${SERVICE_KEY}` };
  const res = await fetch(url, { ...options, headers: { apikey: SERVICE_KEY, ...authHeaders, "Content-Type": "application/json", ...(options.headers || {}) }, cache: "no-store" });
  const body = await res.text();
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}
const qr = await fetch("https://biquote.io/api/EURUSD", { cache: "no-store" });
if (!qr.ok) throw new Error(`BiQuote HTTP ${qr.status}`);
const q = await qr.json();
const bid = Number(q?.bid), ask = Number(q?.ask), mid = Number(q?.mid);
const price = Number.isFinite(mid) && mid > 0 ? mid : (bid > 0 && ask >= bid ? (bid + ask) / 2 : NaN);
const age = Number(q?.quoteAgeSeconds);
if (!Number.isFinite(price)) throw new Error("No valid EUR/USD quote.");
if (String(q?.marketState || "").toLowerCase() !== "open" || q?.stale !== false || !Number.isFinite(age) || age > 60) {
  console.log("Skipped: market not confirmed open or quote stale/unverified."); process.exit(0);
}
const rows = await supabase(`${SUPABASE_URL}/rest/v1/price_alerts?select=id,onesignal_subscription_id,upper_price,lower_price,is_armed&is_armed=eq.true`);
if (!Array.isArray(rows) || !rows.length) { console.log("No armed background price alerts."); process.exit(0); }
for (const row of rows) {
  const upper = row.upper_price == null ? null : Number(row.upper_price);
  const lower = row.lower_price == null ? null : Number(row.lower_price);
  const hitUpper = upper !== null && Number.isFinite(upper) && price >= upper;
  const hitLower = lower !== null && Number.isFinite(lower) && price <= lower;
  if (!hitUpper && !hitLower) continue;
  const sid = String(row.onesignal_subscription_id || "");
  if (!sid) { console.error(`Alert ${row.id} has no OneSignal subscription ID; left armed.`); continue; }
  const direction = hitUpper ? "upper" : "lower";
  const target = hitUpper ? upper : lower;
  const nr = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST", headers: { Authorization: `Key ${ONESIGNAL_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ app_id: APP_ID, include_subscription_ids: [sid], headings: { en: "NEGUS AI PRICE ALERT" }, contents: { en: `NEGUS AI PRICE ALERT — EUR/USD ${price.toFixed(5)} reached your ${direction} target ${target.toFixed(5)}.` }, url: APP_URL, idempotency_key: `negus-price-${row.id}-${direction}-${target}-${Math.floor(Date.now()/300000)}` })
  });
  const result = await nr.json().catch(() => ({}));
  if (!nr.ok || !result.id) throw new Error(`OneSignal failed for alert ${row.id}: HTTP ${nr.status} ${JSON.stringify(result)}`);
  await supabase(`${SUPABASE_URL}/rest/v1/price_alerts?id=eq.${encodeURIComponent(row.id)}&is_armed=eq.true`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ is_armed: false, last_triggered_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  console.log(`Triggered ${direction} threshold ${target}; EUR/USD ${price}; push ${result.id}`);
}
