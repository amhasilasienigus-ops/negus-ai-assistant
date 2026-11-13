import fs from "node:fs";
import crypto from "node:crypto";

const APP_ID = process.env.ONESIGNAL_APP_ID;
const REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const APP_URL = "https://amhasilasienigus-ops.github.io/negus-ai-assistant/";
const STATE_PATH = ".github/state/entry-monitor-state.json";
const API = "https://biquote.io/api";
const TIMEFRAMES = [["D1","1d"],["H4","4h"],["H1","1h"],["M15","15m"],["M5","5m"]];
const MAX_QUOTE_AGE_SECONDS = 60;
const MAX_SPREAD_PIPS = 1.5;
const NEWS_BLOCK_MS = 30 * 60 * 1000;

if (!APP_ID || !REST_API_KEY) throw new Error("Missing OneSignal GitHub Actions secrets.");

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function sendPush(message) {
  const response = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST",
    headers: {
      Authorization: `Key ${REST_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      app_id: APP_ID,
      included_segments: ["All"],
      headings: { en: "NEGUS AI · EUR/USD SETUP" },
      contents: { en: message },
      url: APP_URL,
      idempotency_key: crypto.randomUUID()
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) throw new Error(`OneSignal error ${response.status}: ${JSON.stringify(result)}`);
  if (Number.isFinite(Number(result.recipients)) && Number(result.recipients) <= 0) {
    throw new Error("OneSignal accepted zero recipients. Check device subscription.");
  }
  console.log("Push accepted:", result.id, "recipients:", result.recipients ?? "not reported");
  return result;
}

function candleTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null;
}

function normalizeCandle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const time = candleTime(raw.openTime ?? raw.open_time ?? raw.time ?? raw.timestamp ?? raw.t ?? raw.date ?? raw.datetime);
  const open = Number(raw.open ?? raw.o), high = Number(raw.high ?? raw.h);
  const low = Number(raw.low ?? raw.l), close = Number(raw.close ?? raw.c);
  if (!time || ![open, high, low, close].every(Number.isFinite) || Math.min(open, high, low, close) <= 0) return null;
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  return { time, open, high, low, close, isOpen: raw.isOpen === true || raw.is_open === true };
}

function extractCandles(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["bars", "candles", "data", "result", "ohlc"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      for (const nested of ["bars", "candles", "data", "ohlc"]) if (Array.isArray(value[nested])) return value[nested];
    }
  }
  return [];
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gain += delta; else loss -= delta;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(bars, period = 14) {
  if (bars.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i], prev = bars[i - 1];
    ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)));
  }
  if (ranges.length < period) return null;
  let value = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
  return value;
}

function inspectFrame(payload) {
  const unique = new Map();
  for (const raw of extractCandles(payload)) {
    const candle = normalizeCandle(raw);
    if (candle && !candle.isOpen) unique.set(candle.time, candle);
  }
  const bars = [...unique.values()].sort((a, b) => a.time - b.time);
  if (bars.length < 30) throw new Error(`Only ${bars.length} valid closed candles`);
  const closes = bars.map(b => b.close), last = bars.at(-1), prev = bars.at(-2);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  let trend = "NEUTRAL";
  if (e20 !== null && e50 !== null) {
    if (last.close > e20 && e20 > e50) trend = "BULLISH";
    else if (last.close < e20 && e20 < e50) trend = "BEARISH";
  }
  return { bars, last, prev, trend, rsi: rsi(closes), atr: atr(bars) };
}

function swingPoints(bars, left = 2, right = 2) {
  const highs = [], lows = [];
  for (let i = left; i < bars.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) highs.push({ price: bars[i].high, index: i });
    if (isLow) lows.push({ price: bars[i].low, index: i });
  }
  return { highs, lows };
}

function analyzeStructure(frame) {
  const bars = frame.bars, swings = swingPoints(bars, 2, 2), last = bars.at(-1);
  const priorHigh = swings.highs.filter(x => x.index < bars.length - 1).at(-1);
  const priorLow = swings.lows.filter(x => x.index < bars.length - 1).at(-1);
  const displacement = frame.atr > 0 && Math.abs(last.close - last.open) >= frame.atr * 0.65;
  const bullishSweep = !!priorLow && last.low < priorLow.price && last.close > priorLow.price;
  const bearishSweep = !!priorHigh && last.high > priorHigh.price && last.close < priorHigh.price;
  const bullishBOS = !!priorHigh && last.close > priorHigh.price;
  const bearishBOS = !!priorLow && last.close < priorLow.price;
  const prior = bars.slice(-9, -1);
  let priorTrend = "UNKNOWN";
  if (prior.length >= 6) {
    if (prior.at(-1).close > prior[0].close) priorTrend = "BULLISH";
    else if (prior.at(-1).close < prior[0].close) priorTrend = "BEARISH";
  }
  const bullishChoch = priorTrend === "BEARISH" && bullishBOS;
  const bearishChoch = priorTrend === "BULLISH" && bearishBOS;
  return {
    displacement,
    bullish: (bullishBOS || bullishChoch || bullishSweep) && displacement,
    bearish: (bearishBOS || bearishChoch || bearishSweep) && displacement,
    tags: [bullishBOS ? "BOS↑" : "", bearishBOS ? "BOS↓" : "", bullishChoch ? "CHoCH↑" : "",
      bearishChoch ? "CHoCH↓" : "", bullishSweep ? "Liquidity sweep↑" : "",
      bearishSweep ? "Liquidity sweep↓" : "", displacement ? "Displacement" : ""].filter(Boolean)
  };
}

function analyzeEntry(frame, price) {
  const bars = frame.bars, last = bars.at(-1), prev = bars.at(-2);
  const direction = last.close > last.open ? "BULLISH" : last.close < last.open ? "BEARISH" : "NEUTRAL";
  let fvg = null;
  for (let i = bars.length - 2; i >= 2 && i >= bars.length - 12; i--) {
    const a = bars[i - 2], c = bars[i];
    if (c.low > a.high) { fvg = { side: "BULLISH", low: a.high, high: c.low }; break; }
    if (c.high < a.low) { fvg = { side: "BEARISH", low: c.high, high: a.low }; break; }
  }
  if (fvg) fvg.retest = price >= fvg.low && price <= fvg.high;
  let ob = null;
  for (let i = bars.length - 2; i >= Math.max(1, bars.length - 8); i--) {
    const impulse = bars[i + 1], candidate = bars[i];
    if (impulse.close > impulse.open && candidate.close < candidate.open) {
      ob = { side: "BULLISH", low: candidate.low, high: candidate.open }; break;
    }
    if (impulse.close < impulse.open && candidate.close > candidate.open) {
      ob = { side: "BEARISH", low: candidate.open, high: candidate.high }; break;
    }
  }
  if (ob) ob.retest = price >= ob.low && price <= ob.high;
  return {
    bullish: (fvg?.side === "BULLISH" && fvg.retest) || (ob?.side === "BULLISH" && ob.retest) ||
      (direction === "BULLISH" && last.close > prev.high),
    bearish: (fvg?.side === "BEARISH" && fvg.retest) || (ob?.side === "BEARISH" && ob.retest) ||
      (direction === "BEARISH" && last.close < prev.low),
    tags: [fvg?.retest ? "FVG retest" : "", ob?.retest ? "OB retest" : "",
      direction === "BULLISH" && last.close > prev.high ? "Bullish PA break" : "",
      direction === "BEARISH" && last.close < prev.low ? "Bearish PA break" : ""].filter(Boolean)
  };
}

async function loadCalendar() {
  const data = await fetchJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json", 20000);
  if (!Array.isArray(data) || !data.length) throw new Error("Economic calendar feed empty or invalid");
  const now = Date.now();
  const events = data.filter(e =>
    ["USD", "EUR"].includes(String(e.country || "").toUpperCase()) &&
    String(e.impact || "").toLowerCase() === "high" && e.title && Number.isFinite(Date.parse(e.date))
  );
  if (!events.length) throw new Error("No valid high-impact USD/EUR events in calendar feed");
  const blocked = events.find(e => Math.abs(Date.parse(e.date) - now) <= NEWS_BLOCK_MS);
  if (blocked) throw new Error(`High-impact news block: ${blocked.country} ${blocked.title} at ${blocked.date}`);
  return events;
}

function eatTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Addis_Ababa", dateStyle: "medium", timeStyle: "short"
  }).format(date);
}

if (process.env.SEND_TEST_PUSH === "true") {
  await sendPush("TEST: NEGUS AI background EUR/USD setup monitor is connected. This is a test, not a trade signal.");
}

const [quote, calendarEvents] = await Promise.all([
  fetchJson(API + "/EURUSD", 15000),
  loadCalendar()
]);
if (!quote || typeof quote !== "object") throw new Error("Invalid EUR/USD quote response.");
const bid = Number(quote.bid), ask = Number(quote.ask);
const mid = Number(quote.mid);
const price = Number.isFinite(mid) && mid > 0 ? mid : (bid > 0 && ask > 0 ? (bid + ask) / 2 : NaN);
const spread = bid > 0 && ask >= bid ? (ask - bid) * 10000 : Number(quote.spread) * 10000;
const age = Number(quote.quoteAgeSeconds);
if (!Number.isFinite(price)) throw new Error("Live EUR/USD quote unavailable.");
if (String(quote.marketState || "").toLowerCase() !== "open") throw new Error("Market is not confirmed open.");
if (quote.stale !== false || !Number.isFinite(age) || age > MAX_QUOTE_AGE_SECONDS) throw new Error("Quote is stale or freshness is unverified.");
if (!Number.isFinite(spread) || spread < 0 || spread > MAX_SPREAD_PIPS) throw new Error(`Spread is unavailable or too high: ${spread}`);

const frames = {};
for (let i = 0; i < TIMEFRAMES.length; i += 3) {
  const batch = TIMEFRAMES.slice(i, i + 3).map(async ([name, interval]) => {
    const data = await fetchJson(API + "/EURUSD/ohlc?interval=" + interval + "&limit=250", 35000);
    frames[name] = inspectFrame(data);
  });
  await Promise.all(batch);
}

const [d1, h4, h1, m15, m5] = ["D1", "H4", "H1", "M15", "M5"].map(tf => frames[tf]);
const allBull = d1.trend === "BULLISH" && h4.trend === "BULLISH" && h1.trend === "BULLISH";
const allBear = d1.trend === "BEARISH" && h4.trend === "BEARISH" && h1.trend === "BEARISH";
const m15Bull = m15.trend === "BULLISH" && m15.rsi >= 50 && m15.rsi < 75;
const m15Bear = m15.trend === "BEARISH" && m15.rsi <= 50 && m15.rsi > 25;
const m5Bull = m5.trend === "BULLISH" && m5.last.close > m5.prev.close && m5.rsi >= 50 && m5.rsi < 80;
const m5Bear = m5.trend === "BEARISH" && m5.last.close < m5.prev.close && m5.rsi <= 50 && m5.rsi > 20;
const structure = analyzeStructure(m15);
const entry = analyzeEntry(m5, price);
let direction = null;
if (allBull && m15Bull && m5Bull && structure.bullish && entry.bullish) direction = "BUY";
if (allBear && m15Bear && m5Bear && structure.bearish && entry.bearish) direction = "SELL";

const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8"))
  : { lastSignalKey: null, lastSignalAt: null };
if (process.env.SEND_TEST_PUSH === "true") console.log("Manual monitor test push sent.");

if (!direction) {
  console.log("No qualified setup. No setup notification sent.", {
    trends: { D1: d1.trend, H4: h4.trend, H1: h1.trend, M15: m15.trend, M5: m5.trend },
    rsi: { M15: m15.rsi, M5: m5.rsi }, structure: structure.tags, entry: entry.tags
  });
} else {
  const m5ClosedTime = m5.last.time;
  const signalKey = [direction, m5ClosedTime, structure.tags.join(","), entry.tags.join(",")].join("|");
  const lastAlertMs = Date.parse(state.lastSignalAt || "");
  const sameDirectionCooldown = state.lastSignalDirection === direction &&
    Number.isFinite(lastAlertMs) && Date.now() - lastAlertMs < 30 * 60 * 1000;
  if (state.lastSignalKey === signalKey || sameDirectionCooldown) {
    console.log("Qualified setup alert suppressed: duplicate candle or same-direction 30-minute cooldown.");
  } else {
    const directionLabel = direction === "BUY" ? "BUY candidate" : "SELL candidate";
    const message = `${directionLabel} · EUR/USD near ${price.toFixed(5)} · Spread ${spread.toFixed(2)} pips · D1/H4/H1 + M15/M5 rules aligned. M15: ${structure.tags.join(", ")}. M5: ${entry.tags.join(", ")}. Check NEGUS AI for the latest chart, daily loss limit and Exness price before deciding. NOT an order or guarantee.`;
    await sendPush(message);
    state.lastSignalKey = signalKey;
    state.lastSignalAt = new Date().toISOString();
    state.lastSignalDirection = direction;
    state.lastSignalPrice = price;
    state.lastM5ClosedCandle = new Date(m5ClosedTime * 1000).toISOString();
    fs.mkdirSync(".github/state", { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    console.log("Qualified setup alert sent:", signalKey);
  }
}

console.log("Background monitor completed. Market feed is BiQuote, not Exness MT5; no order was placed.");
