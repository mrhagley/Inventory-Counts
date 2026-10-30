'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const WORKSPACE_ID = process.env.ANTHROPIC_WORKSPACE_ID || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE) || 20;

const PUBLIC_DIR = path.join(__dirname, 'public');
const PARTS_FILE = path.join(__dirname, 'parts.json');
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function loadDefaultParts() {
  try {
    const list = JSON.parse(fs.readFileSync(PARTS_FILE, 'utf8'));
    return cleanParts(list) || [];
  } catch (e) {
    console.error('Could not read parts.json:', e.message);
    return [];
  }
}

// Returns a cleaned parts array, or null when the input is not a usable list.
function cleanParts(list) {
  if (!Array.isArray(list) || list.length > 600) return null;
  const out = [];
  for (const p of list) {
    if (!p || typeof p.name !== 'string') continue;
    const name = p.name.replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
    const sku = String(p.sku == null ? '' : p.sku).replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    if (name) out.push({ name, sku });
  }
  return out;
}

function buildPrompt(parts) {
  const list = parts.length
    ? parts.map(p => '- ' + p.name + (p.sku ? '  [SKU: ' + p.sku + ']' : '')).join('\n')
    : '(no parts list provided)';
  return `You are helping a security-system installer do a stock check. The attached photo shows parts on a truck shelf, in a bin, or on a bench.

Parts list (each line is a part name with its SKU in brackets):
${list}

Instructions:
- Count every distinct type of item you can clearly see. Give one entry per type.
- Count individual units. If items are in sealed boxes or bags and you cannot see inside, count the packages and say so in the note.
- Read printed labels, box text and model numbers when they are legible and use them to decide which part an item is. Many parts differ only by color, size, carrier or brand, so look for those details.
- For an item on the list, copy its name and SKU exactly as written. If you cannot tell which of several similar parts it is, pick the most likely one, set "confidence" to "low" and say in the note what you could not tell.
- If an item is not on the parts list, give it a short descriptive name, use an empty SKU and set "onList" to false.
- Never guess at items that are hidden, stacked behind others or out of frame. Count what is visible and mention what may be missing in the note.
- Set "confidence" to "high", "medium" or "low" for how sure you are of that count.

Reply with only a JSON array and no other text. Each entry: {"name": string, "sku": string, "count": number, "onList": boolean, "confidence": "high" | "medium" | "low", "note": string}. Use an empty note when there is nothing to add. If nothing countable is visible, reply [].`;
}

function extractJsonArray(text) {
  const tries = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a !== -1 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.items)) return v.items;
    } catch (e) { /* try the next form */ }
  }
  return null;
}

// ---- access code and rate limit ----
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
function codeOk(req) {
  if (!ACCESS_CODE) return true;
  const given = req.get('x-access-code') || '';
  return crypto.timingSafeEqual(digest(given), digest(ACCESS_CODE));
}

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= RATE_LIMIT) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const recent = list.filter(t => now - t < 60000);
    if (recent.length) hits.set(ip, recent); else hits.delete(ip);
  }
}, 60000).unref();

// ---- app ----
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ needsCode: Boolean(ACCESS_CODE), aiReady: Boolean(API_KEY) });
});

app.get('/api/parts', (req, res) => {
  if (!codeOk(req)) return res.status(401).json({ code: 'auth', message: 'Access code is missing or wrong.' });
  res.set('Cache-Control', 'no-store');
  res.json(DEFAULT_PARTS);
});

app.post('/api/count', express.json({ limit: '12mb' }), async (req, res) => {
  const fail = (status, code, message) => res.status(status).json({ code, message });

  if (!codeOk(req)) return fail(401, 'auth', 'Access code is missing or wrong.');
  if (!API_KEY) return fail(503, 'not_configured', 'The server has no ANTHROPIC_API_KEY set.');
  if (rateLimited(req.ip)) return fail(429, 'rate_limited', 'Too many counts in a minute.');

  const { image, mediaType } = req.body || {};
  if (typeof image !== 'string' || image.length < 100) return fail(400, 'bad_request', 'No photo received.');
  if (image.length > 11_000_000) return fail(413, 'too_large', 'Photo is too large.');
  if (!ALLOWED_TYPES.has(mediaType)) return fail(400, 'bad_request', 'Photo must be JPEG, PNG, WebP or GIF.');
  if (!/^[A-Za-z0-9+/=]+$/.test(image)) return fail(400, 'bad_request', 'Photo data is not valid base64.');

  const parts = DEFAULT_PARTS;

  try {
    const upstream = await fetch(BASE_URL + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        ...(WORKSPACE_ID ? { 'anthropic-workspace-id': WORKSPACE_ID } : {})
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: buildPrompt(parts) }
          ]
        }]
      }),
      signal: AbortSignal.timeout(90000)
    });

    if (!upstream.ok) {
      let detail = '';
      try { detail = (await upstream.json()).error?.message || ''; } catch (e) { /* no body */ }
      console.error('Anthropic API error', upstream.status, detail);
      if (upstream.status === 401 || upstream.status === 403) return fail(503, 'not_configured', 'The API key was rejected.');
      if (upstream.status === 429) return fail(429, 'rate_limited', 'The AI service is busy. Try again shortly.');
      return fail(502, 'upstream', 'The AI service could not process the request.');
    }

    const data = await upstream.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const items = extractJsonArray(text);
    if (!items) return fail(502, 'unreadable', 'The reply could not be read as a list.');
    res.set('Cache-Control', 'no-store');
    res.json({ items: items.filter(i => i && typeof i === 'object').slice(0, 200) });
  } catch (e) {
    console.error('Count request failed:', e.name, e.message);
    if (e.name === 'TimeoutError') return fail(504, 'upstream', 'The count took too long.');
    return fail(502, 'upstream', 'The AI service could not be reached.');
  }
});

app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: 0 }));

// JSON body errors (too large, malformed) from the parser above
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ code: 'too_large', message: 'Photo is too large.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ code: 'bad_request', message: 'Malformed request.' });
  console.error(err);
  res.status(500).json({ code: 'server', message: 'Server error.' });
});

const DEFAULT_PARTS = loadDefaultParts();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Shelf Count listening on port ${PORT}`);
  console.log(API_KEY ? `Model: ${MODEL}` : 'WARNING: ANTHROPIC_API_KEY is not set. Photo counting is disabled.');
  if (!ACCESS_CODE) console.log('Note: ACCESS_CODE is not set. Anyone with the link can use your API key.');
});
