// POST /.netlify/functions/ai-chat
// Proxies Claude API calls for the APEX SIGNAL ticket chat assistant
// ENV: ANTHROPIC_API_KEY
//
// Body: { model, max_tokens, system, messages }
// Response: passes Claude's response through unchanged

const https = require('https');

const CORS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// Netlify free tier inactivity timeout is 10s; paid is 26s.
// We must respond before that or Netlify sends a 504 HTML page.
// Keep Claude timeout well under 9s to leave room for network overhead.
const CLAUDE_TIMEOUT_MS = 8500;
const NETLIFY_SAFETY_MS  = 9200; // hard deadline — return fallback before this

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const API_KEY     = process.env.ANTHROPIC_API_KEY;
  const CHAT_SECRET = process.env.APEX_CHAT_SECRET;

  if (!API_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Chýba ANTHROPIC_API_KEY' }) };

  if (CHAT_SECRET) {
    const auth = event.headers?.authorization || event.headers?.Authorization || '';
    if (auth !== `Bearer ${CHAT_SECRET}`) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { model = 'claude-haiku-4-5-20251001', max_tokens = 400, system, messages } = body;
  if (!messages?.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Chýbajú messages' }) };

  // Hard deadline: if Claude hasn't responded by NETLIFY_SAFETY_MS, return a fallback
  // so the function itself responds before Netlify cuts us off with 504.
  const deadline = new Promise(resolve =>
    setTimeout(() => resolve({ _timeout: true }), NETLIFY_SAFETY_MS)
  );

  const claudeCall = callClaude({ model, max_tokens: Math.min(max_tokens, 500), system, messages }, API_KEY);

  const result = await Promise.race([claudeCall, deadline]);

  if (result._timeout) {
    console.warn('[ai-chat] Claude timeout — returning fallback');
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        content: [{ type: 'text', text: 'AI analýza momentálne nie je dostupná (timeout). Skús znova za chvíľu.' }],
        _fallback: true
      })
    };
  }

  if (result.error) {
    console.error('[ai-chat] Claude error:', result.error);
    return { statusCode: result.status || 500, headers: CORS, body: JSON.stringify({ error: result.error }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result.body) };
};

function callClaude({ model, max_tokens, system, messages }, apiKey) {
  return new Promise(resolve => {
    const payload = JSON.stringify({ model, max_tokens, system, messages });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (res.statusCode !== 200) {
            resolve({ error: parsed?.error?.message || `Claude HTTP ${res.statusCode}`, status: res.statusCode });
          } else {
            resolve({ body: parsed });
          }
        } catch {
          resolve({ error: 'Invalid JSON from Claude', status: 502 });
        }
      });
    });

    req.setTimeout(CLAUDE_TIMEOUT_MS, () => { req.destroy(); resolve({ _timeout: true }); });
    req.on('error', e => resolve({ error: e.message, status: 503 }));
    req.write(payload);
    req.end();
  });
}
