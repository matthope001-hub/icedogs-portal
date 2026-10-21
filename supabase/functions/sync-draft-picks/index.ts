// supabase/functions/sync-draft-picks/index.ts
// Reads the IceDogs' future draft picks from the public "OHL Draft Pick
// Database" Google Sheet (Picks tab, maintained by @GeneralsUpdates) and stores
// them in the draft_picks table for the Season tab. Run nightly by pg_cron.
//
// Sheet layout for each team: a row with the team name, then one row per draft
// year: year, then 14 cells for rounds 2-15. A cell holds one or more picks
// ("4th" = own pick, "KGN 4th" = acquired from Kingston, "*" = conditional),
// separated by line breaks or runs of spaces; "---" means no pick that round.
// First-round picks can't be traded, so they aren't in the sheet - every year
// gets the IceDogs' own 1st added here.
//
// Safe replace: new rows are inserted first, and older rows are only removed
// once that succeeds, so a bad fetch or parse never empties the table.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/17oLllG_g5Rlo_3-cSpnTs8hw3s8cjbIftz26RYiQPdI/export?format=csv&gid=843470933";
const TEAM_NAME = "Niagara IceDogs";

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

type Pick = { year: number; round: number; from_team: string | null; conditional: boolean; label: string };

function parseTeamPicks(rows: string[][]): Pick[] {
  const start = rows.findIndex((r) => (r[0] || "").trim() === TEAM_NAME);
  if (start < 0) throw new Error(`"${TEAM_NAME}" not found in sheet`);
  const picks: Pick[] = [];
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i];
    const year = Number((r[0] || "").trim());
    if (!/^\d{4}$/.test((r[0] || "").trim())) break; // end of the team's block
    picks.push({ year, round: 1, from_team: null, conditional: false, label: "1st" });
    for (let col = 1; col < r.length; col++) {
      const cell = (r[col] || "").trim();
      if (!cell || cell === "---") continue;
      for (const raw of cell.split(/\n|\s{2,}/)) {
        const tok = raw.trim();
        if (!tok || tok === "---") continue;
        const m = tok.match(/^(?:([A-Za-z]{2,5})\s+)?(\d{1,2})(?:st|nd|rd|th)(\*)?$/);
        if (!m) continue; // ignore anything unexpected rather than guess
        picks.push({
          year,
          round: Number(m[2]),
          from_team: m[1] ? m[1].toUpperCase() : null,
          conditional: !!m[3],
          label: tok,
        });
      }
    }
  }
  return picks;
}

Deno.serve(async (_req) => {
  const headers = { "Content-Type": "application/json" };
  try {
    const res = await fetch(SHEET_CSV_URL + "&_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
    const picks = parseTeamPicks(parseCsv(await res.text()));
    const years = new Set(picks.map((p) => p.year));
    // Sanity check: expect a few years with several picks each.
    if (years.size < 2 || picks.length < years.size * 5) {
      throw new Error(`Parse looks wrong (${picks.length} picks over ${years.size} years) - table left unchanged`);
    }

    const syncedAt = new Date().toISOString();
    const { error: insErr } = await supabase.from("draft_picks").insert(picks.map((p) => ({ ...p, synced_at: syncedAt })));
    if (insErr) throw insErr;
    const { error: delErr } = await supabase.from("draft_picks").delete().lt("synced_at", syncedAt);
    if (delErr) throw delErr;

    await supabase.from("app_settings").upsert({ key: "last_draft_picks_sync", value: syncedAt }, { onConflict: "key" });
    return new Response(JSON.stringify({ success: true, picks: picks.length, years: [...years].sort() }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers });
  }
});
