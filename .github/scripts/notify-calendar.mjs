import fs from "node:fs";
import crypto from "node:crypto";

const APP_ID = process.env.ONESIGNAL_APP_ID;
const REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const APP_URL = "https://amhasilasienigus-ops.github.io/negus-ai-assistant/";
const STATE_PATH = ".github/state/notification-state.json";

if (!APP_ID || !REST_API_KEY) {
  throw new Error("Missing OneSignal GitHub Actions secrets.");
}

const events = JSON.parse(fs.readFileSync("calendar.json", "utf8"));
if (!Array.isArray(events)) {
  throw new Error("calendar.json must contain an array.");
}

fs.mkdirSync(".github/state", { recursive: true });

let state = { initialized: false, events: {} };

if (fs.existsSync(STATE_PATH)) {
  state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

state.events ??= {};

async function sendPush(message) {
  const response = await fetch(
    "https://api.onesignal.com/notifications?c=push",
    {
      method: "POST",
      headers: {
        Authorization: `Key ${REST_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        app_id: APP_ID,
        included_segments: ["All"],
        headings: { en: "NEGUS AI ASSISTANT" },
        contents: { en: message },
        url: APP_URL,
        idempotency_key: crypto.randomUUID()
      })
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.id) {
    throw new Error(
      `OneSignal error ${response.status}: ${JSON.stringify(result)}`
    );
  }

  if (Number.isFinite(Number(result.recipients)) && Number(result.recipients) <= 0) {
    throw new Error("OneSignal accepted no recipients. Confirm at least one device is subscribed in the OneSignal dashboard.");
  }
  console.log("Push accepted:", result.id, "recipients:", result.recipients ?? "not reported");
}

if (process.env.SEND_TEST_PUSH === "true") {
  await sendPush("TEST: NEGUS AI push notifications are connected on this device.");
  console.log("Manual test push request completed.");
}

const now = Date.now();

const validEvents = events.filter(event =>
  ["USD", "EUR"].includes(String(event.country || "").toUpperCase()) &&
  String(event.impact || "").toLowerCase() === "high" &&
  event.title &&
  event.date &&
  Number.isFinite(Date.parse(event.date))
);

const firstRun = !state.initialized;

for (const event of validEvents) {
  const key = [
    event.country,
    event.date,
    event.title
  ].join("|");

  const isNew = !state.events[key];

  const eventTime = Date.parse(event.date);
  const minutes = (eventTime - now) / 60000;

  const record = state.events[key] || {};

  if (!firstRun && isNew) {
    await sendPush(
      `NEW HIGH-IMPACT ${event.country} EVENT: ${event.title}. Check the calendar before trading.`
    );
  }

  if (minutes > 0 && minutes <= 30 && !record.preAlertSent) {
    await sendPush(
      `NO TRADE: ${event.country} ${event.title} starts in about ${Math.ceil(minutes)} minutes.`
    );
    record.preAlertSent = true;
  }

  if (minutes <= 0 && minutes >= -30 && !record.activeAlertSent) {
    await sendPush(
      `NO TRADE WINDOW ACTIVE: ${event.country} ${event.title}. Wait until 30 minutes after the event.`
    );
    record.activeAlertSent = true;
  }

  if (minutes < -30 && record.activeAlertSent && !record.clearAlertSent) {
    await sendPush(
      `NO TRADE window ended for ${event.country} ${event.title}. Recheck market conditions.`
    );
    record.clearAlertSent = true;
  }

  state.events[key] = record;

  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(state, null, 2) + "\n"
  );
}

state.initialized = true;

for (const [key] of Object.entries(state.events)) {
  const datePart = key.split("|")[1];
  const timestamp = Date.parse(datePart || "");

  if (Number.isFinite(timestamp) && timestamp < now - 7 * 86400000) {
    delete state.events[key];
  }
}

fs.writeFileSync(
  STATE_PATH,
  JSON.stringify(state, null, 2) + "\n"
);

console.log(`Checked ${validEvents.length} high-impact USD/EUR events.`);
