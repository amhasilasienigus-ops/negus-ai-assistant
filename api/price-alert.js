const crypto = require('node:crypto');

const ORIGIN = 'https://amhasilasienigus-ops.github.io';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_PIN = process.env.NEGUS_CHAT_PIN;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
async function db(url, options = {}) {
  const auth = SUPABASE_KEY.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${SUPABASE_KEY}` };
  const response = await fetch(url, {
    ...options,
    headers: { apikey: SUPABASE_KEY, ...auth, 'Content-Type': 'application/json', ...(options.headers || {}) },
    cache: 'no-store'
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${text.slice(0, 250)}`);
  return text ? JSON.parse(text) : null;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['POST', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  if (!SUPABASE_URL || !SUPABASE_KEY || !ACCESS_PIN) return res.status(503).json({ error: 'Backend setup incomplete: set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and NEGUS_CHAT_PIN in Vercel.' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!safeEqual(typeof body.accessPin === 'string' ? body.accessPin : '', ACCESS_PIN)) return res.status(401).json({ error: 'NEGUS AI Access PIN ትክክል አይደለም።' });
  const sid = typeof body.subscriptionId === 'string' ? body.subscriptionId : '';
  if (!/^[A-Za-z0-9-]{20,80}$/.test(sid)) return res.status(400).json({ error: 'Invalid OneSignal subscription ID.' });
  try {
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/price_alerts`;
    if (req.method === 'DELETE') {
      await db(`${url}?id=eq.${encodeURIComponent(sid)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ is_armed: false, updated_at: new Date().toISOString() }) });
      return res.status(200).json({ ok: true });
    }
    const upper = body.above == null || body.above === '' ? null : Number(body.above);
    const lower = body.below == null || body.below === '' ? null : Number(body.below);
    if ((upper === null && lower === null) ||
        (upper !== null && (!Number.isFinite(upper) || upper <= 0 || upper > 10)) ||
        (lower !== null && (!Number.isFinite(lower) || lower <= 0 || lower > 10)) ||
        (upper !== null && lower !== null && upper <= lower)) {
      return res.status(400).json({ error: 'Invalid EUR/USD upper/lower price range.' });
    }
    await db(`${url}?on_conflict=id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: sid, onesignal_subscription_id: sid, upper_price: upper, lower_price: lower, is_armed: true, updated_at: new Date().toISOString(), last_triggered_at: null })
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('NEGUS price-alert API error:', error);
    return res.status(500).json({ error: 'Could not save the background price alert.', diagnostic: String(error && error.message || 'Unknown database error').slice(0, 350) });
  }
};
