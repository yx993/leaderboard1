// GET /api/ranks -> sorted EUW Solo/Duo leaderboard. Needs env var RIOT_API_KEY.
const PLAYERS = [
  { name: "人の夢は終わらねェ", tag: "993" },
  { name: "BGT Kachanava", tag: "2623" },
  { name: "Alp33333", tag: "Fun" },
  { name: "Talaat Pascha", tag: "Türk" },
  { name: "HLE Gumayusi", tag: "sidar" },
];
const PLATFORM = "euw1";      // league-v4 host
const REGIONAL = "europe";    // account-v1 host
const TTL = 3 * 60 * 1000;    // cache 3 min (Riot rate limits)

const TIERS = ["IRON","BRONZE","SILVER","GOLD","PLATINUM","EMERALD","DIAMOND","MASTER","GRANDMASTER","CHALLENGER"];
const DIVS = { IV: 0, III: 1, II: 2, I: 3 };
const score = (p) =>
  p.tier ? TIERS.indexOf(p.tier) * 1000 + (DIVS[p.division] ?? 0) * 100 + p.lp / 1000 * 99 : -1;

const puuids = {};
let cache = { at: 0, data: null };

async function riot(host, path) {
  const r = await fetch(`https://${host}.api.riotgames.com${path}`, {
    headers: { "X-Riot-Token": process.env.RIOT_API_KEY },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

async function load(p) {
  const id = `${p.name}#${p.tag}`;
  try {
    if (!puuids[id]) {
      const a = await riot(REGIONAL, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`);
      puuids[id] = a.puuid;
    }
    const entries = await riot(PLATFORM, `/lol/league/v4/entries/by-puuid/${puuids[id]}`);
    const solo = entries.find((e) => e.queueType === "RANKED_SOLO_5x5");
    if (!solo) return { id, tier: null };
    const games = solo.wins + solo.losses;
    return {
      id, tier: solo.tier, division: solo.rank, lp: solo.leaguePoints,
      wins: solo.wins, losses: solo.losses,
      winrate: games ? Math.round((solo.wins / games) * 100) : 0,
    };
  } catch (e) {
    return { id, tier: null, error: e.message };
  }
}

export default async function handler(req, res) {
  if (!cache.data || Date.now() - cache.at > TTL) {
    const rows = await Promise.all(PLAYERS.map(load));
    rows.sort((a, b) => score(b) - score(a));
    cache = { at: Date.now(), data: { updated: new Date().toISOString(), players: rows } };
  }
  res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=60");
  res.status(200).json(cache.data);
}
