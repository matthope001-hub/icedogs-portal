// supabase/functions/sync-draft-picks/index.ts
// Reads the IceDogs' future draft picks from the public "OHL Draft Pick
// Database" Google Sheet (maintained by @GeneralsUpdates) and stores them in the
// draft_picks table for the Season tab. Run nightly by pg_cron.
//
// Picks tab: for each team, a row with the team name, then one row per draft
// year: year, then 14 cells for rounds 2-15. A cell holds one or more picks
// ("4th" = own pick, "KGN 4th" = acquired from Kingston, "*" = conditional),
// separated by line breaks or runs of spaces; "---" means no pick that round.
// First-round picks can't be traded, so every year gets the IceDogs' own 1st.
// Rounds where the IceDogs' own pick is gone are stored as traded_away rows.
//
// Trade details: the season trade tabs ("2026-27 Trade", "2025-26 Trades", ...)
// list Date, Team, what it gave, Team, what it gave, Notes, with picks written
// as "KGN 4 2028". For every acquired or traded-away pick, the most recent trade
// where the IceDogs moved that pick is attached as `details.trade`. Notes from
// the Conditions tab are attached to conditional picks as `details.condition`.
// If the extra tabs can't be read, picks still sync without details.
//
// Safe replace: new rows are inserted first, and older rows are only removed
// once that succeeds, so a bad fetch or parse never empties the table.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SHEET_ID = "17oLllG_g5Rlo_3-cSpnTs8hw3s8cjbIftz26RYiQPdI";
const PICKS_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=843470933`;
const TEAM_NAME = "Niagara IceDogs";
const OUR_ABBR = "NIA";
const CONDITIONS_TAB = "Conditions";
// Newest season first; tab names as they appear in the sheet.
const TRADE_TABS = ["2026-27 Trade", "2025-26 Trades", "2024-25 Trades", "2023-24 Trades", "2022-23 Trades"];

// Team abbreviations differ between tabs (e.g. NIAG vs NIA, SOO vs SSM).
const ABBR_ALIASES: Record<string, string> = { NIAG: "NIA", NIA: "NIA", SOO: "SSM", SSM: "SSM" };
const normAbbr = (a: string) => ABBR_ALIASES[a.toUpperCase()] || a.toUpperCase();

const OHL_TEAMS = [
  "Barrie Colts", "Brampton Steelheads", "Brantford Bulldogs", "Erie Otters", "Flint Firebirds",
  "Guelph Storm", "Kingston Frontenacs", "Kitchener Rangers", "London Knights", "Niagara IceDogs",
  "North Bay Battalion", "Oshawa Generals", "Ottawa 67's", "Owen Sound Attack", "Peterborough Petes",
  "Saginaw Spirit", "Sarnia Sting", "Soo Greyhounds", "Sudbury Wolves", "Windsor Spitfires",
];

function getServiceRoleKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const secretsJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretsJson) {
    try {
      const parsed = JSON.parse(secretsJson);
      const val = parsed.service_role || parsed.SERVICE_ROLE || Object.values(parsed)[0];
      if (val) return val as string;
    } catch (_e) { /* fall through */ }
  }
  throw new Error("No service role key found in environment");
}

const supabase = createClient(SUPABASE_URL, getServiceRoleKey());

// Minimal RFC-4180 CSV parser (handles quoted fields with commas/newlines).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchCsv(url: string): Promise<string[][]> {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCsv(await res.text());
}

// Any tab by name (gviz endpoint; no gid needed).
function tabUrl(name: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(name)}`;
}

type Trade = { date: string; partner: string; got: string[]; gave: string[]; note: string };
type Pick = {
  year: number; round: number; from_team: string | null; conditional: boolean;
  traded_away: boolean; label: string; details: { trade?: Trade; condition?: string } | null;
};

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function parseTeamPicks(rows: string[][]): Pick[] {
  const start = rows.findIndex((r) => (r[0] || "").trim() === TEAM_NAME);
  if (start < 0) throw new Error(`"${TEAM_NAME}" not found in Picks tab`);
  const picks: Pick[] = [];
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!/^\d{4}$/.test((r[0] || "").trim())) break; // end of the team's block
    const year = Number(r[0].trim());
    const yearPicks: Pick[] = [{ year, round: 1, from_team: null, conditional: false, traded_away: false, label: "1st", details: null }];
    for (let col = 1; col < r.length; col++) {
      const cell = (r[col] || "").trim();
      if (!cell || cell === "---") continue;
      for (const raw of cell.split(/\n|\s{2,}/)) {
        const tok = raw.trim();
        if (!tok || tok === "---") continue;
        const m = tok.match(/^(?:([A-Za-z]{2,5})\s+)?(\d{1,2})(?:st|nd|rd|th)(\*)?$/);
        if (!m) continue; // ignore anything unexpected rather than guess
        yearPicks.push({
          year, round: Number(m[2]), from_team: m[1] ? m[1].toUpperCase() : null,
          conditional: !!m[3], traded_away: false, label: tok, details: null,
        });
      }
    }
    // Rounds 2-15 where the IceDogs no longer hold their own pick.
    for (let round = 2; round <= 15; round++) {
      if (!yearPicks.some((p) => p.round === round && !p.from_team)) {
        yearPicks.push({ year, round, from_team: null, conditional: false, traded_away: true, label: ordinal(round), details: null });
      }
    }
    picks.push(...yearPicks);
  }
  return picks;
}

// "Oct. 15" in the 2026-27 tab -> "Oct 15, 2026" (Sep-Dec = first year, Jan-Aug = second).
function tradeDate(raw: string, tab: string): string {
  const m = tab.match(/(\d{4})-(\d{2})/);
  const d = raw.replace(/\./g, "").trim();
  if (!m || !d) return d;
  const startYear = Number(m[1]);
  const mon = d.slice(0, 3).toLowerCase();
  const firstHalf = ["jun", "jul", "aug", "sep", "oct", "nov", "dec"].includes(mon);
  return `${d}, ${firstHalf ? startYear : startYear + 1}`;
}

const splitItems = (cell: string) => (cell || "").split(/\n/).map((s) => s.trim()).filter(Boolean);
const pickKey = (abbr: string, round: number, year: number) => `${normAbbr(abbr)} ${round} ${year}`;
function itemKey(item: string): string | null {
  const m = item.replace(/\*$/, "").trim().match(/^([A-Za-z]{2,5})\s+(\d{1,2})\s+(\d{4})$/);
  return m ? pickKey(m[1], Number(m[2]), Number(m[3])) : null;
}

// All trades involving the IceDogs, newest first, split into what they got/gave.
async function loadOurTrades(): Promise<Trade[]> {
  const trades: Trade[] = [];
  for (const tab of TRADE_TABS) {
    let rows: string[][];
    try { rows = await fetchCsv(tabUrl(tab)); } catch (_e) { continue; }
    for (const r of rows) {
      const [date, teamA, giveA, , teamB, giveB, note] = r.map((c) => (c || "").trim());
      if (!teamA || !teamB || teamA === "Team") continue;
      const aUs = normAbbr(teamA) === OUR_ABBR, bUs = normAbbr(teamB) === OUR_ABBR;
      if (!aUs && !bUs) continue;
      trades.push({
        date: tradeDate(date, tab),
        partner: aUs ? normAbbr(teamB) : normAbbr(teamA),
        gave: splitItems(aUs ? giveA : giveB),
        got: splitItems(aUs ? giveB : giveA),
        note: note || "",
      });
    }
  }
  return trades;
}

// Lines of the IceDogs section of the Conditions tab.
async function loadOurConditions(): Promise<string[]> {
  const rows = await fetchCsv(tabUrl(CONDITIONS_TAB));
  const lines = rows.map((r) => (r[0] || "").trim());
  const start = lines.indexOf(TEAM_NAME);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (OHL_TEAMS.includes(lines[i])) break;
    if (lines[i]) out.push(lines[i]);
  }
  return out;
}

function attachDetails(picks: Pick[], trades: Trade[], conditions: string[]) {
  for (const p of picks) {
    const details: { trade?: Trade; condition?: string } = {};
    if (p.from_team || p.traded_away) {
      const key = pickKey(p.from_team || OUR_ABBR, p.round, p.year);
      const side = p.traded_away ? "gave" : "got";
      const t = trades.find((tr) => tr[side].some((it) => itemKey(it) === key));
      if (t) details.trade = t;
    }
    // Condition notes mention picks like "KGN 5 2029" / "NIA 7 2028".
    const abbr = normAbbr(p.from_team || OUR_ABBR);
    const re = new RegExp(`\\b(${Object.keys(ABBR_ALIASES).filter((k) => ABBR_ALIASES[k] === abbr).concat(abbr).join("|")})\\s+${p.round}\\s+('?${String(p.year).slice(2)}|${p.year})\\b`, "i");
    const cond = conditions.filter((l) => re.test(l));
    if (cond.length && (p.conditional || p.traded_away)) details.condition = cond.join(" ");
    p.details = Object.keys(details).length ? details : null;
  }
}

Deno.serve(async (_req) => {
  const headers = { "Content-Type": "application/json" };
  try {
    const picks = parseTeamPicks(await fetchCsv(PICKS_CSV_URL));
    const years = new Set(picks.map((p) => p.year));
    const held = picks.filter((p) => !p.traded_away);
    // Sanity check: expect a few years with several picks each.
    if (years.size < 2 || held.length < years.size * 5) {
      throw new Error(`Parse looks wrong (${held.length} picks over ${years.size} years) - table left unchanged`);
    }

    let trades: Trade[] = [], conditions: string[] = [], detailNote = "";
    try { trades = await loadOurTrades(); } catch (e) { detailNote += "trades: " + e.message + " "; }
    try { conditions = await loadOurConditions(); } catch (e) { detailNote += "conditions: " + e.message; }
    attachDetails(picks, trades, conditions);

    const syncedAt = new Date().toISOString();
    const { error: insErr } = await supabase.from("draft_picks").insert(picks.map((p) => ({ ...p, synced_at: syncedAt })));
    if (insErr) throw insErr;
    const { error: delErr } = await supabase.from("draft_picks").delete().lt("synced_at", syncedAt);
    if (delErr) throw delErr;

    await supabase.from("app_settings").upsert({ key: "last_draft_picks_sync", value: syncedAt }, { onConflict: "key" });
    const moved = picks.filter((p) => p.from_team || p.traded_away);
    return new Response(JSON.stringify({
      success: true,
      picks: held.length,
      tradedAway: picks.length - held.length,
      tradesFound: trades.length,
      withTradeDetails: moved.filter((p) => p.details?.trade).length + "/" + moved.length,
      missingTrade: moved.filter((p) => !p.details?.trade).map((p) => `${p.year} ${p.traded_away ? "own " : ""}${p.label}`),
      conditionLines: conditions.length,
      note: detailNote || undefined,
    }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers });
  }
});
