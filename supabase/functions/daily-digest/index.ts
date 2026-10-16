// supabase/functions/daily-digest/index.ts
// Short status digest emailed from the portal mailbox (GMAIL_ADDRESS) to
// BACKUP_EMAIL twice a day by pg_cron. Its purpose is to warm up the new
// sending account with regular, genuine mail; it stops on its own after
// WARMUP_UNTIL (default 2026-10-30) and can be removed after that.
//
// Content: next home game (date, opponent, crew filled / open positions,
// schedule locked or not) and the most recent IceDogs result.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const GMAIL_ADDRESS = Deno.env.get("GMAIL_ADDRESS")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
const TO_EMAIL = Deno.env.get("BACKUP_EMAIL") || GMAIL_ADDRESS;
const FROM_NAME = Deno.env.get("EMAIL_FROM_NAME") || "IceDogs Officials Portal";
const WARMUP_UNTIL = Deno.env.get("WARMUP_UNTIL") || "2026-10-30";
const PORTAL_URL = "https://icedogofficials.ca";
const TZ = "America/Toronto";

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

function todayToronto(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function hourToronto(): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(new Date()));
}

function fmtDate(d: string): string {
  return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ASCII-only, HTML-safe (the mail library mishandles non-ASCII).
function safe(s: string): string {
  return Array.from(String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .map((ch) => { const c = ch.codePointAt(0) || 0; return c > 126 ? `&#${c};` : ch; }).join("");
}

Deno.serve(async (_req) => {
  try {
    const today = todayToronto();
    if (today > WARMUP_UNTIL) {
      return new Response(JSON.stringify({ success: true, skipped: "warm-up period over" }), { headers: { "Content-Type": "application/json" } });
    }

    // Next home game + crew status
    const { data: nextGames } = await supabase.from("games")
      .select("id, game_number, date, time, opponent_name, schedule_locked")
      .gte("date", today).order("date").limit(1);
    const next = (nextGames || [])[0];

    let nextText = "No upcoming home games scheduled.";
    let nextHtml = `<p>${nextText}</p>`;
    if (next) {
      const { data: positions } = await supabase.from("position_settings").select("position").eq("enabled", true);
      const required = (positions || []).map((p: any) => p.position);
      const { data: asg } = await supabase.from("assignments").select("position").eq("game_id", next.id);
      const filled = new Set((asg || []).map((a: any) => a.position));
      const open = required.filter((p: string) => !filled.has(p));
      const status = next.schedule_locked ? "Schedule set" : "Scheduling in progress";
      const line = `${fmtDate(next.date)} at ${next.time || "TBD"} vs ${next.opponent_name} (Game #${next.game_number})`;
      const crew = `${required.length - open.length}/${required.length} positions filled` + (open.length ? ` - open: ${open.join(", ")}` : "");
      nextText = `${line}\n${status}. ${crew}.`;
      nextHtml = `<p style="margin:0 0 4px;"><strong>${safe(line)}</strong></p><p style="margin:0; color:#555;">${safe(status)}. ${safe(crew)}.</p>`;
    }

    // Most recent result
    const { data: lastGames } = await supabase.from("schedule")
      .select("date, home_team, away_team, home_score, away_score, is_home")
      .lt("date", today).not("home_score", "is", null).order("date", { ascending: false }).limit(1);
    const last = (lastGames || [])[0];
    let lastText = "No results yet.";
    if (last) {
      const us = last.is_home ? last.home_score : last.away_score;
      const them = last.is_home ? last.away_score : last.home_score;
      const opp = last.is_home ? last.away_team : last.home_team;
      const res = us > them ? "W" : (us < them ? "L" : "T");
      lastText = `${fmtDate(last.date)}: ${res} ${us}-${them} ${last.is_home ? "vs" : "at"} ${opp}`;
    }

    const period = hourToronto() < 12 ? "Morning" : "Evening";
    const subject = `${period} update - IceDogs Officials Portal - ${fmtDate(today)}`;

    const text = `IceDogs Officials Portal - ${period.toLowerCase()} update\n\nNEXT HOME GAME\n${nextText}\n\nLAST RESULT\n${lastText}\n\nOpen the portal: ${PORTAL_URL}\n\n--\nAutomated update sent to portal admins during the mailbox warm-up period (until ${WARMUP_UNTIL}). This mailbox is not monitored.`;
    const html = `
      <div style="font-family:Arial,sans-serif; max-width:500px; margin:0 auto; color:#222;">
        <div style="background:#C8102E; padding:16px 20px; border-radius:10px 10px 0 0;">
          <div style="color:white; font-weight:bold; font-size:16px;">IceDogs Officials Portal</div>
          <div style="color:rgba(255,255,255,0.85); font-size:12px;">${period} update &middot; ${safe(fmtDate(today))}</div>
        </div>
        <div style="background:#f9f9f9; padding:20px; border:1px solid #eee; border-radius:0 0 10px 10px; font-size:14px; line-height:1.5;">
          <div style="font-size:11px; font-weight:bold; color:#888; letter-spacing:0.5px; margin-bottom:6px;">NEXT HOME GAME</div>
          ${nextHtml}
          <div style="font-size:11px; font-weight:bold; color:#888; letter-spacing:0.5px; margin:16px 0 6px;">LAST RESULT</div>
          <p style="margin:0;">${safe(lastText)}</p>
          <p style="margin:18px 0 0;"><a href="${PORTAL_URL}" style="color:#C8102E; font-weight:bold;">Open the portal &rarr;</a></p>
        </div>
        <p style="color:#999; font-size:11px; text-align:center; margin:14px 0 0;">Automated update sent to portal admins during the mailbox warm-up period (until ${WARMUP_UNTIL}). This mailbox is not monitored.</p>
      </div>`;

    const client = new SMTPClient({
      connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_ADDRESS, password: GMAIL_APP_PASSWORD } },
    });
    await client.send({ from: `${FROM_NAME} <${GMAIL_ADDRESS}>`, to: TO_EMAIL, subject, content: text, html });
    await client.close();

    return new Response(JSON.stringify({ success: true, sentTo: TO_EMAIL, subject }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
