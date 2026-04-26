const { getStore } = require('@netlify/blobs');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const CACHE_KEY = 'latest';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

async function getCache() {
  const store = getStore('hrdemons-predictions');
  const data = await store.get(CACHE_KEY, { type: 'json' });
  return data || null;
}

async function setCache(payload) {
  const store = getStore('hrdemons-predictions');
  await store.setJSON(CACHE_KEY, payload);
}

async function fetchMLBSchedule() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const date = `${yyyy}-${mm}-${dd}`;
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB schedule API failed ${res.status}`);
  const data = await res.json();
  const games = [];
  for (const d of data.dates || []) {
    for (const g of d.games || []) {
      games.push({
        gamePk: g.gamePk,
        gameTime: g.gameDate,
        away: g.teams?.away?.team?.abbreviation || g.teams?.away?.team?.name,
        home: g.teams?.home?.team?.abbreviation || g.teams?.home?.team?.name,
        awayName: g.teams?.away?.team?.name,
        homeName: g.teams?.home?.team?.name,
        awayPitcher: g.teams?.away?.probablePitcher?.fullName || 'TBD',
        homePitcher: g.teams?.home?.probablePitcher?.fullName || 'TBD',
        status: g.status?.detailedState || ''
      });
    }
  }
  return { date, games };
}

function normalizePrediction(p, i) {
  const prob = Math.max(8, Math.min(48, Math.round(Number(p.hrProbability || p.probability || 12))));
  return {
    player: String(p.player || `Pick ${i + 1}`),
    team: String(p.team || '—').slice(0, 10),
    opponent: String(p.opponent || '—').slice(0, 10),
    pitcher: String(p.pitcher || 'TBD'),
    homeAway: p.homeAway === 'away' ? 'away' : 'home',
    park: String(p.park || 'TBD'),
    gameTime: String(p.gameTime || 'TBD'),
    hrProbability: prob,
    hrSeason: Number.isFinite(Number(p.hrSeason)) ? Number(p.hrSeason) : 0,
    avgExitVelo: Number.isFinite(Number(p.avgExitVelo)) ? Number(p.avgExitVelo).toFixed(1) : '—',
    barrelRate: Number.isFinite(Number(p.barrelRate)) ? Number(p.barrelRate).toFixed(1) : '—',
    iso: Number.isFinite(Number(p.iso)) ? Number(p.iso).toFixed(3) : '—',
    isElite: prob > 30,
    factors: Array.isArray(p.factors) ? p.factors.slice(0, 5).map(f => ({
      label: String(f.label || 'Power spot').slice(0, 28),
      type: f.type === 'neg' ? 'neg' : 'pos'
    })) : [{ label: 'Power spot', type: 'pos' }],
    confidence: Math.max(1, Math.min(100, Math.round(Number(p.confidence || 60)))),
    analysis: String(p.analysis || 'Power matchup selected by the HR Demons model. Confirm lineups before locking anything in.').slice(0, 500)
  };
}

function extractJSONArray(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude returned no JSON array');
  return JSON.parse(match[0]);
}

async function generatePredictions() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing ANTHROPIC_API_KEY in Netlify environment variables');
  }

  const schedule = await fetchMLBSchedule();
  const gamesText = schedule.games.length ? JSON.stringify(schedule.games).slice(0, 12000) : 'No MLB games found today.';
  const prompt = `Today is ${schedule.date}. Use this MLB schedule/probable pitcher data: ${gamesText}

Create 18 MLB home run prediction cards for today. Return ONLY a JSON array. No markdown. No intro. Each object must have exactly these fields:
player, team, opponent, pitcher, homeAway, park, gameTime, hrProbability, hrSeason, avgExitVelo, barrelRate, iso, isElite, factors, confidence, analysis.

Rules:
- Pick real MLB power hitters likely to be active today based on the games listed.
- hrProbability must be realistic between 8 and 48.
- factors must be an array of 3-5 objects like {"label":"Hot bat","type":"pos"}.
- analysis must be 1-2 short sentences.
- Use 2026 wording, not 2025.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 5000,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`Claude returned non-JSON status ${res.status}`); }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `Claude API error ${res.status}`;
    throw new Error(msg);
  }

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const arr = extractJSONArray(text).map(normalizePrediction).slice(0, 22);
  if (!arr.length) throw new Error('Claude returned an empty prediction list');
  const payload = { lastUpdated: new Date().toISOString(), model: MODEL, source: 'claude+mlb-schedule', predictions: arr };
  await setCache(payload);
  return payload;
}

module.exports = { json, getCache, setCache, generatePredictions };
