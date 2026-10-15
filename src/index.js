// Cloudflare Worker for the IceDogs portal.
//  - "/"               -> serves test.html
//  - "/api/live-game"  -> today's IceDogs game with live score/period/clock
//  - everything else   -> static assets

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/live-game") {
      if (url.searchParams.get("debug") === "1") return handleLiveGameDebug();
      return handleLiveGame(request);
    }

    if (url.pathname === "/" || url.pathname === "") {
      const newUrl = new URL(request.url);
      newUrl.pathname = "/test.html";
      return env.ASSETS.fetch(new Request(newUrl.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};


// ---- Live game ----
// Returns { game: null } when there's no IceDogs game today, otherwise
// { game: { state: "pre"|"live"|"final", ... , source } }.
//
// Data sources (HockeyTech):
//  1. modulekit "schedule" view — finds today's game, teams, venue. Only
//     refreshed every few minutes, so too slow for live scores on its own.
//  2. gamecentre "clock" tab (feed=gc&tab=clock) — near real-time score,
//     period and clock. Any field it doesn't provide falls back to the
//     schedule value, so it can never make the strip worse.

const API_KEY = "2976319eb44abe94";
const CLIENT_CODE = "ohl";
const TEAM_ID = "20";
const LEAGUE_ID = "1";
const SEASON_ID = "88";
const TIMEZONE = "America/Toronto";
const CACHE_MS = 5000;
const FEED = "https://lscluster.hockeytech.com/feed/index.php";

let liveCache = null; // { at, body } — per Worker instance

async function handleLiveGame(request) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers });

  try {
    if (!liveCache || Date.now() - liveCache.at > CACHE_MS) {
      liveCache = { at: Date.now(), body: await buildLiveBody() };
    }
    return new Response(liveCache.body, { headers });
  } catch (e) {
    return new Response(JSON.stringify({ game: null, error: e.message }), { status: 200, headers });
  }
}

function str(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function num(v) {
  const n = Number(str(v));
  return isNaN(n) ? 0 : n;
}

// First non-empty value among candidate field names (HockeyTech naming varies by feed).
function pick(obj, keys) {
  if (!obj) return "";
  for (const k of keys) {
    const v = str(obj[k]);
    if (v !== "") return v;
  }
  return "";
}

function todayInToronto() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function periodLabel(period, intermission, final, overtime, shootout) {
  if (final) return shootout ? "Final/SO" : (overtime ? "Final/OT" : "Final");
  const names = { 1: "1st", 2: "2nd", 3: "3rd", 4: "OT", 5: "SO" };
  const name = names[period] || (period > 5 ? (period - 3) + "OT" : "");
  if (intermission) return name ? name + " INT" : "Intermission";
  return name;
}

function clockLabel(raw) {
  // "00:12:34" -> "12:34"; "12:34" -> "12:34"; "00:00:00" -> ""
  const parts = raw.split(":").map((p) => parseInt(p, 10));
  if (parts.length < 2 || parts.some(isNaN)) return "";
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  const totalMin = h * 60 + m;
  if (totalMin === 0 && s === 0) return "";
  return totalMin + ":" + String(s).padStart(2, "0");
}

// Clock string -> total seconds ("00:12:34" -> 754). -1 if unparseable.
function clockSeconds(raw) {
  const parts = str(raw).split(":").map((p) => parseInt(p, 10));
  if (parts.length < 2 || parts.some(isNaN)) return -1;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return h * 3600 + m * 60 + s;
}

// ---- Intermission timing ----
// HockeyTech has no intermission flag or clock: at the end of a period it just
// shows game_clock "00:00:00" while the game is still in progress. The first time
// the Worker sees that for a given period, it records the time, so everyone gets
// the same countdown (not a fresh 18:00 for whoever loads the page mid-break).
// Stored in Cloudflare's cache (shared by visitors) plus memory as a backup.
const INTERMISSION_MS = 18 * 60 * 1000;
const intermissionMem = {};

async function intermissionStart(gameId, period) {
  const key = gameId + "-" + period;
  if (intermissionMem[key]) return intermissionMem[key];
  const cacheKey = new Request("https://icedogofficials.ca/__intermission/" + key);
  let start = null;
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) start = Number(await hit.text());
  } catch (_e) { /* cache unavailable — fall back to memory */ }
  if (!start || isNaN(start)) {
    start = Date.now();
    try {
      await caches.default.put(cacheKey, new Response(String(start), { headers: { "Cache-Control": "max-age=7200" } }));
    } catch (_e) { /* ignore */ }
  }
  intermissionMem[key] = start;
  return start;
}

async function fetchJson(url) {
  // Cache-buster + no-store so HockeyTech/CDN caches never serve stale data.
  const res = await fetch(url + "&_=" + Date.now(), { cf: { cacheTtl: 0, cacheEverything: false }, headers: { "Cache-Control": "no-cache" } });
  let text = await res.text();
  const cbMatch = text.match(/^[^(]+\((.+)\);?\s*$/s);
  if (cbMatch) text = cbMatch[1];
  return JSON.parse(text);
}

// Near real-time clock data for one game. Returns null on any failure.
async function fetchClock(gameId) {
  try {
    const url = `${FEED}?feed=gc&tab=clock&key=${API_KEY}&client_code=${CLIENT_CODE}&lang_code=en&fmt=json&game_id=${gameId}`;
    const json = await fetchJson(url);
    const clock = json && json.GC && json.GC.Clock;
    return clock && typeof clock === "object" ? clock : null;
  } catch (_e) {
    return null;
  }
}

async function buildLiveBody() {
  const schedUrl = `${FEED}?feed=modulekit&view=schedule&key=${API_KEY}&fmt=json&client_code=${CLIENT_CODE}&lang=en&season_id=${SEASON_ID}&team_id=${TEAM_ID}&league_id=${LEAGUE_ID}`;
  const json = await fetchJson(schedUrl);
  const games = (json && json.SiteKit && json.SiteKit.Schedule) || [];

  const today = todayInToronto();
  const g = games.find((x) => str(x.date_played).slice(0, 10) === today);
  if (!g) return JSON.stringify({ game: null });

  const gameId = str(g.game_id);
  const isHome = str(g.home_team) === TEAM_ID;

  // Schedule values (slow) — the fallback for every field.
  let started = str(g.started) === "1";
  let final = str(g.final) === "1";
  let intermission = str(g.intermission) === "1";
  let overtime = str(g.overtime) === "1";
  let shootout = str(g.shootout) === "1";
  let homeScore = num(g.home_goal_count);
  let awayScore = num(g.visiting_goal_count);
  let period = num(g.period);
  let rawClock = str(g.game_clock);
  let source = "schedule";

  // Check the fast clock feed from scheduled puck drop onward, even if the slow
  // schedule feed hasn't flagged the game as started yet.
  const puckDrop = Date.parse(str(g.GameDateISO8601));
  const pastPuckDrop = !isNaN(puckDrop) && Date.now() >= puckDrop - 5 * 60 * 1000;

  if (gameId && (started || pastPuckDrop) && !final) {
    const c = await fetchClock(gameId);
    if (c) {
      const homeTeam = c.home_team || {};
      const awayTeam = c.visiting_team || {};
      const cHome = pick(c, ["home_goal_count", "home_score", "home_goals"]) || pick(homeTeam, ["goal_count", "goals", "score"]);
      const cAway = pick(c, ["visiting_goal_count", "visiting_score", "visiting_goals"]) || pick(awayTeam, ["goal_count", "goals", "score"]);
      const cPeriod = pick(c, ["period_id", "period", "period_num"]);
      const cClock = pick(c, ["running_clock", "game_clock", "clock", "time"]);
      const cStarted = pick(c, ["started", "game_started"]);
      const cFinal = pick(c, ["final", "game_finished", "finished"]);
      const cInt = pick(c, ["intermission", "in_intermission"]);
      const cStatus = pick(c, ["status", "game_status", "progress"]).toLowerCase();

      if (cHome !== "" && cAway !== "") { homeScore = num(cHome); awayScore = num(cAway); source = "clock"; }
      if (cPeriod !== "") period = num(cPeriod);
      if (cClock !== "") rawClock = cClock;
      if (cStarted === "1" || cHome !== "") started = true;
      if (cFinal === "1" || cStatus.includes("final")) final = true;
      if (cInt !== "") intermission = cInt === "1";
      else if (cStatus.includes("intermission")) intermission = true;
      if (period >= 4) overtime = true;
      if (period >= 5 && (cStatus.includes("shootout") || pick(c, ["shootout"]) === "1")) shootout = true;
    }
  }

  let state = final ? "final" : (started ? "live" : "pre");
  let periodText = state === "pre" ? "" : periodLabel(period, intermission, final, overtime, shootout);
  let clockText = state === "live" && !intermission ? clockLabel(rawClock) : "";
  let intermissionEndsAt = null;

  // End of a period: clock at 0:00 while the game is still live.
  if (state === "live" && period >= 1 && (clockSeconds(rawClock) === 0 || intermission)) {
    const ord = { 1: "1st", 2: "2nd", 3: "3rd" }[period] || (period === 4 ? "OT" : period + "th");
    if (period >= 3 && homeScore !== awayScore) {
      // Regulation (or OT) over with a winner — show Final before the feed's
      // own final flag catches up.
      state = "final";
      periodText = period >= 4 ? "Final/OT" : "Final";
      clockText = "";
    } else {
      periodText = "End of " + ord;
      clockText = "";
      if (period <= 2) intermissionEndsAt = (await intermissionStart(gameId, period)) + INTERMISSION_MS;
    }
  }

  return JSON.stringify({
    game: {
      state,
      gameId,
      isHome,
      homeId: str(g.home_team),
      awayId: str(g.visiting_team),
      homeName: str(g.home_team_name),
      awayName: str(g.visiting_team_name),
      homeCode: str(g.home_team_code),
      awayCode: str(g.visiting_team_code),
      homeScore: state === "pre" ? null : homeScore,
      awayScore: state === "pre" ? null : awayScore,
      period: periodText,
      clock: clockText,
      intermissionEndsAt,
      serverNow: Date.now(),
      startTime: str(g.scheduled_time),
      venue: str(g.venue_name),
      source,
    },
  });
}


// Debug: raw HockeyTech gamecentre clock data for today's game (no caching).
// Used to check field names during a live game: /api/live-game?debug=1
async function handleLiveGameDebug() {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  try {
    const schedUrl = `${FEED}?feed=modulekit&view=schedule&key=${API_KEY}&fmt=json&client_code=${CLIENT_CODE}&lang=en&season_id=${SEASON_ID}&team_id=${TEAM_ID}&league_id=${LEAGUE_ID}`;
    const json = await fetchJson(schedUrl);
    const games = (json && json.SiteKit && json.SiteKit.Schedule) || [];
    const today = todayInToronto();
    const g = games.find((x) => str(x.date_played).slice(0, 10) === today);
    if (!g) return new Response(JSON.stringify({ today, game: null }), { headers });
    const clock = await fetchClock(str(g.game_id));
    return new Response(JSON.stringify({ gameId: str(g.game_id), clock }, null, 1), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { headers });
  }
}
