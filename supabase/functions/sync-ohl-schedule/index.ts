// supabase/functions/sync-ohl-schedule/index.ts
// Syncs the full season schedule (schedule table, full overwrite) and safely adds
// any new home games to the games table (insert-only — never touches existing rows,
// so manual promo/notes/lock edits are always protected).
//
// Can be called two ways:
//  1. Manually from Admin (requires a valid Admin session token)
//  2. By pg_cron on a schedule (calls with no token — allowed, since this is a read-heavy
//     sync with no user-supplied data; the OHL API key itself is the real gate)
//
// Field names match the HockeyTech modulekit "schedule" view:
//   game_id, date_played, home_team / visiting_team (team IDs),
//   home_team_name / visiting_team_name, home_goal_count / visiting_goal_count,
//   scheduled_time, started, final, game_number, overtime, shootout, period

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const JWT_SECRET = Deno.env.get("PORTAL_JWT_SECRET")!;

const API_KEY = "2976319eb44abe94";
const CLIENT_CODE = "ohl";
const TEAM_ID = "20";
const LEAGUE_ID = "1";
const SEASON_ID = "88";

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

function b64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifyAdmin(token: string) {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || Date.now() > payload.exp) return null;
    if (payload.role !== "Admin") return null;
    return payload;
  } catch (_e) {
    return null;
  }
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function toScore(v: unknown): number | null {
  const s = str(v);
  if (s === "") return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch (_e) { /* cron calls may send no body */ }

    if (body.token) {
      const session = await verifyAdmin(body.token as string);
      if (!session) {
        return new Response(JSON.stringify({ success: false, msg: "Admin access required" }), { status: 403, headers: cors });
      }
    }

    const url = `https://lscluster.hockeytech.com/feed/index.php?feed=modulekit&view=schedule&key=${API_KEY}&fmt=json&client_code=${CLIENT_CODE}&lang=en&season_id=${SEASON_ID}&team_id=${TEAM_ID}&league_id=${LEAGUE_ID}`;
    const apiRes = await fetch(url);
    let text = await apiRes.text();
    const cbMatch = text.match(/^[^(]+\((.+)\);?\s*$/s);
    if (cbMatch) text = cbMatch[1];
    const json = JSON.parse(text);
    const games: Record<string, unknown>[] = json?.SiteKit?.Schedule || [];

    if (!games.length) {
      return new Response(JSON.stringify({ success: false, msg: "No games returned from OHL API" }), { status: 502, headers: cors });
    }

    let scheduleUpserted = 0;
    let scheduleFailed = 0;
    let gamesInserted = 0;
    let gamesFailed = 0;
    let scoresWritten = 0;
    let staleRemoved = 0;
    const errors: string[] = [];
    const apiIdSet = new Set<string>();

    const { data: existingGames } = await supabase.from("games").select("date, opponent_name, game_number");
    const existingKeySet = new Set(
      (existingGames || []).map((g: any) => g.date + "|" + (g.opponent_name || "").toLowerCase())
    );
    // Also match on game_number — catches games already in the table whose date or
    // opponent spelling differs from the OHL feed (e.g. rescheduled games).
    const existingNumberSet = new Set(
      (existingGames || []).map((g: any) => str(g.game_number)).filter(Boolean)
    );
    const { data: announcer } = await supabase.from("officials").select("id").eq("name", "Rod Mahwood").maybeSingle();
    const announcerId = announcer?.id || null;

    for (const g of games) {
      const apiGameId = str(g.game_id) || str(g.id);
      const dateOnly = str(g.date_played).slice(0, 10);
      if (!apiGameId || !dateOnly) {
        scheduleFailed++;
        if (errors.length < 5) errors.push("Skipped game with missing id/date: " + JSON.stringify({ id: g.game_id, date: g.date_played }));
        continue;
      }
      apiIdSet.add(apiGameId);

      const isHome = str(g.home_team) === TEAM_ID;
      const homeTeam = str(g.home_team_name) || [str(g.home_team_city), str(g.home_team_nickname)].filter(Boolean).join(" ");
      const awayTeam = str(g.visiting_team_name) || [str(g.visiting_team_city), str(g.visiting_team_nickname)].filter(Boolean).join(" ");
      const gameTime = str(g.scheduled_time);

      // Only store scores once the game has started — upcoming games report "0"
      // goal counts, which would otherwise show as a 0–0 result.
      const started = str(g.started) === "1" || str(g.final) === "1";
      const home = started ? toScore(g.home_goal_count) : null;
      const away = started ? toScore(g.visiting_goal_count) : null;
      if (home !== null && away !== null) scoresWritten++;

      // OT / shootout flags (only meaningful once the game is final) so the
      // portal can show the record OHL-style: W-L-OTL-SOL.
      const isFinal = str(g.final) === "1";
      const shootout = isFinal && str(g.shootout) === "1";
      const overtime = isFinal && (shootout || str(g.overtime) === "1" || Number(str(g.period)) >= 4);

      const { error: schedError } = await supabase.from("schedule").upsert({
        game_id: apiGameId,
        date: dateOnly,
        day_name: null,
        home_team: homeTeam,
        away_team: awayTeam,
        home_score: home,
        away_score: away,
        game_time: gameTime,
        is_home: isHome,
        overtime,
        shootout,
      }, { onConflict: "game_id" });
      if (schedError) {
        scheduleFailed++;
        if (errors.length < 5) errors.push("schedule " + apiGameId + ": " + schedError.message);
      } else {
        scheduleUpserted++;
      }

      if (isHome) {
        const key = dateOnly + "|" + awayTeam.toLowerCase();
        const gameNumber = str(g.game_number) || apiGameId;
        if (!existingKeySet.has(key) && !existingNumberSet.has(gameNumber)) {
          const { data: newGame, error: insertError } = await supabase.from("games").insert({
            game_number: gameNumber,
            date: dateOnly,
            time: gameTime,
            opponent_name: awayTeam,
            type: "(R)",
            window_month: dateOnly.slice(0, 7),
          }).select("id").single();
          if (insertError) {
            gamesFailed++;
            if (errors.length < 5) errors.push("games " + apiGameId + ": " + insertError.message);
          } else {
            gamesInserted++;
            existingKeySet.add(key);
            existingNumberSet.add(gameNumber);
            if (announcerId && newGame) {
              await supabase.from("assignments").upsert(
                { game_id: newGame.id, position: "PA ANNOUNCER", official_id: announcerId },
                { onConflict: "game_id,position" }
              );
            }
          }
        }
      }
    }

    // Remove schedule rows that are no longer in the OHL feed (old imports saved under
    // a different game_id, or games the league has removed). Only runs when every
    // schedule write succeeded and the feed returned a full season, so a partial or
    // failed API response can never wipe the table. Only touches `schedule` — the
    // `games` table (assignments, promos, availability) is never affected.
    if (scheduleFailed === 0 && apiIdSet.size >= 20) {
      const { data: existingSched, error: readErr } = await supabase.from("schedule").select("game_id");
      if (readErr) {
        if (errors.length < 5) errors.push("stale check: " + readErr.message);
      } else {
        const staleIds = (existingSched || [])
          .map((r: any) => str(r.game_id))
          .filter((id: string) => id && !apiIdSet.has(id));
        for (let i = 0; i < staleIds.length; i += 100) {
          const chunk = staleIds.slice(i, i + 100);
          const { error: delErr } = await supabase.from("schedule").delete().in("game_id", chunk);
          if (delErr) {
            if (errors.length < 5) errors.push("stale delete: " + delErr.message);
          } else {
            staleRemoved += chunk.length;
          }
        }
      }
    }

    await supabase.from("app_settings").upsert(
      { key: "last_ohl_sync", value: new Date().toISOString() },
      { onConflict: "key" }
    );

    const success = scheduleFailed === 0 && gamesFailed === 0;
    return new Response(JSON.stringify({
      success,
      msg: success ? undefined : errors.join(" | "),
      scheduleUpserted,
      scheduleFailed,
      scoresWritten,
      staleRemoved,
      gamesInserted,
      gamesFailed,
      totalFromApi: games.length,
      errors,
    }), { headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers: cors });
  }
});
