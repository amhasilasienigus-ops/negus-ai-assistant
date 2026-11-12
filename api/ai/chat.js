
// NEGUS AI V13 — Gemini API backend
// Environment variables:
// OPENAI_API_KEY = Gemini API key (existing Vercel variable name)
// NEGUS_CHAT_PIN = private NEGUS access PIN

import crypto from 'node:crypto';

const ALLOWED_ORIGIN = 'https://amhasilasienigus-ops.github.io';
const MODEL = 'gemini-2.5-flash-lite';
const MAX_IMAGE_CHARS = 4_200_000;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_HISTORY_TURNS = 6;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

// Keep conversation history in a signed token.
// This preserves follow-up chat without changing index.html.
function signHistory(history, secret) {
  const payload = Buffer.from(JSON.stringify(history)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  return `ctx_${payload}.${signature}`;
}

function readHistory(token, secret) {
  try {
    if (typeof token !== 'string' || token.length > 100000) return [];

    const value = token.startsWith('ctx_') ? token.slice(4) : '';
    const parts = value.split('.');
    if (parts.length !== 2) return [];

    const [payload, signature] = parts;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64url');

    if (!safeEqual(signature, expected)) return [];

    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(item =>
        item &&
        typeof item.user === 'string' &&
        typeof item.assistant === 'string'
      )
      .slice(-MAX_HISTORY_TURNS)
      .map(item => ({
        user: item.user.slice(0, 8000),
        assistant: item.assistant.slice(0, 12000)
      }));
  } catch {
    return [];
  }
}

function getReply(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(part => typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const expectedPin = process.env.NEGUS_CHAT_PIN;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!expectedPin || !apiKey) {
    return res.status(503).json({
      error: 'Backend setup incomplete. Check OPENAI_API_KEY and NEGUS_CHAT_PIN in Vercel.'
    });
  }

  try {
    const body = req.body && typeof req.body === 'object'
      ? req.body
      : {};

    const suppliedPin = typeof body.accessPin === 'string'
      ? body.accessPin
      : '';

    if (!safeEqual(suppliedPin, expectedPin)) {
      return res.status(401).json({
        error: 'Access PIN ትክክል አይደለም።'
      });
    }

    const message = typeof body.message === 'string'
      ? body.message.trim()
      : '';

    if (!message || message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        error: 'Message is empty or exceeds the 8,000-character limit.'
      });
    }

    const instructions = `You are NEGUS AI, a professional and disciplined forex trading analysis assistant.

Reply primarily in clear Amharic, retaining standard trading terms in English where useful.

The user's preferred market is EUR/USD. Preferred approach: intraday Price Action + SMC.

Analyze only evidence supplied in the conversation. Never claim access to live prices, news, account balances, chart candles, or broker data unless explicitly provided.

For chart screenshots, identify the visible pair, timeframe, price scale, structure, levels and indicators only when legible. State what is unclear.

Analyze:
- Higher-timeframe bias and market structure
- BOS and CHoCH
- Liquidity pools and sweeps
- Order Blocks and Fair Value Gaps
- Entry confirmation and invalidation
- Stop Loss and Take Profit logic
- Risk-to-reward and market conditions

Do not invent exact entry, SL or TP prices from an unreadable screenshot.

End with one clear stance: BUY, SELL, or WAIT. If evidence is insufficient, choose WAIT. Give a conditional plan, never a guarantee.

STRICT RISK RULE:
Maximum planned risk is 1% per trade. If the broker's minimum lot 0.01 exceeds the risk budget, recommend skipping the trade. Never encourage increasing risk to force a trade.

Warn about high-impact news only when verified calendar details are supplied. Otherwise tell the user to check a reliable economic calendar.

Never execute, place, modify or close trades.
Distinguish observation, interpretation and recommendation.
Be professionally detailed, practical and disciplined.`;

    const history = readHistory(body.previousResponseId, expectedPin);

    const contents = [];

    for (const turn of history) {
      contents.push({
        role: 'user',
        parts: [{ text: turn.user }]
      });
      contents.push({
        role: 'model',
        parts: [{ text: turn.assistant }]
      });
    }

    let currentText = message;

    if (body.workspace && typeof body.workspace === 'object') {
      currentText +=
        '\n\nWORKSPACE CONTEXT (not verified live market data): ' +
        JSON.stringify(body.workspace);
    }

    const currentParts = [{ text: currentText }];

    if (body.imageData !== undefined) {
      if (
        typeof body.imageData !== 'string' ||
        body.imageData.length > MAX_IMAGE_CHARS
      ) {
        return res.status(400).json({
          error: 'Invalid or oversized image. Upload a smaller chart screenshot.'
        });
      }

      const match = body.imageData.match(
        /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/
      );

      if (!match) {
        return res.status(400).json({
          error: 'Invalid image format. Use PNG, JPG or WEBP.'
        });
      }

      currentParts.push({
        inlineData: {
          mimeType: match[1],
          data: match[2]
        }
      });
    }

    contents.push({
      role: 'user',
      parts: currentParts
    });

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: instructions }]
        },
        contents,
        generationConfig: {
          temperature: 0.35,
          topP: 0.9,
          maxOutputTokens: 1400
        }
      })
    });

    const data = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      const providerMessage =
        data?.error?.message ||
        `Gemini returned HTTP ${upstream.status}.`;

      console.error(
        'NEGUS AI Gemini error:',
        upstream.status,
        providerMessage
      );

      return res.status(502).json({
        error: 'Gemini service error: ' + providerMessage.slice(0, 260)
      });
    }

    const reply = getReply(data);

    if (!reply) {
      return res.status(502).json({
        error: 'Gemini returned no readable text. Try again.'
      });
    }

    const updatedHistory = [
      ...history,
      { user: message, assistant: reply }
    ].slice(-MAX_HISTORY_TURNS);

    const responseId = signHistory(updatedHistory, expectedPin);

    return res.status(200).json({
      reply,
      responseId,
      model: MODEL
    });

  } catch (error) {
    console.error('NEGUS AI backend error:', error);

    return res.status(500).json({
      error: 'NEGUS AI backend error. Check Vercel Function Logs.'
    });
  }
}
