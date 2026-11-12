
// NEGUS AI V13 — Secure OpenAI Responses API proxy for Vercel
// Required Vercel Environment Variables:
//   OPENAI_API_KEY = your OpenAI API key (server-side only)
//   NEGUS_CHAT_PIN = a separate private PIN chosen by the owner
// Optional:
//   OPENAI_MODEL = gpt-4.1-mini

import crypto from 'node:crypto';

const ALLOWED_ORIGIN = 'https://amhasilasienigus-ops.github.io';
const MAX_IMAGE_CHARS = 4_200_000;
const MAX_MESSAGE_CHARS = 8_000;

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

function getOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of (Array.isArray(data?.output) ? data.output : [])) {
    for (const part of (Array.isArray(item?.content) ? item.content : [])) {
      if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const expectedPin = process.env.NEGUS_CHAT_PIN;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!expectedPin || !apiKey) {
    return res.status(503).json({ error: 'Backend setup incomplete. Set OPENAI_API_KEY and NEGUS_CHAT_PIN in Vercel Environment Variables.' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const suppliedPin = typeof body.accessPin === 'string' ? body.accessPin : '';
    if (!safeEqual(suppliedPin, expectedPin)) return res.status(401).json({ error: 'Access PIN ትክክል አይደለም።' });

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: 'Message is empty or exceeds the 8,000-character limit.' });
    }

    const content = [{
      type: 'input_text',
      text: message + '\n\nWORKSPACE CONTEXT (not verified live market data): ' + JSON.stringify(body.workspace || {})
    }];

    if (body.imageData !== undefined) {
      if (typeof body.imageData !== 'string' || body.imageData.length > MAX_IMAGE_CHARS || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.imageData)) {
        return res.status(400).json({ error: 'Invalid or oversized image. Upload a smaller PNG/JPG/WEBP screenshot.' });
      }
      content.push({ type: 'input_image', image_url: body.imageData, detail: 'high' });
    }

    const instructions = `You are NEGUS AI, a professional and disciplined forex trading analysis assistant. Reply primarily in clear Amharic, while retaining standard trading terms in English where useful. The user's preferred market is EUR/USD and preferred approach is intraday Price Action + SMC. Analyze only evidence supplied in the current conversation and prior conversation context. Never claim you can see live prices, news, account balances, chart candles, or broker data unless explicitly included in the inputs. For screenshots, identify the visible pair, timeframe, price scale, structure, levels and indicators only when legible; state what is unclear and ask for a clearer screenshot if needed. Explain HTF bias, market structure (BOS/CHoCH), liquidity pools/sweeps, OB/FVG, entry trigger, invalidation, SL and TP logic. Do not invent exact entry/SL/TP prices from an unreadable screenshot. End with one clear stance: BUY, SELL, or WAIT; if evidence is insufficient, choose WAIT. Give a conditional plan, not a guarantee. Respect strict risk discipline: maximum planned risk 1% per trade; if broker minimum lot 0.01 would exceed the risk budget, recommend skipping the trade rather than increasing risk. Warn about high-impact news only when the user provides verified calendar details; otherwise say news must be checked. Never execute, place, modify, or close trades. Be concise but professionally explanatory. Distinguish observation, interpretation, and recommendation.`;

    const requestBody = {
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      instructions,
      input: [{ role: 'user', content }],
      max_output_tokens: 1400,
      store: true
    };

    if (typeof body.previousResponseId === 'string' && /^resp_[A-Za-z0-9_-]{8,}$/.test(body.previousResponseId)) {
      requestBody.previous_response_id = body.previousResponseId;
    }

    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = data?.error?.message || `AI provider returned HTTP ${upstream.status}.`;
      console.error('NEGUS AI provider error:', upstream.status, message);
      return res.status(502).json({ error: 'AI service error: ' + message.slice(0, 260) });
    }

    const reply = getOutputText(data);
    if (!reply) return res.status(502).json({ error: 'AI returned no readable text. Try again.' });
    return res.status(200).json({ reply, responseId: data.id || null, model: data.model || requestBody.model });
  } catch (error) {
    console.error('NEGUS AI chat handler error:', error);
    return res.status(500).json({ error: 'NEGUS AI backend error. Check Vercel Function Logs.' });
  }
}
