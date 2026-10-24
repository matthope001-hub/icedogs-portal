// Cloudflare Worker for the IceDogs portal.
//  - "/"               -> serves test.html
//  - "/api/live-game"  -> today's IceDogs game with live score/period/clock
//  - "/api/ohl-info"   -> OHL news, suspensions and IceDogs transactions (Info tab)
//  - everything else   -> static assets

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Never serve hidden files/folders (.git, .env, .assetsignore, ...) —
    // scanners probe for these constantly.
    if (/(^|\/)\.[^/]/.test(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/api/live-game") {
      if (url.searchParams.get("debug") === "1") return handleLiveGameDebug();
      return handleLiveGame(request);
    }

    if (url.pathname === "/api/ohl-info") {
      return handleOhlInfo(url.searchParams.get("refresh") === "1");
    }

    if (url.pathname === "/" || url.pathname === "") {
      const newUrl = new URL(request.url);
      newUrl.pathname = "/test.html";
      return noStaleCode(await env.ASSETS.fetch(new Request(newUrl.toString(), request)));
    }

    return noStaleCode(await env.ASSETS.fetch(request), url.pathname);
  }
};

// HTML, JS and CSS must always be revalidated so phones never keep running an
// old version after a deploy. "no-cache" still allows a quick 304 when unchanged.
function noStaleCode(res, path) {
  const type = res.headers.get("Content-Type") || "";
  const isCode = !path || /\.(html|js|css)$/i.test(path) || type.includes("text/html");
  if (!isCode) return res;
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-cache");
  return out;
}


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
// that's seen for a period, the start time is saved in Supabase
// (live_intermissions, via record_intermission) so it's one fixed 18-minute
// countdown for everyone that a refresh can't reset. A Supabase cron job pings
// this endpoint every 15s on game days, so it starts even if nobody is watching.
// Cloudflare's cache is only a fallback if Supabase can't be reached.
const INTERMISSION_MS = 18 * 60 * 1000;
const SB_URL = "https://fcehtovermlilpvwcksl.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjZWh0b3Zlcm1saWxwdndja3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTQzMDQsImV4cCI6MjEwMTQzMDMwNH0.Gllg9p2j3Bxrv1bpyNFBQMQtYQfWXDcxF9H7njyBksU";
const intermissionMem = {};

async function intermissionStart(gameId, period) {
  const key = gameId + "-" + period;
  if (intermissionMem[key]) return intermissionMem[key];
  let start = null;
  try {
    const res = await fetch(SB_URL + "/rest/v1/rpc/record_intermission", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB_ANON, Authorization: "Bearer " + SB_ANON },
      body: JSON.stringify({ p_game_id: String(gameId), p_period: period }),
    });
    if (res.ok) start = Date.parse(await res.json());
  } catch (_e) { /* fall back to cache */ }
  const cacheKey = new Request("https://icedogofficials.ca/__intermission/" + key);
  if (!start || isNaN(start)) {
    try {
      const hit = await caches.default.match(cacheKey);
      if (hit) start = Number(await hit.text());
    } catch (_e) { /* cache unavailable */ }
  }
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


// ---- OHL info (Info tab) ----
// Reads two public CHL pages and returns JSON:
//  - Media Notes (chl.ca/ohl/media-notes/): the SUSPENSIONS table and the
//    RECENT TRANSACTIONS table (Date, Team, gave, To, Team, gave).
//  - IceDogs news RSS (chl.ca/ohl-icedogs/feed/): latest team stories.
// Cached for 30 minutes in Cloudflare's cache so visitors don't hit chl.ca.
// Each source is independent: if one fails the other still comes back.

const MEDIA_NOTES_URL = "https://chl.ca/ohl/media-notes/";
const OHL_RSS_URL = "https://chl.ca/ohl-icedogs/feed/";
const INFO_CACHE_SECONDS = 1800;

async function handleOhlInfo(forceRefresh) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  const cacheKey = new Request("https://icedogofficials.ca/__cache/ohl-info-v2");
  if (!forceRefresh) {
    try {
      const hit = await caches.default.match(cacheKey);
      if (hit) return new Response(await hit.text(), { headers });
    } catch (_e) { /* no cache available */ }
  }

  const [notes, news] = await Promise.all([
    fetchMediaNotes().catch((e) => ({ error: e.message })),
    fetchOhlNews().catch((e) => ({ error: e.message })),
  ]);
  const body = JSON.stringify({ fetched_at: new Date().toISOString(), ...notes, news: news.items || [], news_error: news.error });

  try {
    await caches.default.put(cacheKey, new Response(body, { headers: { "Cache-Control": "max-age=" + INFO_CACHE_SECONDS } }));
  } catch (_e) { /* ignore */ }
  return new Response(body, { headers });
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");
}

// Cell HTML -> list of text lines (line breaks inside a cell separate items).
function cellLines(html) {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, ""))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// First <table> after a heading -> rows of cells (each cell = list of lines).
function tableAfter(html, heading) {
  const at = html.indexOf(heading);
  if (at < 0) return [];
  const start = html.indexOf("<table", at);
  const end = html.indexOf("</table>", start);
  if (start < 0 || end < 0) return [];
  const rows = [];
  for (const tr of html.slice(start, end).split(/<tr[^>]*>/i).slice(1)) {
    const cells = [];
    const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = re.exec(tr))) cells.push(cellLines(m[1]));
    if (cells.some((c) => c.length)) rows.push(cells);
  }
  return rows;
}

const isIceDogs = (t) => /^(NIAG?|NIAGARA)$/i.test(String(t || "").trim());

async function fetchMediaNotes() {
  const res = await fetch(MEDIA_NOTES_URL, { headers: { "User-Agent": "Mozilla/5.0 IceDogsOfficialsPortal" } });
  if (!res.ok) throw new Error("Media notes HTTP " + res.status);
  const html = await res.text();

  const suspensions = tableAfter(html, "SUSPENSIONS")
    .filter((r) => (r[0] || [])[0] && !/^date$/i.test(r[0][0]))
    .map((r) => ({
      date: (r[0] || []).join(" "), player: (r[1] || []).join(" "), team: (r[2] || []).join(" "),
      discipline: (r[3] || []).join(" "), eligible: (r[4] || []).join(" "),
    }))
    .map((s) => ({ ...s, icedogs: isIceDogs(s.team) }));

  const transactions = tableAfter(html, "RECENT TRANSACTIONS")
    .filter((r) => (r[0] || [])[0] && !/^date$/i.test(r[0][0]) && r.length >= 6)
    .map((r) => ({ date: (r[0] || []).join(" "), teamA: (r[1] || []).join(" "), gaveA: r[2] || [], teamB: (r[4] || []).join(" "), gaveB: r[5] || [] }));

  // IceDogs view of each transaction they were part of.
  const icedogsTransactions = transactions
    .filter((t) => isIceDogs(t.teamA) || isIceDogs(t.teamB))
    .map((t) => {
      const weAreA = isIceDogs(t.teamA);
      return { date: t.date, partner: weAreA ? t.teamB : t.teamA, gave: weAreA ? t.gaveA : t.gaveB, got: weAreA ? t.gaveB : t.gaveA };
    });

  return { suspensions, icedogs_transactions: icedogsTransactions, transactions_total: transactions.length };
}

async function fetchOhlNews() {
  const res = await fetch(OHL_RSS_URL, { headers: { "User-Agent": "Mozilla/5.0 IceDogsOfficialsPortal" } });
  if (!res.ok) throw new Error("IceDogs news HTTP " + res.status);
  const xml = await res.text();
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 12) {
    const block = m[1];
    const tag = (name) => { const t = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">")); return t ? decodeEntities(t[1]).trim() : ""; };
    const img = block.match(/<enclosure[^>]*url="([^"]+)"/);
    const title = tag("title");
    const description = tag("description").replace(/<[^>]+>/g, "").trim();
    items.push({
      title, link: tag("link"), date: tag("pubDate"), summary: description.slice(0, 220),
      image: img ? img[1] : "",
    });
  }
  return { items };
}
