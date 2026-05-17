// GET /.netlify/functions/get-live-matches
// Fetches all currently live football matches from API-Football
// ENV: API_FOOTBALL_KEY

const https = require('https');

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async () => {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ apiError: 'Chýba API_FOOTBALL_KEY' }) };
  }

  try {
    const data = await apifootball('/fixtures?live=all', API_KEY);

    // Surface API-level errors (rate limit, bad key, etc.)
    if (data.errors && Object.keys(data.errors).length > 0) {
      const errMsg = Object.values(data.errors).join(' ');
      const limitExceeded = /limit|rate|plan|requests/i.test(errMsg);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ apiError: errMsg, limitExceeded }) };
    }

    const matches = (data.response || []).map(m => ({
      id:     m.fixture.id,
      home:   m.teams.home.name,
      away:   m.teams.away.name,
      scoreH: m.goals.home  ?? 0,
      scoreA: m.goals.away  ?? 0,
      minute: m.fixture.status.elapsed || 0,
      league: `${m.league.name} · ${m.league.country}`
    }));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ matches }) };

  } catch (e) {
    console.error('[get-live-matches]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ apiError: e.message }) };
  }
};

function apifootball(path, key) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'v3.football.api-sports.io', path, method: 'GET',
        headers: { 'x-apisports-key': key } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error('Invalid JSON from API-Football')); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('API-Football timeout')); });
    req.on('error', reject);
    req.end();
  });
}
