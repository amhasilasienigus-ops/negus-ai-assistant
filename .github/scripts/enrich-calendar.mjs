import fs from "node:fs";

const FILE = "calendar.json";
const API = "https://api.tradingeconomics.com/calendar/country";
const KEY = "guest:guest";
const DAY = 86400000;
const now = new Date();
const from = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
const to = new Date(now.getTime() + 8 * DAY).toISOString().slice(0, 10);
const countryNames = { USD: ["united states"], EUR: ["euro area", "germany", "france"] };

function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFKD")
    .replace(/month\s*[-/]?\s*on\s*[-/]?\s*month|month\s*[-/]?\s*over\s*[-/]?\s*month|m\s*[-/]?\s*m\b/g, " mom ")
    .replace(/year\s*[-/]?\s*on\s*[-/]?\s*year|year\s*[-/]?\s*over\s*[-/]?\s*year|y\s*[-/]?\s*y\b/g, " yoy ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function tokens(value) {
  return new Set(normalize(value).split(/\s+/).filter(word => word.length > 1));
}
function hasPublishedValue(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  return text !== "" && !["-", "—", "–", "n/a", "na", "null", "none", "pending"].includes(text.toLowerCase());
}
function similarity(a, b) {
  const aa = tokens(a), bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const word of aa) if (bb.has(word)) overlap++;
  return overlap / Math.max(aa.size, bb.size);
}
async function fetchCountry(country) {
  const url = API + "/" + encodeURIComponent(country) + "/" + from + "/" + to + "?c=" + encodeURIComponent(KEY) + "&f=json";
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Trading Economics " + country + " HTTP " + response.status);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Trading Economics " + country + " returned a non-array payload");
  return data;
}

const events = JSON.parse(fs.readFileSync(FILE, "utf8"));
if (!Array.isArray(events)) throw new Error("calendar.json must contain an array");
const countries = [...new Set(Object.values(countryNames).flat())];
const settled = await Promise.allSettled(countries.map(fetchCountry));
const teEvents = [];
settled.forEach((result, index) => {
  if (result.status === "fulfilled") teEvents.push(...result.value);
  else console.warn("Actual-results enrichment unavailable for", countries[index] + ":", result.reason.message);
});

let matched = 0, actualUpdated = 0;
for (const event of events) {
  const currency = String(event.country || "").toUpperCase();
  if (!countryNames[currency]) continue;
  const eventTime = Date.parse(event.date);
  if (!Number.isFinite(eventTime)) continue;
  let best = null, bestScore = 0;
  for (const candidate of teEvents) {
    const candidateTime = Date.parse(candidate.Date || candidate.date || "");
    if (!Number.isFinite(candidateTime) || Math.abs(candidateTime - eventTime) > 2 * 60 * 60 * 1000) continue;
    const candidateCountry = normalize(candidate.Country || candidate.country);
    if (!countryNames[currency].some(name => candidateCountry === name || candidateCountry.includes(name))) continue;
    const score = similarity(event.title, candidate.Event || candidate.Category || candidate.event || candidate.category);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  if (!best || bestScore < 0.70) continue;
  matched++;
  const actual = best.Actual ?? best.actual, forecast = best.Forecast ?? best.forecast, previous = best.Previous ?? best.previous;
  if (hasPublishedValue(actual)) {
    event.actual = String(actual).trim();
    event.actualAvailable = true;
    event.actualSource = "Trading Economics";
    event.actualUpdatedAt = best.LastUpdate || best.lastUpdate || new Date().toISOString();
    actualUpdated++;
  }
  if ((!hasPublishedValue(event.forecast)) && hasPublishedValue(forecast)) event.forecast = String(forecast).trim();
  if ((!hasPublishedValue(event.previous)) && hasPublishedValue(previous)) event.previous = String(previous).trim();
  event.resultsProvider = "Trading Economics";
  event.resultsMatchConfidence = Number(bestScore.toFixed(2));
  event.resultsSourceUrl = best.SourceURL || best.sourceURL || "https://tradingeconomics.com/calendar";
  event.resultsLastUpdatedAt = best.LastUpdate || best.lastUpdate || null;
}
fs.writeFileSync(FILE, JSON.stringify(events, null, 2) + "\n");
console.log("Trading Economics enrichment complete:", { scheduledEvents: events.length, matchedEvents: matched, actualResultsAdded: actualUpdated, providerEvents: teEvents.length, note: "Only non-empty Actual values were copied; unmatched events remain unchanged." });
