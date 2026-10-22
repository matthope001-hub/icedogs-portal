// supabase/functions/sync-standings/index.ts
// Saves the IceDogs' current division / conference / overall OHL standing to
// app_settings (key "ohl_standings") for the Season tab record card.
// Source: HockeyTech modulekit standings (stat=division and stat=conference).
// Run nightly by pg_cron, after the score sync.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const API_KEY = "2976319eb44abe94";
const TEAM_ID = "20";
const SEASON_ID = "88";
const FEED = "https://lscluster.hockeytech.com/feed/index.php";

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

async function standings(stat: string): Promise<any[]> {
  const url = `${FEED}?feed=modulekit&view=statviewtype&type=standings&key=${API_KEY}&fmt=json&client_code=ohl&lang=en&league_id=1&season_id=${SEASON_ID}&stat=${stat}&_=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  let text = await res.text();
  const cb = text.match(/^[^(]+\((.+)\);?\s*$/s);
  if (cb) text = cb[1];
  return JSON.parse(text)?.SiteKit?.Statviewtype || [];
}

Deno.serve(async (_req) => {
  const headers = { "Content-Type": "application/json" };
  try {
    // Division view: team rows carry division rank plus overall_rank.
    const divRows = (await standings("division")).filter((r) => r.team_id);
    const us = divRows.find((r) => String(r.team_id) === TEAM_ID);
    if (!us) throw new Error("IceDogs not found in division standings");
    const divTeams = divRows.filter((r) => r.division_id === us.division_id).length;

    // Conference view: rows are grouped under a conference header row.
    const confAll = await standings("conference");
    let current = "", confRank: number | null = null, confName = "", confTeams = 0;
    const counts: Record<string, number> = {};
    for (const r of confAll) {
      if (!r.team_id) { if (r.name) current = r.name; continue; }
      counts[current] = (counts[current] || 0) + 1;
      if (String(r.team_id) === TEAM_ID) { confRank = Number(r.rank) || counts[current]; confName = current; }
    }
    confTeams = counts[confName] || 0;

    const value = {
      division: { rank: Number(us.rank), name: us.division_name || us.divisname || "", of: divTeams },
      conference: { rank: confRank, name: confName, of: confTeams },
      overall: { rank: Number(us.overall_rank) || null, of: divRows.length },
      points: Number(us.points), games_played: Number(us.games_played),
      record: `${us.wins}-${us.losses}-${us.ot_losses}-${us.shootout_losses}`,
      synced_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("app_settings").upsert({ key: "ohl_standings", value: JSON.stringify(value) }, { onConflict: "key" });
    if (error) throw error;
    return new Response(JSON.stringify({ success: true, ...value }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers });
  }
});
