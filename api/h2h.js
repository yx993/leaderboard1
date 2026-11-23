// GET /api/h2h -> head-to-head results between the tracked players (ranked Solo/Duo).
// Needs env var RIOT_API_KEY. Keep PLAYERS in sync with ranks.js.
export const config = { maxDuration: 60 };

// Period to scan (UTC = UK time in winter). Change these two lines to change the window.
const START = "2026-11-20T00:00:00Z";
const END = "2026-12-05T00:00:00Z";

const PLAYERS = [
  { name: "xdd", tag: "dyron" },
  { name: "BGT Kachanava", tag: "2623" },
  { name: "HLE Gumayusi", tag: "sidar" },
  { name: "Alp33333", tag: "Fun" },
  { name: "DOMIDOMIDOMIDOMI", tag: "DOMI" },
  { name: "人の夢は終わらねェ", tag: "993" },
  { name: "Talaat Pascha", tag: "Türk" },
];
const REGIONAL = "europe"; // account-v1 and match-v5 both use the regional host
const QUEUE = 420;         // 420 = ranked Solo/Duo (440 = Flex)
const PAGES = 10;          // safety cap: up to 10 x 100 matches per player inside the window
const TTL = 30 * 60 * 1000;

const puuids = {};
let cache = { at: 0, data: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function riot(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`https://${REGIONAL}.api.riotgames.com${path}`, {
      headers: { "X-Riot-Token": process.env.RIOT_API_KEY },
    });
    if (r.status === 429) {
      await sleep((Number(r.headers.get("retry-after")) || 2) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${path.split("?")[0]}`);
    return r.json();
  }
  throw new Error("429 rate limited");
}

async function compute() {
  const ids = PLAYERS.map((p) => `${p.name}#${p.tag}`);
  for (const [i, p] of PLAYERS.entries()) {
    if (!puuids[ids[i]]) {
      const a = await riot(`/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(p.name)}/${encodeURIComponent(p.tag)}`);
      puuids[ids[i]] = a.puuid;
    }
  }
  const t0 = Math.floor(Date.parse(START) / 1000);
  const t1 = Math.min(Math.floor(Date.parse(END) / 1000), Math.floor(Date.now() / 1000));
  const idx = Object.fromEntries(ids.map((id, i) => [puuids[id], i]));

  // 1) collect match ids per player; a match seen under 2+ players had several of them in it
  const seen = {};
  for (let i = 0; i < ids.length; i++) {
    for (let page = 0; page < PAGES; page++) {
      const list = await riot(`/lol/match/v5/matches/by-puuid/${puuids[ids[i]]}/ids?queue=${QUEUE}&startTime=${t0}&endTime=${t1}&start=${page * 100}&count=100`);
      list.forEach((m) => (seen[m] ??= []).push(i));
      if (list.length < 100) break;
    }
  }

  // 2) only open the shared matches; opposite teams = a head-to-head game
  const n = ids.length;
  const wins = Array.from({ length: n }, () => Array(n).fill(0));
  let used = 0;
  for (const m of Object.keys(seen).filter((k) => seen[k].length >= 2)) {
    const info = (await riot(`/lol/match/v5/matches/${m}`)).info;
    if (info.participants.some((p) => p.gameEndedInEarlySurrender)) continue; // skip remakes
    const tracked = info.participants.filter((p) => p.puuid in idx);
    let counted = false;
    for (const a of tracked) {
      for (const b of tracked) {
        if (a.teamId !== b.teamId && a.win) {
          wins[idx[a.puuid]][idx[b.puuid]]++;
          counted = true;
        }
      }
    }
    if (counted) used++;
  }
  return { updated: new Date().toISOString(), players: ids, wins, matches: used, from: START, to: END };
}

export default async function handler(req, res) {
  try {
    if (!cache.data || Date.now() - cache.at > TTL) {
      cache = { at: Date.now(), data: await compute() };
    }
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=600");
    res.status(200).json(cache.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
