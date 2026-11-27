# NEGUS AI — Exness live price worker

This directory contains a persistent, read-only Exness EUR/USD tick listener. It is designed to run as a **Render Background Worker**, not as a Vercel serverless function or a browser tab.

## Why a separate worker is required

The Exness API sends live Bid/Ask ticks over its authenticated WebSocket endpoint. A Vercel request handler and a GitHub Actions cron job are not persistent WebSocket processes. This worker keeps the signed WebSocket connection open, reconnects with backoff, reads the armed alert rows from Supabase, and sends OneSignal pushes when the EUR/USD midpoint reaches an armed threshold.

The existing Vercel Exness account endpoint, web dashboard, OneSignal setup, Supabase schema, and BUY/SELL GitHub monitor are not replaced.

## Deploy

1. In Render, create a new **Blueprint** from this GitHub repository and select the `render.yaml` file.
2. Render will detect the `negus-exness-live-price` Background Worker. The Blueprint uses the paid Starter worker plan; review the price before creating it.
3. Add the environment variables requested by the Blueprint. Copy their values privately from the existing Vercel Production environment or the original secure source. **Never paste API keys or private keys into GitHub, this README, or a chat.**

Required environment variables:

- `EXN_API_KEY`
- `EXN_PRIVATE_KEY`
- `EXN_ACCOUNT_ID`
- `EXN_DISCOVERY_BASE_URL` (the HTTPS Gateway host copied from the Exness Key Management DNS widget, not an account access-point hostname)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ONESIGNAL_APP_ID`
- `ONESIGNAL_REST_API_KEY`

The Exness key must have permission to read live ticks for the selected account. Keep it read-only. This worker contains no trade placement or modification code.

## Verify before relying on it

In the Render worker logs, confirm all of these messages:

- `Loaded N armed price alert(s).`
- `Exness WebSocket connected; EURUSD ticks subscription sent.`
- Then live EUR/USD tick messages should be processed; a threshold crossing should produce `PUSH SENT`.

If the worker reports that it receives messages but cannot find a EUR/USD Bid/Ask tick, inspect the sanitized log and confirm the exact Exness instrument identifier and tick payload shape before enabling it for live alerts.

**Do not disable the existing five-minute GitHub Actions price-alert step until the Render worker has been deployed and a real push has been verified.** Once verified, remove only that price-alert step to avoid duplicate alerts; keep the separate BUY/SELL setup monitor.

## Behavior and limits

- Tick updates from Exness may be throttled up to 500 ms.
- Push delivery time also depends on OneSignal, Android notification settings, network connectivity, and device power management. This is near-real-time, not a guaranteed zero-latency alert.
- The worker refreshes armed alert rows from Supabase every few seconds and disarms an alert after a successful push.
- If the worker stops, it cannot monitor prices until Render restarts it.
