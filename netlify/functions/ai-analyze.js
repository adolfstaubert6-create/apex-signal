// POST /.netlify/functions/ai-analyze
// AI analysis for APEX SIGNAL B-panel.
// Primary path: Firecrawl (web data) → Claude synthesis
// Fallback path: Claude-only analysis from match stats (no crawl)
// ENV: ANTHROPIC_API_KEY, FIRECRAWL_API_KEY (optional)
//
// Body: {
//   fixture: { home, away, scoreH, scoreA, minute },
//   sliders: { xg, shots, attacks, corners, poss, pressure },
//   market:  string,     // e.g. "goal_alert"
//   mode:    string,     // "safe" | "balanced" | "aggressive"
// }
//
// Response (always JSON):
// {
//   analysis: string,   // AI reasoning text
//   confidence: number, // 0-100
//   verdict: string,    // "ENTER" | "WAIT" | "WATCH" | "NO BET"
//   source: string,     // "firecrawl+ai" | "ai-only" | "fallback"
//   _timeout?: true
// }

const https = require('https');

const CORS = {
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const CLAUDE_TIMEOUT_MS  = 7000;
const CRAWL_TIMEOUT_MS   = 4000;
const NETLIFY_SAFETY_MS  = 9000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY;
  const CRAWL_KEY    = process.env.FIRECRAWL_API_KEY;

  if (!CLAUDE_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Chýba ANTHROPIC_API_KEY' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { fixture, sliders, market = 'goal_alert', mode = 'balanced' } = body;
  if (!fixture?.home) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Chýbajú fixture dáta' }) };

  // Hard deadline to prevent Netlify 504
  let timedOut = false;
  const safetyTimer = new Promise(resolve =>
    setTimeout(() => { timedOut = true; resolve(null); }, NETLIFY_SAFETY_MS)
  );

  const analysis = await Promise.race([
    runAnalysis({ fixture, sliders, market, mode }, CLAUDE_KEY, CRAWL_KEY),
    safetyTimer
  ]);

  if (timedOut || !analysis) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(buildLocalFallback(fixture, sliders, market, mode))
    };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(analysis) };
};

async function runAnalysis({ fixture, sliders, market, mode }, claudeKey, crawlKey) {
  // Try Firecrawl first (only if key is configured and crawl budget allows)
  let webContext = null;
  if (crawlKey) {
    try {
      webContext = await crawlMatchContext(fixture, crawlKey);
    } catch (e) {
      console.warn('[ai-analyze] Firecrawl failed, continuing without web context:', e.message);
    }
  }

  const source = webContext ? 'firecrawl+ai' : 'ai-only';

  const prompt = buildPrompt(fixture, sliders, market, mode, webContext);
  const claudeResult = await callClaude(prompt, claudeKey);

  if (!claudeResult) return buildLocalFallback(fixture, sliders, market, mode);

  return { ...claudeResult, source };
}

function buildPrompt(fixture, sliders, market, mode, webContext) {
  const { home, away, scoreH, scoreA, minute } = fixture;
  const { xg = 0, shots = 0, attacks = 0, corners = 0, poss = 50, pressure = 5 } = sliders || {};
  const xgReal = (xg / 100).toFixed(2);

  const marketLabels = {
    goal_alert: 'GÓLOVÝ SIGNÁL (nasledujúci gól)',
    btts: 'OBA TÍMY GÓL',
    next_goal: 'ĎALŠÍ GÓL',
    late_goal: 'GÓL V ZÁVERE (75+)'
  };
  const mktLabel = marketLabels[market] || market;

  const webSection = webContext
    ? `\nKontextuálne dáta z webu:\n${webContext.slice(0, 600)}\n`
    : '';

  return {
    system: 'Si expert futbalový analytik AI. Odpovedaj VŽDY po slovensky. Buď stručný (max 4 vety). Výstup: JSON objekt s kľúčmi: analysis (string), confidence (0-100), verdict (ENTER/WAIT/WATCH/NO BET).',
    userMsg: `Analyzuj live zápas pre trh: ${mktLabel}
Zápas: ${home} ${scoreH}:${scoreA} ${away} (${minute}')
xG: ${xgReal} | Strely: ${shots} | Nebezp. útoky: ${attacks} | Rohy: ${corners} | Possession: ${poss}% | Tlak: ${pressure}/10
Režim: ${mode}${webSection}
Vráť VÝLUČNE JSON (žiadne markdown obalenie): {"analysis":"...","confidence":75,"verdict":"WAIT"}`
  };
}

async function callClaude({ system, userMsg }, apiKey) {
  return new Promise(resolve => {
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: userMsg }]
    });

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
          if (res.statusCode !== 200) { resolve(null); return; }
          const text = parsed.content?.[0]?.text || '';
          // Extract JSON from Claude's response
          const match = text.match(/\{[\s\S]*\}/);
          if (!match) { resolve(null); return; }
          const inner = JSON.parse(match[0]);
          resolve({
            analysis:   inner.analysis   || 'Analýza nedostupná.',
            confidence: Math.min(100, Math.max(0, parseInt(inner.confidence) || 50)),
            verdict:    sanitizeVerdict(inner.verdict)
          });
        } catch { resolve(null); }
      });
    });

    req.setTimeout(CLAUDE_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

// Optional: crawl a SofaScore / FlashScore snippet for the match
async function crawlMatchContext(fixture, crawlKey) {
  const query = `${fixture.home} vs ${fixture.away} live match stats`;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}+site:sofascore.com`,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: CRAWL_TIMEOUT_MS
    });

    const req = https.request({
      hostname: 'api.firecrawl.dev',
      path:     '/v1/scrape',
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${crawlKey}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          const text = parsed.data?.markdown || parsed.markdown || '';
          if (text.length > 50) resolve(text.slice(0, 800));
          else reject(new Error('No useful content'));
        } catch { reject(new Error('Firecrawl parse error')); }
      });
    });

    req.setTimeout(CRAWL_TIMEOUT_MS, () => { req.destroy(); reject(new Error('Firecrawl timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Pure local fallback — no external calls, instant response
function buildLocalFallback(fixture, sliders, market, mode) {
  const { home, away, scoreH, scoreA, minute } = fixture;
  const { xg = 0, shots = 0, attacks = 0, pressure = 5 } = sliders || {};
  const xgReal = (xg / 100).toFixed(2);

  const diff   = Math.abs(scoreH - scoreA);
  const total  = scoreH + scoreA;
  const isLate = minute >= 70;

  let confidence = 40;
  let verdict    = 'WATCH';
  let reasons    = [];

  if (xgReal >= 1.5)  { confidence += 15; reasons.push(`xG ${xgReal} naznačuje aktivitu`); }
  if (attacks >= 30)  { confidence += 12; reasons.push(`${attacks} nebezp. útokov`); }
  if (shots >= 10)    { confidence += 8;  reasons.push(`${shots} striel`); }
  if (pressure >= 7)  { confidence += 10; reasons.push(`vysoký tlak ${pressure}/10`); }
  if (diff === 0 && isLate) { confidence += 12; reasons.push('remíza v záverečnej fáze — tlak rastie'); }
  if (total === 0 && minute >= 45) { confidence += 8; reasons.push('bezgólový zápas — šanca na prvý gól'); }

  if (mode === 'aggressive') confidence = Math.min(confidence + 8, 100);
  if (mode === 'safe')       confidence = Math.max(confidence - 8, 0);

  if (confidence >= 70) verdict = 'ENTER';
  else if (confidence >= 55) verdict = 'WAIT';
  else if (confidence < 35)  verdict = 'NO BET';

  const analysis = reasons.length
    ? `Lokálna analýza: ${reasons.slice(0, 3).join(', ')}. Zápas ${home} vs ${away} v ${minute}'. Režim ${mode}.`
    : `Nedostatok dát pre zápas ${home} vs ${away}. Čakaj na viac štatistík.`;

  return { analysis, confidence, verdict, source: 'fallback', _fallback: true };
}

function sanitizeVerdict(v) {
  const valid = ['ENTER', 'WAIT', 'WATCH', 'NO BET', 'HIGH ALERT'];
  return valid.includes(v) ? v : 'WATCH';
}
