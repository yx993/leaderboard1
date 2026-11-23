// GET /api/ranks -> sorted EUW Solo/Duo leaderboard + Challenger cutoff. Needs env var RIOT_API_KEY.
const PLAYERS = [
  { name: "xdd", tag: "dyron" },
  { name: "antos", tag: "2060" },
  { name: "BGT Kachanava", tag: "2623" },
  { name: "HLE Gumayusi", tag: "sidar" },
  { name: "Alp33333", tag: "Fun" },
  { name: "DOMIDOMIDOMIDOMI", tag: "DOMI" },
  { name: "人の夢は終わらねェ", tag: "993" },
  { name: "Talaat Pascha", tag: "Türk" },
];
const PLATFORM = "euw1";      // league-v4 host
const REGIONAL = "europe";    // account-v1 host
const TTL = 3 * 60 * 1000;    // cache 3 min (Riot rate limits)

const TIERS = ["IRON","BRONZE","SILVER","GOLD","PLATINUM","EMERALD","DIAMOND","MASTER","GRANDMASTER","CHALLENGER"];
const DIVS = { IV: 0, III: 1, II: 2, I: 3 };
const MASTER_BASE = 2800; // 7 tiers x 400 points, Master starts at 0 LP

// One number for the whole ladder, so players can be sorted and compared to the cutoff.
const total = (p) => {
  if (!p.tier) return null;
  const t = TIERS.indexOf(p.tier);
  return t >= 7 ? MASTER_BASE + p.lp : t * 400 + (DIVS[p.division] ?? 0) * 100 + p.lp;
};

// LP change is measured from this snapshot. Riot's API has no LP history, so we pin our own.
// The numbers are each player's "total" from /api/ranks at BASELINE_AT. To restart the count
// from now: open /api/ranks, copy every player's "total" here and update BASELINE_AT.
// (You can also write a rank string instead, e.g. "MASTER 120" or "DIAMOND II 45".)
const BASELINE_AT = "2026-11-21T14:31:28Z";
const BASELINE = {
  "xdd#dyron": 4646,
  "antos#2060": 4588,
  "BGT Kachanava#2623": 4268,
  "HLE Gumayusi#sidar": 4003,
  "Alp33333#Fun": 3978,
  "DOMIDOMIDOMIDOMI#DOMI": 3621,
  "人の夢は終わらねェ#993": 3099,
  "Talaat Pascha#Türk": 3080,
};
const parseBase = (str) => {
  const [t, ...r] = str.trim().toUpperCase().split(/\s+/);
  const ti = TIERS.indexOf(t);
  const lp = Number(r[r.length - 1]);
  if (ti < 0 || !Number.isFinite(lp)) return null;
  return ti >= 7 ? MASTER_BASE + lp : ti * 400 + (DIVS[r[0]] ?? 0) * 100 + lp;
};

const puuids = {};
let cache = { at: 0, data: null };

async function riot(host, path) {
  const r = await fetch(`https://${host}.api.riotgames.com${path}`, {
    headers: { "X-Riot-Token": process.env.RIOT_API_KEY },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

async function cutoff() {
  try {
    const l = await riot(PLATFORM, "/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5");
    const lps = l.entries.map((e) => e.leaguePoints);
    return lps.length >= 300 ? Math.min(...lps) : 500; // Challenger needs top 300 and 500+ LP
  } catch (e) {
    return null;
  }
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
    return { id, tier: solo.tier, division: solo.rank, lp: solo.leaguePoints };
  } catch (e) {
    return { id, tier: null, error: e.message };
  }
}

export default async function handler(req, res) {
  if (!cache.data || Date.now() - cache.at > TTL) {
    const [rows, cut] = await Promise.all([Promise.all(PLAYERS.map(load)), cutoff()]);
    rows.forEach((p) => {
      p.total = total(p);
      // > 0: LP still needed to reach cutoff. <= 0: already above it by that many LP.
      p.toCutoff = cut != null && p.total != null ? cut + MASTER_BASE - p.total : null;
      const raw = BASELINE[p.id];
      const b = raw == null ? null : typeof raw === "number" ? raw : parseBase(raw);
      p.change = b != null && p.total != null ? p.total - b : null; // LP gained/lost since BASELINE_AT
    });
    rows.sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
    cache = { at: Date.now(), data: { updated: new Date().toISOString(), cutoff: cut, baselineAt: BASELINE_AT, players: rows } };
  }
  res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=60");
  res.status(200).json(cache.data);
}
