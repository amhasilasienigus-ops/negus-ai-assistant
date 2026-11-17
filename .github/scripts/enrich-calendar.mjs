import fs from "node:fs";
import { execFileSync } from "node:child_process";

const FILE = "calendar.json";
const API = "https://showmytrades.com/api/public/calendar/v1";
const SOURCE = "ShowMyTrades economic calendar";
const SOURCE_URL = "https://showmytrades.com/tools/economic-calendar";

function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFKD")
    .replace(/month\s*[-/]?\s*on\s*[-/]?\s*month|month\s*[-/]?\s*over\s*[-/]?\s*month|m\s*[-/]?\s*m\b/g, " mom ")
    .replace(/year\s*[-/]?\s*on\s*[-/]?\s*year|year\s*[-/]?\s*over\s*[-/]?\s*year|y\s*[-/]?\s*y\b/g, " yoy ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function tokens(value) {
  return new Set(normalize(value).split(/\s+/).filter(word => word.length > 1));
}
function similarity(a, b) {
  const aa = tokens(a), bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let overlap = 0;
  for (const word of aa) if (bb.has(word)) overlap++;
  return overlap / Math.max(aa.size, bb.size);
}
function hasPublishedValue(value) {
  if (value === null || value === undefined) return false;
  const valueText = String(value).trim();
  return valueText !== "" && !["-", "—", "–", "n/a", "na", "null", "none", "pending"].includes(valueText.toLowerCase());
}

const events = JSON.parse(fs.readFileSync(FILE, "utf8"));
if (!Array.isArray(events)) throw new Error("calendar.json must contain an array");

// The workflow downloads a fresh Forex Factory file before this script runs.
// Preserve previously verified Actual values from the last committed calendar,
// because the provider only exposes releases from the last 6 hours. Match by
// currency, release time and title; never carry a result to a different event.
let priorEvents = [];
try {
  priorEvents = JSON.parse(execFileSync("git", ["show", "HEAD:calendar.json"], { encoding: "utf8" }));
  if (!Array.isArray(priorEvents)) priorEvents = [];
} catch {
  priorEvents = [];
}
let archivedActualsRestored = 0;
for (const event of events) {
  if (hasPublishedValue(event.actual ?? event.Actual)) continue;
  const currency = String(event.country || "").toUpperCase();
  const eventTime = Date.parse(event.date);
  if (!["USD", "EUR"].includes(currency) || !Number.isFinite(eventTime)) continue;
  let best = null, bestScore = 0;
  for (const old of priorEvents) {
    if (String(old.country || "").toUpperCase() !== currency || !hasPublishedValue(old.actual)) continue;
    const oldTime = Date.parse(old.date);
    if (!Number.isFinite(oldTime) || Math.abs(oldTime - eventTime) > 2 * 60 * 60 * 1000) continue;
    const score = similarity(event.title, old.title);
    if (score > bestScore) { best = old; bestScore = score; }
  }
  if (best && bestScore >= 0.8) {
    event.actual = String(best.actual).trim();
    event.actualAvailable = true;
    event.actualSource = best.actualSource || "Previously verified calendar result";
    event.actualUpdatedAt = best.actualUpdatedAt || null;
    event.actualSourceUrl = best.actualSourceUrl || null;
    event.actualArchived = true;
    archivedActualsRestored++;
  }
}

// Keep the Forex Factory schedule and its published figures. ShowMyTrades is a
// documented no-key provider for Actual/Forecast/Previous. Its rolling window
// starts only 6 hours in the past (even when days=30); previously captured
// Actual values are now archived above instead of being lost on each refresh.
for (const event of events) {
  const feedActual = event.actual ?? event.Actual;
  if (hasPublishedValue(feedActual)) {
    event.actual = String(feedActual).trim();
    event.actualAvailable = true;
    event.actualSource = event.actualSource || "Forex Factory calendar feed";
  }
}

// The API supports up to 30 days ahead but only a rolling 6-hour lookback.
const url = API + "?currency=EUR,USD&impact=all&days=30";
const response = await fetch(url, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error("ShowMyTrades calendar HTTP " + response.status);
const payload = await response.json();
if (!Array.isArray(payload.events)) throw new Error("ShowMyTrades returned no events array");

const providerEvents = payload.events;
let matched = 0, actualAdded = 0, forecastAdded = 0, previousAdded = 0;
for (const event of events) {
  const currency = String(event.country || "").toUpperCase();
  if (currency !== "USD" && currency !== "EUR") continue;
  const eventTime = Date.parse(event.date);
  if (!Number.isFinite(eventTime)) continue;

  let best = null, bestScore = 0;
  for (const candidate of providerEvents) {
    if (String(candidate.currency || "").toUpperCase() !== currency) continue;
    const candidateTime = Date.parse(candidate.time);
    if (!Number.isFinite(candidateTime) || Math.abs(candidateTime - eventTime) > 2 * 60 * 60 * 1000) continue;
    const score = similarity(event.title, candidate.title);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  if (!best || bestScore < 0.65) continue;
  matched++;

  if (!hasPublishedValue(event.actual) && hasPublishedValue(best.actual)) {
    event.actual = String(best.actual).trim();
    event.actualAvailable = true;
    event.actualSource = SOURCE;
    event.actualUpdatedAt = payload.generated_at || payload.server_time_iso || new Date().toISOString();
    event.actualSourceUrl = SOURCE_URL;
    actualAdded++;
  }
  if (!hasPublishedValue(event.forecast) && hasPublishedValue(best.forecast)) {
    event.forecast = String(best.forecast).trim();
    forecastAdded++;
  }
  if (!hasPublishedValue(event.previous) && hasPublishedValue(best.previous)) {
    event.previous = String(best.previous).trim();
    previousAdded++;
  }
  event.resultsProvider = SOURCE;
  event.resultsMatchConfidence = Number(bestScore.toFixed(2));
  event.resultsSourceUrl = SOURCE_URL;
  event.resultsLastUpdatedAt = payload.generated_at || payload.server_time_iso || null;
  event.resultsProviderConfidence = best.confidence || null;
}

fs.writeFileSync(FILE, JSON.stringify(events, null, 2) + "\n");
console.log("Calendar results enrichment:", {
  source: SOURCE,
  sourceUpdatedAt: payload.generated_at || payload.server_time_iso || null,
  scheduledEvents: events.length,
  providerEvents: providerEvents.length,
  matchedEvents: matched,
  actualResultsAdded: actualAdded,
  archivedActualsRestored,
  forecastValuesAdded: forecastAdded,
  previousValuesAdded: previousAdded,
  lookback: "Provider exposes the latest 6 hours of past events; captured Actual values are preserved in the committed calendar across refreshes.",
  note: "Only published non-empty values were accepted. Missing results remain unavailable; Forecast/Previous are never substituted for Actual."
});
