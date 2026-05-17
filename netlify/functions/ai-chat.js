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
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const API_KEY     = process.env.ANTHROPIC_API_KEY;
  const CHAT_SECRET = process.env.APEX_CHAT_SECRET;

  if (!API_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Chýba ANTHROPIC_API_KEY' }) };

  // If APEX_CHAT_SECRET is set in Netlify ENV, require matching Authorization header
  if (CHAT_SECRET) {
    const auth = event.headers?.authorization || event.headers?.Authorization || '';
    if (auth !== `Bearer ${CHAT_SECRET}`) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { model = 'claude-sonnet-4-20250514', max_tokens = 600, system, messages } = body;
  if (!messages?.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Chýbajú messages' }) };

  const payload = JSON.stringify({ model, max_tokens, system, messages });

  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers:  {
          'Content-Type':       'application/json',
          'x-api-key':          API_KEY,
          'anthropic-version':  '2023-06-01',
          'Content-Length':     Buffer.byteLength(payload)
        }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch { reject(new Error('Invalid JSON from Claude')); }
        });
      });
      req.setTimeout(25000, () => { req.destroy(); reject(new Error('Claude timeout')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    if (result.status !== 200) {
      const errMsg = result.body?.error?.message || `Claude HTTP ${result.status}`;
      console.error('[ai-chat] Claude error:', errMsg);
      return { statusCode: result.status, headers: CORS, body: JSON.stringify({ error: errMsg }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result.body) };

  } catch (e) {
    console.error('[ai-chat]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
