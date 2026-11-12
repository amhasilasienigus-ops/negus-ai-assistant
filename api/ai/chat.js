
import crypto from 'node:crypto';

const ALLOWED_ORIGIN = 'https://amhasilasienigus-ops.github.io';
const MODEL = 'gemini-3.5-flash-lite';

const MAX_IMAGE_CHARS = 4_200_000;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_TOKEN_CHARS = 80_000;
const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;

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

  return aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb);
}

function createHistoryToken(history, secret) {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    expiresAt: Date.now() + HISTORY_TTL_MS,
    history
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  return `ctx_${payload}.${signature}`;
}

function readHistoryToken(token, secret) {
  if (typeof token !== 'string' ||
      !token.startsWith('ctx_') ||
      token.length > MAX_HISTORY_TOKEN_CHARS) {
    return [];
  }

  try {
    const parts = token.slice(4).split('.');
    if (parts.length !== 2) return [];

    const [payload, signature] = parts;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('base64url');

    if (!safeEqual(signature, expectedSignature)) return [];

    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );

    if (
      decoded.version !== 1 ||
      !Number.isFinite(decoded.expiresAt) ||
      decoded.expiresAt < Date.now() ||
      !Array.isArray(decoded.history)
    ) {
      return [];
    }

    return decoded.history
      .filter(item =>
        item &&
        ['user', 'model'].includes(item.role) &&
        Array.isArray(item.parts) &&
        item.parts.length > 0 &&
        item.parts.every(part =>
          part &&
          typeof part.text === 'string'
        )
      )
      .slice(-MAX_HISTORY_MESSAGES);

  } catch {
    return [];
  }
}

function getGeminiText(data) {
  const candidates = Array.isArray(data?.candidates)
    ? data.candidates
    : [];

  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;

    if (!Array.isArray(parts)) continue;

    const text = parts
      .filter(part => typeof part?.text === 'string')
      .map(part => part.text)
      .join('\n')
      .trim();

    if (text) return text;
  }

  return '';
}

function buildInstructions() {
  return `
You are NEGUS AI, a professional and disciplined forex trading analysis assistant.

LANGUAGE:
- Reply primarily in clear, natural Amharic.
- Keep standard trading terms in English when useful.
- Be respectful, direct, practical and professional.

USER'S TRADING CONTEXT:
- Preferred pair: EUR/USD.
- Preferred approach: Intraday Price Action + SMC.
- Broker context: Exness Standard.
- Account currency: USD.
- Minimum lot size: 0.01.
- The user values discipline, capital protection and avoiding FOMO.

ANALYSIS:
When chart evidence is provided, analyze:
1. Higher-timeframe direction and market bias.
2. Market structure: HH, HL, LH, LL, BOS and CHoCH.
3. Liquidity pools and liquidity sweeps.
4. Order Blocks (OB) and Fair Value Gaps (FVG).
5. Support and resistance.
6. Entry confirmation and invalidation.
7. Stop Loss and Take Profit logic.
8. Risk-to-Reward.

SCREENSHOTS:
- Read only what is actually visible and legible.
- Identify pair and timeframe only when clear.
- Never invent prices, candle patterns, indicators or chart levels.
- If the screenshot is unclear, explain what is missing.
- If evidence is insufficient, choose WAIT.

LIVE DATA:
- Never pretend to have live market prices, live news, account balance or broker information unless it is explicitly provided in the conversation.
- If current news information is not provided or verified, tell the user to check the economic calendar.
- Never invent economic news or event times.

RISK MANAGEMENT:
- Maximum planned risk: 1% of account balance per trade.
- Respect the broker's 0.01 minimum lot.
- If 0.01 lot would exceed the user's risk budget, recommend skipping the trade.
- Never recommend increasing risk to force a trade.
- Stop Loss is essential.
- Discourage revenge trading, FOMO and exceeding daily risk limits.

FINAL DECISION:
End every actual market analysis with one clear stance:
BUY, SELL or WAIT.

A trade idea must be conditional, never guaranteed.
Explain the conditions that would confirm or invalidate it.

SAFETY:
- Never promise profits or guaranteed accuracy.
- Never execute, place, modify or close trades.
- Never ask the user to reveal API keys, passwords or private PINs.
- Be honest about uncertainty.

You are a disciplined trading analysis partner, not a signal-selling service.
`;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed.'
    });
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

    let workspaceText = '';

    try {
      workspaceText = JSON.stringify(body.workspace || {});
    } catch {
      workspaceText = '{}';
    }

    if (workspaceText.length > 20_000) {
      workspaceText = workspaceText.slice(0, 20_000);
    }

    const userText =
      message +
      '\n\nWORKSPACE CONTEXT (not verified live market data):\n' +
      workspaceText;

    const history = readHistoryToken(
      body.previousResponseId,
      expectedPin
    );

    const userParts = [
      { text: userText }
    ];

    let imagePart = null;

    if (body.imageData !== undefined && body.imageData !== null) {
      if (typeof body.imageData !== 'string' ||
          body.imageData.length > MAX_IMAGE_CHARS) {
        return res.status(400).json({
          error: 'Image is too large. Upload a smaller chart screenshot.'
        });
      }

      const match = body.imageData.match(
        /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/
      );

      if (!match) {
        return res.status(400).json({
          error: 'Invalid image. Use PNG, JPG or WEBP.'
        });
      }

      const mimeType = match[1] === 'jpg'
        ? 'image/jpeg'
        : `image/${match[1]}`;

      imagePart = {
        inlineData: {
          mimeType,
          data: match[2]
        }
      };

      userParts.push(imagePart);
    }

    const contents = [
      ...history,
      {
        role: 'user',
        parts: userParts
      }
    ];

    const requestBody = {
      systemInstruction: {
        parts: [
          { text: buildInstructions() }
        ]
      },
      contents,
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 1800,
        topP: 0.9
      }
    };

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(requestBody)
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
        error: 'Gemini service error: ' +
          providerMessage.slice(0, 300)
      });
    }

    const reply = getGeminiText(data);

    if (!reply) {
      console.error(
        'NEGUS AI: Gemini returned no readable text.',
        data?.candidates?.[0]?.finishReason || 'No finish reason'
      );

      return res.status(502).json({
        error: 'Gemini returned no readable answer. Please try again.'
      });
    }

    const updatedHistory = [
      ...history,
      {
        role: 'user',
        parts: [
          { text: userText }
        ]
      },
      {
        role: 'model',
        parts: [
          { text: reply }
        ]
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    const responseId = createHistoryToken(
      updatedHistory,
      expectedPin
    );

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
