// Psalmless ranked API. The server holds each round's answer, decides how much audio
// the browser may hear, checks guesses, and computes the score, so the leaderboard
// only ever contains scores earned through play.
import { trimPreview } from "./mp4.js";

const CLIPS = [0.5, 1, 2, 4, 8, 16];
const STAGE_PTS = [1000, 700, 500, 350, 200, 100];
const LIVES = 3;
const MAX_ARTISTS = 40;
const MIN_RANKED_POOL = 15;
const RUN_TTL = 2 * 86400e3;
const POP_N = [3, 10, 25, 60, Infinity];
const SET_SIZES = [5, 10, 15, 20];
const SET_TTL = 90 * 86400e3;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS }
});
const fail = (msg, status = 400) => json({ error: msg }, status);

/* ---------- text helpers (kept in step with the page's copies) ---------- */
function baseTitle(t) {
  return t.replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/\s+-\s+.*$/, "").trim();
}
function norm(t) {
  return baseTitle(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and").replace(/[^a-z0-9 ]/g, "").replace(/^the /, "").replace(/\s+/g, " ").trim();
}

/* ---------- song catalog ---------- */
// Apple rate-limits its search API from Cloudflare's shared IPs, so artist song lists
// arrive as track IDs from players' browsers (or worker/seed.mjs). The server re-reads
// every ID from Apple's lookup API, so titles, previews and years always come from Apple.
const LOOKUP = "https://uclient-api.itunes.apple.com/WebObjects/MZStorePlatform.woa/wa/lookup?";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const STALE_AFTER = 7 * 86400e3;
const mem = new Map(); // parsed artist lists, reused while this isolate lives

async function getArtists(env, names) {
  const out = new Map(), need = [];
  for (const n of names) {
    const hot = mem.get(n.toLowerCase());
    if (hot && Date.now() - hot.at < 3600e3) out.set(n, hot.entry); else need.push(n);
  }
  if (need.length) {
    const { results } = await env.DB.prepare(`SELECT name, fetched, data FROM artists WHERE name IN (${need.map(() => "?").join(",")})`)
      .bind(...need.map(n => n.toLowerCase())).all();
    const rows = new Map(results.map(r => [r.name, r]));
    for (const n of need) {
      const r = rows.get(n.toLowerCase());
      if (!r) continue;
      const entry = { fetched: r.fetched, tracks: JSON.parse(r.data) };
      mem.set(n.toLowerCase(), { at: Date.now(), entry });
      out.set(n, entry);
    }
  }
  return out;
}
async function getTracks(env, name) {
  const e = (await getArtists(env, [name])).get(name);
  return e ? e.tracks : [];
}

const ART = /^https:\/\/is\d+-ssl\.mzstatic\.com\/image\/thumb\/[^"'<>\s]+$/;

// Add songs to an artist's list. Lists only grow, and songs are ranked by Apple's own
// popularity score, so the order or selection a browser sends can't change which songs
// count as an artist's hits.
async function saveArtist(env, name, sent) {
  const key = name.toLowerCase();
  const art = new Map();
  for (const item of sent.slice(0, 200)) {
    const [id, url] = Array.isArray(item) ? item : [item];
    if (/^\d{1,12}$/.test(String(id)) && !art.has(String(id))) art.set(String(id), typeof url === "string" && ART.test(url) ? url : "");
  }
  if (!art.size) throw new UserError("No songs sent.");
  const prev = (await getArtists(env, [name])).get(name);
  const byId = new Map(prev ? prev.tracks.map(t => [String(t.id), t]) : []);
  if (prev && Date.now() - prev.fetched < STALE_AFTER && [...art.keys()].every(id => byId.has(id))) return prev.tracks;

  const res = await fetch(LOOKUP + new URLSearchParams({ version: 2, p: "item", caller: "web", id: [...art.keys()].join(",") }), { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("apple lookup " + res.status);
  const found = (await res.json()).results || {};
  for (const [id, url] of art) {
    const r = found[id];
    if (!r || r.kind !== "song" || !r.name || !(r.artistName || "").toLowerCase().includes(key)) continue;
    if (/instrumental|karaoke|commentary|spoken|interview|acapella|a cappella/i.test(r.name + " " + (r.collectionName || ""))) continue;
    const preview = (r.offers || []).flatMap(o => (o.assets || []).map(a => a.preview && a.preview.url)).find(Boolean);
    const k = norm(r.name);
    if (!preview || !k) continue;
    byId.set(id, {
      id: +id, t: r.name, b: baseTitle(r.name), k, a: r.artistName,
      y: +(r.releaseDate || "0").slice(0, 4), p: preview, al: r.collectionName || "",
      art: url || (byId.get(id) || {}).art || "", l: r.url, live: /live/i.test(r.name), pop: r.popularity || 0
    });
  }
  if (!byId.size) return [];
  // a song's popularity is its best version's; rank 1 is the artist's biggest song
  const best = new Map();
  for (const t of byId.values()) best.set(t.k, Math.max(best.get(t.k) || 0, t.pop || 0));
  const rank = new Map([...best].sort((a, b) => b[1] - a[1]).map(([k], i) => [k, i + 1]));
  const tracks = [...byId.values()].map(t => ({ ...t, r: rank.get(t.k) })).sort((a, b) => a.r - b.r);

  const now = Date.now();
  await env.DB.prepare("INSERT OR REPLACE INTO artists (name, fetched, data) VALUES (?, ?, ?)")
    .bind(key, now, JSON.stringify(tracks)).run();
  mem.set(key, { at: now, entry: { fetched: now, tracks } });
  return tracks;
}

class UserError extends Error {}

function readSettings(body) {
  const THIS_YEAR = new Date().getFullYear(); // Workers freeze the clock at module load, so read it per request
  const names = [...new Set((Array.isArray(body.artists) ? body.artists : [])
    .filter(n => typeof n === "string").map(n => n.trim().slice(0, 80)).filter(Boolean))];
  if (!names.length) throw new UserError("Pick at least one artist.");
  if (names.length > MAX_ARTISTS) throw new UserError(`Pick at most ${MAX_ARTISTS} artists.`);
  let [lo, hi] = Array.isArray(body.years) ? body.years.map(Number) : [1965, THIS_YEAR];
  if (!(lo >= 1900 && hi <= THIS_YEAR + 1 && lo <= hi)) throw new UserError("Bad year range.");
  const pop = Math.max(0, Math.min(POP_N.length - 1, Math.floor(Number(body.pop) || 0)));
  return { names, lo, hi, pop };
}

// The multiplier rewards bigger, more varied pools: guessing among 500 songs from
// 12 artists is harder than among 10 songs from one.
function multiplier(size, artistsWithSongs) {
  if (size < MIN_RANKED_POOL) return 0;
  const bySize = Math.min(2, Math.max(0.2, Math.log2(size) / 8));
  const variety = Math.min(1, 0.55 + 0.15 * artistsWithSongs);
  return Math.round(bySize * variety * 20) / 20;
}

async function buildPool(env, s) {
  const found = await getArtists(env, s.names);
  const lists = {}, missing = [], stale = [];
  for (const n of s.names) {
    const e = found.get(n);
    if (!e) { missing.push(n); continue; }
    lists[n] = e.tracks;
    if (Date.now() - e.fetched > STALE_AFTER) stale.push(n);
  }
  const topN = POP_N[s.pop];
  const byKey = new Map();
  const counts = {};
  for (const n of s.names) for (const t of lists[n] || []) {
    if (t.y < s.lo || t.y > s.hi || t.r > topN) continue;
    const prev = byKey.get(t.k);
    // keep one version per song: prefer studio over live, then the earliest release
    if (!prev || (prev.t.live && !t.live) || (prev.t.live === t.live && t.y < prev.t.y)) byKey.set(t.k, { n, t });
  }
  for (const { n } of byKey.values()) counts[n] = (counts[n] || 0) + 1;
  const pool = [...byKey.values()];
  const withSongs = Object.keys(counts).length;
  return { pool, counts, missing, stale, mult: multiplier(pool.length, withSongs) };
}

/* ---------- runs ---------- */
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");

function roundPoints(stage, streak, mult) {
  const bonus = 1 + 0.1 * Math.min(streak, 10);
  return Math.round(STAGE_PTS[stage] * bonus * mult);
}

// Public view of a run. The current song is never included while it is in play.
function view(run, extra = {}) {
  return {
    id: run.id, state: run.state, round: run.round, stage: run.stage,
    guesses: JSON.parse(run.guesses), lives: run.lives, streak: run.streak,
    bestStreak: run.best_streak, correct: run.correct, score: run.score,
    mult: run.mult, poolSize: run.pool_size, ranked: run.mult > 0, submitted: !!run.submitted,
    mode: run.mode || "survival", setId: run.set_id || null, history: JSON.parse(run.history || "[]"),
    last: run.last ? JSON.parse(run.last) : null, ...extra
  };
}

async function loadRun(env, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
}

async function deal(env, run) {
  const pool = JSON.parse(run.pool);
  const used = JSON.parse(run.used);
  let track;
  if (run.mode === "set") {
    // a set's songs are stored in play order and dealt in that order
    const set = await env.DB.prepare("SELECT songs FROM sets WHERE id = ?").bind(run.set_id).first();
    if (!set) throw new Error("set missing");
    track = JSON.parse(set.songs)[used.length];
    if (!track) throw new Error("no songs left to deal");
    used.push(used.length);
  }
  const free = pool.map((_, i) => i).filter(i => !used.includes(i));
  while (!track && free.length) {
    const pick = free.splice(crypto.getRandomValues(new Uint32Array(1))[0] % free.length, 1)[0];
    used.push(pick);
    const [name, id] = pool[pick];
    track = (await getTracks(env, name)).find(t => t.id === id); // gone if its artist list changed
  }
  if (!track) throw new Error("no songs left to deal");
  run.used = JSON.stringify(used);
  run.track = JSON.stringify(track);
  run.round += 1; run.stage = 0; run.guesses = "[]"; run.state = "play";
}

async function save(env, run, expect) {
  // expect = {round, stage, state} the change was based on; stops double-submits racing
  const r = await env.DB.prepare(`UPDATE runs SET track=?, used=?, round=?, stage=?, guesses=?, lives=?, streak=?, best_streak=?,
      correct=?, score=?, last=?, state=?, submitted=?, history=? WHERE id=? AND round=? AND stage=? AND state=?`)
    .bind(run.track, run.used, run.round, run.stage, run.guesses, run.lives, run.streak, run.best_streak,
      run.correct, run.score, run.last, run.state, run.submitted, run.history || "[]", run.id, expect.round, expect.stage, expect.state).run();
  return r.meta.changes === 1;
}

// Autocomplete list for a run: every title in its pool, one entry per song
async function titlesFor(env, run) {
  const pool = JSON.parse(run.pool);
  const byId = new Map();
  for (const e of (await getArtists(env, [...new Set(pool.map(p => p[0]))])).values()) for (const t of e.tracks) byId.set(t.id, t);
  return [...new Map(pool.map(([, id]) => byId.get(id)).filter(Boolean).map(t => [t.k, [t.b, t.a]])).values()];
}

function reveal(t) {
  return { title: t.t, artist: t.a, album: t.al, year: t.y, art: t.art, link: t.l, rank: t.r };
}

async function act(env, id, kind, text) {
  const run = await loadRun(env, id);
  if (!run) return fail("Run not found.", 404);
  if (run.state !== "play") return fail("This round is over.", 409);
  const expect = { round: run.round, stage: run.stage, state: run.state };
  const track = JSON.parse(run.track);
  const guesses = JSON.parse(run.guesses);
  let result;
  if (kind === "guess") {
    text = String(text || "").trim().slice(0, 120);
    if (!text) return fail("Empty guess.");
    result = norm(text) === track.k ? "right" : "wrong";
    guesses.push({ type: result, text });
  } else {
    result = "skip";
    guesses.push({ type: "skip" });
  }
  run.guesses = JSON.stringify(guesses);
  let points = 0, lamp = null;
  if (result === "right") {
    points = roundPoints(run.stage, run.streak, run.mult);
    run.score += points; run.correct += 1; run.streak += 1;
    run.best_streak = Math.max(run.best_streak, run.streak);
    // every 5 in a row refills a lamp
    if (run.streak % 5 === 0 && run.lives < LIVES) { run.lives += 1; lamp = "refilled"; }
    run.state = "reveal";
  } else if (run.stage >= CLIPS.length - 1) {
    run.streak = 0;
    if (run.mode === "set") run.state = "reveal";
    else { run.lives -= 1; lamp = "out"; run.state = run.lives <= 0 ? "over" : "reveal"; }
  } else {
    run.stage += 1;
  }
  // every song plays once, so a small pool can't be memorized and replayed forever
  if (run.state === "reveal" && run.round >= run.pool_size) run.state = "over";
  const done = run.state !== "play";
  if (done) {
    run.last = JSON.stringify({ won: result === "right", stage: expect.stage, points, song: reveal(track) });
    const history = JSON.parse(run.history || "[]");
    history.push({ w: result === "right", s: expect.stage, p: points });
    run.history = JSON.stringify(history);
  }
  if (!(await save(env, run, expect))) return fail("That round already moved on.", 409);
  return json(view(run, { result, points, lamp }));
}

async function clip(env, id, url) {
  const run = await loadRun(env, id);
  if (!run) return new Response("not found", { status: 404, headers: CORS });
  const r = +url.searchParams.get("r"), s = +url.searchParams.get("s");
  if (r !== run.round) return new Response("stale", { status: 409, headers: CORS });
  let seconds;
  if (run.state === "play") {
    if (s > run.stage) return new Response("locked", { status: 403, headers: CORS });
    seconds = CLIPS[s] ?? CLIPS[0];
  } else seconds = 30;
  const track = JSON.parse(run.track);
  const src = await fetch(track.p, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!src.ok) return new Response("upstream", { status: 502, headers: CORS });
  const buf = await src.arrayBuffer();
  let out;
  try { out = trimPreview(buf, seconds); }
  catch { return new Response("bad audio", { status: 502, headers: CORS }); }
  return new Response(out, {
    headers: { "Content-Type": "audio/mp4", "Cache-Control": "no-store", ...CORS }
  });
}

/* ---------- leaderboard ---------- */
const WEEK = 7 * 86400e3;
async function leaderboard(env, period) {
  const since = period === "week" ? Date.now() - WEEK : 0;
  const { results } = await env.DB.prepare(
    "SELECT name, score, correct, best_streak AS bestStreak, pool_size AS poolSize, created FROM scores WHERE created >= ? ORDER BY score DESC, created ASC LIMIT 25"
  ).bind(since).all();
  return results;
}

function cleanName(n) {
  return String(n || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
}

async function submit(env, id, body) {
  const run = await loadRun(env, id);
  if (!run) return fail("Run not found.", 404);
  if (run.state !== "over") return fail("Finish the run first.", 409);
  if (run.mode === "set") return submitSet(env, run, body);
  if (!run.mult) return fail("Practice runs (under " + MIN_RANKED_POOL + " songs) aren't ranked.", 409);
  if (run.submitted) return fail("Already in the Book of Life.", 409);
  if (run.score <= 0) return fail("No score to record.", 409);
  const name = cleanName(body.name);
  if (!name) return fail("Enter a name.");
  const now = Date.now();
  const upd = await env.DB.prepare("UPDATE runs SET submitted = 1 WHERE id = ? AND submitted = 0").bind(id).run();
  if (upd.meta.changes !== 1) return fail("Already in the Book of Life.", 409);
  await env.DB.prepare("INSERT INTO scores (run, name, score, correct, best_streak, pool_size, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, name, run.score, run.correct, run.best_streak, run.pool_size, now).run();
  const higher = await env.DB.prepare("SELECT COUNT(*) AS n FROM scores WHERE score > ?").bind(run.score).first();
  return json({ rank: higher.n + 1, top: await leaderboard(env, "all") });
}

/* ---------- challenge sets ---------- */
// A set is a fixed list of songs, ordered easy to hard by each song's rank within its
// artist, so two people who open the same link hear the same songs in the same order.
function newRun(pool, mult, extra = {}) {
  return {
    id: newId(), created: Date.now(), pool: JSON.stringify(pool.map(({ n, t }) => [n, t.id])),
    pool_size: pool.length, mult, track: null, used: "[]", round: 0, stage: 0, guesses: "[]", lives: LIVES,
    streak: 0, best_streak: 0, correct: 0, score: 0, last: null, state: "play", submitted: 0,
    mode: "survival", set_id: null, history: "[]", ...extra
  };
}
async function insertRun(env, run) {
  await env.DB.prepare(`INSERT INTO runs (id, created, pool, pool_size, mult, track, used, round, stage, guesses, lives, streak,
      best_streak, correct, score, last, state, submitted, mode, set_id, history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(run.id, run.created, run.pool, run.pool_size, run.mult, run.track, run.used, run.round, run.stage, run.guesses, run.lives,
      run.streak, run.best_streak, run.correct, run.score, run.last, run.state, run.submitted, run.mode, run.set_id, run.history).run();
}
async function cleanup(env) {
  await env.DB.prepare("DELETE FROM runs WHERE created < ? AND mode = 'survival'").bind(Date.now() - RUN_TTL).run();
  // set runs live as long as their set so a finished run's compare page keeps working
  await env.DB.prepare("DELETE FROM runs WHERE created < ? AND mode = 'set'").bind(Date.now() - SET_TTL).run();
  await env.DB.prepare("DELETE FROM set_results WHERE created < ?").bind(Date.now() - SET_TTL).run();
  await env.DB.prepare("DELETE FROM sets WHERE created < ?").bind(Date.now() - SET_TTL).run();
}
const shortId = () => { const a = "abcdefghjkmnpqrstuvwxyz23456789", b = crypto.getRandomValues(new Uint8Array(8)); return [...b].map(x => a[x % a.length]).join(""); };

async function createSet(env, body) {
  const s = readSettings(body);
  const size = SET_SIZES.includes(+body.size) ? +body.size : SET_SIZES[0];
  const { pool, mult, missing } = await buildPool(env, s);
  if (pool.length < size) return fail(`Only ${pool.length} songs match. A set of ${size} needs at least ${size}. Widen the years, loosen popularity, or add artists.`);
  // spread the draw across artists, then order easy to hard by rank within the artist
  const byArtist = new Map();
  for (const e of pool) { if (!byArtist.has(e.n)) byArtist.set(e.n, []); byArtist.get(e.n).push(e); }
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const lists = shuffle([...byArtist.values()].map(shuffle));
  const chosen = [];
  for (let k = 0; chosen.length < size; k++) { const l = lists[k % lists.length]; if (l.length) chosen.push(l.pop()); if (!lists.some(x => x.length)) break; }
  chosen.sort((a, b) => a.t.r - b.t.r || a.t.pop - b.t.pop);
  const id = shortId();
  await env.DB.prepare("INSERT INTO sets (id, created, songs, size, mult, pool, settings, creator, plays) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)")
    .bind(id, Date.now(), JSON.stringify(chosen.map(({ t }) => t)), chosen.length, mult, JSON.stringify(pool.map(({ n, t }) => [n, t.id])),
      JSON.stringify({ artists: s.names, years: [s.lo, s.hi], pop: s.pop })).run();
  return json({ id, size: chosen.length, mult, missing });
}
async function loadSet(env, id) {
  if (!/^[a-z0-9]{8}$/.test(id)) return null;
  return env.DB.prepare("SELECT * FROM sets WHERE id = ?").bind(id).first();
}
async function setResults(env, id) {
  const { results } = await env.DB.prepare("SELECT run, name, score, correct, detail, created FROM set_results WHERE set_id = ? ORDER BY score DESC, created ASC LIMIT 50").bind(id).all();
  return results.map(r => ({ ...r, detail: JSON.parse(r.detail) }));
}
async function getSet(env, id, url) {
  const set = await loadSet(env, id);
  if (!set) return fail("That challenge link doesn't exist or has expired.", 404);
  const songs = JSON.parse(set.songs);
  const out = { id: set.id, size: set.size, mult: set.mult, plays: set.plays, creator: set.creator, created: set.created,
    settings: JSON.parse(set.settings) };
  // scores and song titles are only revealed to someone who has finished the set;
  // before that, a player learns only who has played it
  const runId = url.searchParams.get("run");
  const run = runId ? await loadRun(env, runId) : null;
  const finished = !!(run && run.set_id === id && run.state === "over");
  const results = await setResults(env, id);
  out.results = finished ? results : results.map(r => ({ run: r.run, name: r.name, created: r.created }));
  if (finished) out.songs = songs.map(reveal);
  return json(out);
}
async function startSetRun(env, setId) {
  const set = await loadSet(env, setId);
  if (!set) return fail("That challenge link doesn't exist or has expired.", 404);
  const pool = JSON.parse(set.pool).map(([n, id]) => ({ n, t: { id } }));
  const run = newRun(pool, set.mult, { mode: "set", set_id: set.id, pool_size: set.size, lives: 99 });
  await deal(env, run);
  await insertRun(env, run);
  await env.DB.prepare("UPDATE sets SET plays = plays + 1 WHERE id = ?").bind(set.id).run();
  const titles = await titlesFor(env, run);
  return json(view(run, { titles, counts: {}, missing: [], setSize: set.size }));
}
async function submitSet(env, run, body) {
  if (run.submitted) return fail("Already recorded.", 409);
  const name = cleanName(body.name);
  if (!name) return fail("Enter a name.");
  const upd = await env.DB.prepare("UPDATE runs SET submitted = 1 WHERE id = ? AND submitted = 0").bind(run.id).run();
  if (upd.meta.changes !== 1) return fail("Already recorded.", 409);
  await env.DB.prepare("INSERT INTO set_results (run, set_id, name, score, correct, detail, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(run.id, run.set_id, name, run.score, run.correct, run.history || "[]", Date.now()).run();
  await env.DB.prepare("UPDATE sets SET creator = COALESCE(creator, ?) WHERE id = ?").bind(name, run.set_id).run();
  const results = await setResults(env, run.set_id);
  return json({ rank: results.findIndex(r => r.run === run.id) + 1, results });
}

/* ---------- router ---------- */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try {
      if (parts[0] === "pool" && req.method === "POST") {
        const s = readSettings(body);
        const { pool, counts, missing, stale, mult } = await buildPool(env, s);
        return json({ size: pool.length, counts, missing, stale, mult, minRanked: MIN_RANKED_POOL });
      }
      if (parts[0] === "artists" && req.method === "POST") {
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
        if (!name || !Array.isArray(body.tracks)) return fail("Send an artist name and tracks.");
        const tracks = await saveArtist(env, name, body.tracks);
        return json({ name, songs: tracks.length });
      }
      if (parts[0] === "sets" && parts.length === 1 && req.method === "POST") return createSet(env, body);
      if (parts[0] === "sets" && parts[1] && req.method === "GET") return getSet(env, parts[1], url);
      if (parts[0] === "runs" && parts.length === 1 && req.method === "POST") {
        if (typeof body.set === "string") return startSetRun(env, body.set);
        const s = readSettings(body);
        const { pool, counts, missing, mult } = await buildPool(env, s);
        if (!pool.length) return fail("No songs match those settings. Widen the years, loosen popularity, or add artists.");
        const run = newRun(pool, mult);
        await deal(env, run);
        await insertRun(env, run);
        if (Math.random() < 0.05) ctx.waitUntil(cleanup(env));
        const titles = [...new Map(pool.map(({ t }) => [t.k, [t.b, t.a]])).values()];
        return json(view(run, { titles, counts, missing }));
      }
      if (parts[0] === "runs" && parts[1]) {
        const id = parts[1];
        if (parts[2] === "clip" && req.method === "GET") return clip(env, id, url);
        if (parts[2] === "guess" && req.method === "POST") return act(env, id, "guess", body.text);
        if (parts[2] === "skip" && req.method === "POST") return act(env, id, "skip");
        if (parts[2] === "next" && req.method === "POST") {
          const run = await loadRun(env, id);
          if (!run) return fail("Run not found.", 404);
          if (run.state !== "reveal") return fail(run.state === "over" ? "The run is over." : "Finish this round first.", 409);
          const expect = { round: run.round, stage: run.stage, state: run.state };
          await deal(env, run);
          if (!(await save(env, run, expect))) return fail("Already dealt.", 409);
          return json(view(run));
        }
        if (parts[2] === "submit" && req.method === "POST") return submit(env, id, body);
        if (!parts[2] && req.method === "GET") {
          const run = await loadRun(env, id);
          if (!run) return fail("Run not found.", 404);
          return json(view(run, url.searchParams.has("titles") ? { titles: await titlesFor(env, run) } : {}));
        }
      }
      if (parts[0] === "leaderboard" && req.method === "GET") {
        return json({ period: url.searchParams.get("period") === "week" ? "week" : "all", top: await leaderboard(env, url.searchParams.get("period")) });
      }
      return fail("Not found.", 404);
    } catch (e) {
      if (e instanceof UserError) return fail(e.message);
      console.error(e);
      return fail("Server error.", 500);
    }
  }
};
