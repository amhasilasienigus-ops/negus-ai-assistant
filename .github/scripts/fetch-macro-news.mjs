import fs from "node:fs";

const OUTPUT = "news.json";
const LOOKBACK_DAYS = 14;
const MAX_ITEMS = 100;
const SOURCES = [
  { name: "Federal Reserve", currency: "USD", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { name: "Federal Reserve Monetary Policy", currency: "USD", url: "https://www.federalreserve.gov/feeds/press_monetary.xml" },
  { name: "Bureau of Labor Statistics", currency: "USD", url: "https://www.bls.gov/feed/bls_latest.rss" },
  { name: "European Central Bank", currency: "EUR", url: "https://www.ecb.europa.eu/rss/press.html" },
  { name: "Eurostat", currency: "EUR", url: "https://ec.europa.eu/eurostat/cache/RSS/rss_estat_news.xml" }
];

const MACRO = /inflation|consumer price|producer price|employment|unemployment|payroll|nonfarm|wage|gross domestic|\bgdp\b|retail sales|industrial production|interest rate|monetary policy|federal funds|fomc|ecb|deposit facility|refinancing|pce|cpi|hicp|ppi|labor market|labour market|job openings|trade balance|current account|business confidence|economic outlook|growth|recession|prices|productivity|claims|consumer spending|personal income/i;

function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const re = new RegExp("<(?:[\\w-]+:)?" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?" + name + "\\s*>", "i");
  return decodeXml(block.match(re)?.[1] || "");
}

function parseItems(xml, source) {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi)].map(m => m[2]);
  return blocks.map(block => {
    const title = tag(block, "title");
    const description = tag(block, "description") || tag(block, "summary") || tag(block, "content");
    const rawLink = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] || tag(block, "link");
    const published = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "date");
    const timestamp = Date.parse(published);
    const guid = tag(block, "guid") || tag(block, "id") || rawLink || title;
    if (!title || !Number.isFinite(timestamp) || !rawLink) return null;
    let url;
    try { url = new URL(rawLink, source.url).href; } catch { return null; }
    if (!/^https?:$/.test(new URL(url).protocol)) return null;
    return {
      id: source.currency + ":" + Buffer.from(guid).toString("base64url").slice(0, 80),
      currency: source.currency,
      source: source.name,
      title: title.slice(0, 300),
      summary: description.slice(0, 1200),
      url,
      publishedAt: new Date(timestamp).toISOString()
    };
  }).filter(Boolean);
}

const now = Date.now();
const cutoff = now - LOOKBACK_DAYS * 86400000;
const settled = await Promise.allSettled(SOURCES.map(async source => {
  const response = await fetch(source.url, {
    headers: { "User-Agent": "NEGUS-AI-News-Monitor/1.0 (+https://github.com/amhasilasienigus-ops/negus-ai-assistant)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const xml = await response.text();
  if (!xml || !/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error("Invalid RSS/Atom XML");
  return { source, items: parseItems(xml, source) };
}));

const sourceStatus = [];
const all = [];
for (let i = 0; i < settled.length; i++) {
  const result = settled[i];
  const source = SOURCES[i];
  if (result.status === "fulfilled") {
    const fresh = result.value.items.filter(item => {
      const t = Date.parse(item.publishedAt);
      return t >= cutoff && t <= now + 5 * 60000 && MACRO.test(item.title + " " + item.summary);
    });
    all.push(...fresh);
    sourceStatus.push({ name: source.name, currency: source.currency, status: "ok", itemsFound: result.value.items.length, relevantItems: fresh.length });
  } else {
    sourceStatus.push({ name: source.name, currency: source.currency, status: "error", error: String(result.reason?.message || result.reason).slice(0, 180) });
  }
}

const unique = new Map();
for (const item of all.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))) {
  if (!unique.has(item.id)) unique.set(item.id, item);
}
const items = [...unique.values()].slice(0, MAX_ITEMS);
const successfulSources = sourceStatus.filter(x => x.status === "ok").length;
const output = {
  schemaVersion: 1,
  generatedAt: new Date(now).toISOString(),
  status: successfulSources ? (successfulSources === SOURCES.length ? "loaded" : "partial") : "unavailable",
  sourceCount: SOURCES.length,
  successfulSourceCount: successfulSources,
  lookbackDays: LOOKBACK_DAYS,
  items,
  sources: sourceStatus,
  limitation: "Public official RSS/Atom announcements, not a complete live newswire or structured economic-results API. Headlines and summaries do not provide verified Actual/Forecast/Previous values or prove EUR/USD price reaction. Publication timing depends on each publisher's feed."
};

fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");
console.log("Saved " + items.length + " relevant macro news items; " + successfulSources + "/" + SOURCES.length + " feeds available.");
if (!successfulSources) process.exitCode = 1;
