const ALLOWED_ORIGIN = "https://amhasilasienigus-ops.github.io";
const CACHE_MS = 60_000;
const FX_MAX_AGE_MS = 60 * 60 * 1000;
const YIELD_MAX_AGE_MS = 36 * 60 * 60 * 1000;
let cache = null;
let cacheAt = 0;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

async function fetchYahoo(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) + "?range=5d&interval=5m&includePrePost=false";
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 NEGUS-AI-Fundamental-Module/1.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(12000),
    cache: "no-store"
  });
  if (!response.ok) throw new Error(symbol + " HTTP " + response.status);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(symbol + " returned no chart result");
  const times = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  let latest = null;
  for (let i = Math.min(times.length, closes.length) - 1; i >= 0; i--) {
    const close = Number(closes[i]);
    if (Number.isFinite(close) && close > 0 && Number.isFinite(Number(times[i]))) {
      latest = { price: close, timestamp: Number(times[i]) * 1000 };
      break;
    }
  }
  if (!latest) throw new Error(symbol + " has no valid close");
  const previousClose = Number(result.meta?.chartPreviousClose ?? result.meta?.previousClose);
  const pctChange = Number.isFinite(previousClose) && previousClose > 0
    ? ((latest.price - previousClose) / previousClose) * 100
    : null;
  return {
    symbol,
    price: latest.price,
    previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
    pctChange: Number.isFinite(pctChange) ? pctChange : null,
    timestamp: new Date(latest.timestamp).toISOString(),
    ageSeconds: Math.max(0, Math.round((Date.now() - latest.timestamp) / 1000)),
    source: "Yahoo Finance chart"
  };
}

function strengthScore(rows, currency) {
  const contributions = [];
  for (const row of rows) {
    if (!row.data || !Number.isFinite(row.data.pctChange)) continue;
    if (row.base !== currency && row.quote !== currency) continue;
    contributions.push(row.base === currency ? row.data.pctChange : -row.data.pctChange);
  }
  const score = contributions.length
    ? contributions.reduce((sum, value) => sum + value, 0) / contributions.length
    : null;
  return {
    scorePct: Number.isFinite(score) ? Number(score.toFixed(3)) : null,
    pairsUsed: contributions.length,
    status: contributions.length >= 4 ? "available" : "insufficient",
    label: !Number.isFinite(score) ? "UNAVAILABLE" :
      score > 0.10 ? "STRONGER" : score < -0.10 ? "WEAKER" : "NEUTRAL"
  };
}

async function buildSnapshot() {
  const definitions = [
    ["EURUSD=X", "EUR", "USD"], ["EURGBP=X", "EUR", "GBP"],
    ["EURJPY=X", "EUR", "JPY"], ["EURCHF=X", "EUR", "CHF"],
    ["EURAUD=X", "EUR", "AUD"], ["EURCAD=X", "EUR", "CAD"],
    ["EURNZD=X", "EUR", "NZD"], ["EURSEK=X", "EUR", "SEK"],
    ["USDJPY=X", "USD", "JPY"], ["USDCHF=X", "USD", "CHF"],
    ["USDCAD=X", "USD", "CAD"], ["GBPUSD=X", "GBP", "USD"],
    ["AUDUSD=X", "AUD", "USD"], ["NZDUSD=X", "NZD", "USD"],
    ["USDNOK=X", "USD", "NOK"]
  ];
  const settled = await Promise.allSettled(definitions.map(async ([symbol, base, quote]) => ({
    symbol, base, quote, data: await fetchYahoo(symbol)
  })));
  const rows = settled.map((item, i) => item.status === "fulfilled"
    ? item.value
    : ({ symbol: definitions[i][0], base: definitions[i][1], quote: definitions[i][2], error: String(item.reason?.message || item.reason) }));
  const eur = strengthScore(rows, "EUR");
  const usd = strengthScore(rows, "USD");

  const [dxyResult, fiveYearResult, tenYearResult] = await Promise.allSettled([
    fetchYahoo("DX-Y.NYB"),
    fetchYahoo("^FVX"),
    fetchYahoo("^TNX")
  ]);
  const dxy = dxyResult.status === "fulfilled" ? dxyResult.value : null;
  const fiveYearRaw = fiveYearResult.status === "fulfilled" ? fiveYearResult.value : null;
  const tenYearRaw = tenYearResult.status === "fulfilled" ? tenYearResult.value : null;
  const toYield = raw => raw ? ({
    symbol: raw.symbol,
    percent: Number((raw.price / 10).toFixed(3)),
    changeBasisPoints: Number.isFinite(raw.pctChange) && raw.previousClose
      ? Number(((raw.price - raw.previousClose) / 10 * 100).toFixed(1)) : null,
    timestamp: raw.timestamp,
    ageSeconds: raw.ageSeconds,
    source: raw.source
  }) : null;
  const fiveYear = toYield(fiveYearRaw), tenYear = toYield(tenYearRaw);

  const dxyFresh = dxy && dxy.ageSeconds <= FX_MAX_AGE_MS / 1000;
  const yieldsFresh = tenYear && tenYear.ageSeconds <= YIELD_MAX_AGE_MS / 1000;
  const strengthFresh = rows.filter(r => r.data && r.data.ageSeconds <= FX_MAX_AGE_MS / 1000);
  const eurFresh = strengthScore(strengthFresh, "EUR");
  const usdFresh = strengthScore(strengthFresh, "USD");
  const complete = eurFresh.status === "available" && usdFresh.status === "available" && dxyFresh && yieldsFresh;
  const differential = Number.isFinite(eurFresh.scorePct) && Number.isFinite(usdFresh.scorePct)
    ? Number((eurFresh.scorePct - usdFresh.scorePct).toFixed(3)) : null;
  const strengthBias = !Number.isFinite(differential) ? "WAIT" :
    differential > 0.10 ? "BULLISH_EURUSD" :
    differential < -0.10 ? "BEARISH_EURUSD" : "NEUTRAL";
  const dxyBias = !dxyFresh || !Number.isFinite(dxy.pctChange) ? null :
    dxy.pctChange > 0.10 ? "BEARISH_EURUSD" :
    dxy.pctChange < -0.10 ? "BULLISH_EURUSD" : "NEUTRAL";
  const dxyConflicts = strengthBias !== "WAIT" && strengthBias !== "NEUTRAL" &&
    dxyBias !== null && dxyBias !== "NEUTRAL" && dxyBias !== strengthBias;
  const bias = !complete ? "WAIT" : dxyConflicts ? "MIXED" : strengthBias;

  return {
    status: complete ? "verified_inputs" : "incomplete",
    generatedAt: new Date().toISOString(),
    provider: "Yahoo Finance public chart feed",
    currencyStrength: {
      EUR: eurFresh,
      USD: usdFresh,
      eurUsdDifferentialPct: differential,
      methodology: "Equal-weight average of percentage changes across available EUR and USD major-currency crosses; quote-currency changes are inverted."
    },
    dxy: dxy ? { ...dxy, fresh: Boolean(dxyFresh) } : { status: "unavailable", error: dxyResult.reason?.message || "DXY feed unavailable" },
    treasuryYields: {
      fiveYear: fiveYear ? { ...fiveYear, fresh: fiveYear.ageSeconds <= YIELD_MAX_AGE_MS / 1000 } : { status: "unavailable" },
      tenYear: tenYear ? { ...tenYear, fresh: Boolean(yieldsFresh) } : { status: "unavailable" }
    },
    fundamentalBias: bias,
    biasEvidence: { strengthBias, dxyBias, dxyConflicts, yieldContext: Number.isFinite(tenYear?.changeBasisPoints) ? (tenYear.changeBasisPoints > 0 ? "US nominal 10Y yield rising" : tenYear.changeBasisPoints < 0 ? "US nominal 10Y yield falling" : "US nominal 10Y yield unchanged") : "US 10Y yield change unavailable" },
    dataQuality: {
      requiredInputsComplete: complete,
      fxFreshnessLimitSeconds: FX_MAX_AGE_MS / 1000,
      yieldFreshnessLimitSeconds: YIELD_MAX_AGE_MS / 1000,
      successfulFxPairs: strengthFresh.length,
      failedSymbols: rows.filter(r => r.error).map(r => ({ symbol: r.symbol, error: r.error })),
      limitation: "Public market-data feed may be delayed or unavailable. DXY and nominal Treasury yields are context, not standalone trade signals. No trade decision is valid unless the live EUR/USD quote, closed candles, calendar and Risk Guard are also verified."
    }
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (cache && Date.now() - cacheAt < CACHE_MS) {
      return res.status(200).json({ ...cache, cached: true });
    }
    const snapshot = await buildSnapshot();
    cache = snapshot;
    cacheAt = Date.now();
    return res.status(200).json({ ...snapshot, cached: false });
  } catch (error) {
    console.error("NEGUS fundamental data error:", error);
    return res.status(502).json({
      status: "unavailable",
      fundamentalBias: "WAIT",
      generatedAt: new Date().toISOString(),
      error: "Fundamental market data could not be verified.",
      detail: String(error?.message || error).slice(0, 240)
    });
  }
}
