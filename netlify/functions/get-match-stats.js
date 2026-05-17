// GET /.netlify/functions/get-match-stats?fixture={id}
// Returns fixture info + slider-ready stats for a live match
// ENV: API_FOOTBALL_KEY
//
// Response shape (matches what index.html expects):
// {
//   fixture: { home, away, scoreH, scoreA, minute },
//   sliders: { shots, attacks, corners, poss, xg, pressure },
//   statsAvailable: bool
// }

const https = require('https');

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  const API_KEY   = process.env.API_FOOTBALL_KEY;
  const fixtureId = event.queryStringParameters?.fixture;

  if (!API_KEY)   return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Chýba API_FOOTBALL_KEY' }) };
  if (!fixtureId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Chýba fixture ID' }) };

  try {
    // Fetch fixture + statistics in parallel
    const [fixtureData, statsData] = await Promise.all([
      apifootball(`/fixtures?id=${fixtureId}`, API_KEY),
      apifootball(`/fixtures/statistics?fixture=${fixtureId}`, API_KEY)
    ]);

    // ── Fixture info ──
    const fix = fixtureData.response?.[0];
    if (!fix) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Zápas nenájdený' }) };

    const fixture = {
      home:   fix.teams.home.name,
      away:   fix.teams.away.name,
      scoreH: fix.goals.home  ?? 0,
      scoreA: fix.goals.away  ?? 0,
      minute: fix.fixture.status.elapsed || 0
    };

    // ── Statistics ──
    const homeStats = statsData.response?.[0]?.statistics || [];
    const awayStats = statsData.response?.[1]?.statistics || [];

    const get = (arr, type) => {
      const s = arr.find(x => x.type === type);
      if (!s || s.value === null) return 0;
      // Strip % from possession values
      return typeof s.value === 'string' ? parseInt(s.value) || 0 : (s.value || 0);
    };

    const shotsH    = get(homeStats, 'Total Shots');
    const shotsA    = get(awayStats, 'Total Shots');
    const shots     = shotsH + shotsA;

    const attacksH  = get(homeStats, 'Dangerous Attacks');
    const attacksA  = get(awayStats, 'Dangerous Attacks');
    const attacks   = attacksH + attacksA;

    const corners   = get(homeStats, 'Corner Kicks') + get(awayStats, 'Corner Kicks');

    // Possession: use home team's %, fallback 50
    const possRaw   = homeStats.find(s => s.type === 'Ball Possession');
    const poss      = possRaw?.value ? parseInt(possRaw.value) || 50 : 50;

    // xG: ×100 for slider (slider range 0–250, display value = xg/100)
    const xgH       = parseFloat(homeStats.find(s => s.type === 'expected_goals')?.value) || 0;
    const xgA       = parseFloat(awayStats.find(s => s.type === 'expected_goals')?.value) || 0;
    const xg        = Math.round((xgH + xgA) * 100);

    // Pressure: derived from dangerous attacks (attacks/18, clamped 1–10)
    const pressure  = Math.min(Math.max(Math.round(attacks / 18), 1), 10);

    const statsAvailable = shots > 0 || attacks > 0 || corners > 0;

    console.log(`[get-match-stats] fixture:${fixtureId} shots:${shots} attacks:${attacks} xg:${xg/100} statsAvailable:${statsAvailable}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        fixture,
        sliders: { shots, attacks, corners, poss, xg, pressure },
        statsAvailable
      })
    };

  } catch (e) {
    console.error('[get-match-stats]', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
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
          catch { reject(new Error('Invalid JSON from API-Football')); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('API-Football timeout')); });
    req.on('error', reject);
    req.end();
  });
}
