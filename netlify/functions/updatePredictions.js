const { getStore } = require('@netlify/blobs');

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const CACHE_KEY = 'latest';

function todayET() {
  const now = new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function extractJsonArray(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Claude did not return a JSON array.');
  return JSON.parse(match[0]);
}

async function getMlbSchedule(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB schedule error ${res.status}`);
  const data = await res.json();
  const games = [];
  for (const d of data.dates || []) {
    for (const g of d.games || []) {
      games.push({
        gameTime: g.gameDate,
        venue: g.venue?.name || '',
        away: g.teams?.away?.team?.abbreviation || g.teams?.away?.team?.teamName || '',
        home: g.teams?.home?.team?.abbreviation || g.teams?.home?.team?.teamName || '',
        awayPitcher: g.teams?.away?.probablePitcher?.fullName || 'TBD',
        homePitcher: g.teams?.home?.probablePitcher?.fullName || 'TBD'
      });
    }
  }
  return games;
}

async function buildPredictions() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY environment variable in Netlify.');
  const date = todayET();
  const games = await getMlbSchedule(date);
  if (!games.length) throw new Error(`No MLB games found for ${date}.`);

  const prompt = `Today is ${date} Eastern time. You are an MLB home run matchup analyst. Use this official MLB schedule and probable pitchers only:\n${JSON.stringify(games, null, 2)}\n\nGenerate 16-22 home run predictions for today's games. Use realistic MLB knowledge, current power profiles, park effects, pitcher HR vulnerability, platoon edge, recent form assumptions, and probable pitcher matchups. Do not invent games outside the schedule. Return ONLY valid JSON array, no markdown, no backticks. Each object must have exactly these fields: player, team, opponent, pitcher, homeAway, park, gameTime, hrProbability, hrSeason, avgExitVelo, barrelRate, iso, isElite, factors, confidence, analysis. hrProbability must be a number 8-48. isElite true only if hrProbability > 30. factors must be 2-4 objects with label max 4 words and type pos or neg. gameTime should be ET like 7:05 PM ET.`;

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
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error ${res.status}`);
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const predictions = extractJsonArray(text).map(p => ({ ...p, isElite: Number(p.hrProbability) > 30 }));

  const payload = { updatedAt: new Date().toISOString(), date, model: MODEL, games: games.length, predictions };
  const store = getStore('hrdemons');
  await store.setJSON(CACHE_KEY, payload);
  return payload;
}

exports.handler = async function () {
  try {
    const payload = await buildPredictions();
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
  } catch (err) {
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
