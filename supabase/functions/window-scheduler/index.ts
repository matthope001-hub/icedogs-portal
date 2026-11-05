// supabase/functions/window-scheduler/index.ts
// Two jobs:
//   1. Cron tick (every 15 min, x-cron-secret header): opens scheduled windows and
//      emails non-submitters, sends the 48hr reminder to non-submitters, closes
//      windows and emails Matt + Wayne a list of who didn't submit.
//      The cron secret is stored in the private scheduler_config table.
//   2. Admin action "save_window_times": saves a month's open/close times.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const GMAIL_ADDRESS = Deno.env.get("GMAIL_ADDRESS")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
const FROM_NAME = Deno.env.get("EMAIL_FROM_NAME") || "IceDogs Officials Portal";
// Officials who get the "not submitted" summary when a window closes.
// Their emails are looked up from the officials table at send time.
const SUMMARY_NAMES = ["Matt Hope", "Wayne Briggs-Jude"];
const PORTAL_URL = "https://icedogofficials.ca";
const TZ = "America/Toronto";
const NO_REPLY_TEXT = "This email was sent from an unmonitored mailbox. Please do not reply - contact an IceDogs off-ice admin directly with any questions.";
const NO_REPLY_FOOTER = `<p style="color:#999; font-size:11px; text-align:center; margin:16px 0 0; line-height:1.5;">This email was sent from an unmonitored mailbox. Please do not reply &mdash; contact an IceDogs off-ice admin directly with any questions.</p>`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const JWT_SECRET = Deno.env.get("PORTAL_JWT_SECRET")!;

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

async function verifyAdmin(token: string): Promise<{ id: string; name: string; role: string } | null> {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
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

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function monthLabel(w: any): string {
  if (w.label) return w.label;
  if (/^\d{4}-\d{2}$/.test(w.month)) {
    return new Date(w.month + "-01T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  return w.month;
}

// Regular officials (excludes PA Announcer / Video Replay staff) who haven't
// submitted availability for every game in this window's month.
async function getNonSubmitters(month: string): Promise<{ id: string; name: string; email: string | null }[]> {
  const { data: fixedStaff } = await supabase.from("role_restrictions").select("official_id").in("position", ["PA ANNOUNCER", "VIDEO REPLAY"]);
  const fixedIds = new Set((fixedStaff || []).map((r: any) => r.official_id));
  const { data: officials } = await supabase.from("officials").select("id, name, email").order("name");
  const regular = (officials || []).filter((o: any) => !fixedIds.has(o.id));

  const { data: games } = await supabase.from("games").select("id").eq("window_month", month);
  const gameIds = (games || []).map((g: any) => g.id);
  if (!gameIds.length) return regular;

  const { data: avail } = await supabase.from("availability").select("official_id, game_id").in("game_id", gameIds);
  const counts: Record<string, number> = {};
  (avail || []).forEach((a: any) => { counts[a.official_id] = (counts[a.official_id] || 0) + 1; });
  return regular.filter((o: any) => (counts[o.id] || 0) < gameIds.length);
}

function emailHtml(greeting: string, bodyHtml: string, buttonLabel: string): string {
  return `
    <div style="font-family:Arial,sans-serif; max-width:500px; margin:0 auto;">
      <div style="background:#C8102E; padding:24px; text-align:center; border-radius:12px 12px 0 0;">
        <h2 style="color:white; margin:0; font-size:20px; text-transform:uppercase;">Niagara IceDogs</h2>
        <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:13px;">Off-Ice Officials Portal</p>
      </div>
      <div style="background:#f9f9f9; padding:28px; border-radius:0 0 12px 12px; border:1px solid #eee;">
        <p style="color:#1a1a1a; font-size:15px;">${greeting}</p>
        ${bodyHtml}
        <p style="text-align:center; margin:28px 0;">
          <a href="${PORTAL_URL}" style="background:#C8102E; color:white; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:15px; display:inline-block;">${buttonLabel} &rarr;</a>
        </p>
      </div>
      ${NO_REPLY_FOOTER}
    </div>`;
}

type Mail = { to: string; subject: string; text: string; html: string };

async function sendAll(mails: Mail[]): Promise<{ sent: number; errors: string[] }> {
  if (!mails.length) return { sent: 0, errors: [] };
  const client = new SMTPClient({
    connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_ADDRESS, password: GMAIL_APP_PASSWORD } },
  });
  let sent = 0;
  const errors: string[] = [];
  for (const m of mails) {
    try {
      await client.send({ from: `${FROM_NAME} <${GMAIL_ADDRESS}>`, to: m.to, subject: m.subject, content: m.text, html: m.html });
      sent++;
    } catch (e) {
      errors.push(`${m.to}: ${e.message}`);
    }
  }
  await client.close();
  return { sent, errors };
}

function officialMails(list: { name: string; email: string | null }[], subject: string, lineText: (first: string) => string, lineHtml: string, button: string): Mail[] {
  return list.filter((o) => o.email && String(o.email).includes("@")).map((o) => {
    const first = String(o.name || "").split(" ")[0] || "there";
    return {
      to: o.email as string,
      subject,
      text: `Hi ${first},\n\n${lineText(first)}\n\n${button}: ${PORTAL_URL}\n\n--\nNiagara IceDogs Off-Ice Officials Portal\n${NO_REPLY_TEXT}`,
      html: emailHtml(`Hi ${esc(first)},`, lineHtml, button),
    };
  });
}

async function tick() {
  const now = new Date();
  const { data: rows } = await supabase
    .from("month_windows")
    .select("*")
    .or("opens_at.not.is.null,closes_at.not.is.null");

  const log: string[] = [];

  for (const w of rows || []) {
    const label = monthLabel(w);
    const opens = w.opens_at ? new Date(w.opens_at) : null;
    const closes = w.closes_at ? new Date(w.closes_at) : null;
    let isOpen = w.status === "Active";
    let justOpened = false;

    // OPEN — set Active and email non-submitters
    if (opens && !w.open_email_sent_at && opens <= now && (!closes || closes > now)) {
      await supabase.from("month_windows").update({ status: "Active", open_email_sent_at: now.toISOString() }).eq("month", w.month);
      isOpen = true;
      justOpened = true;
      const pending = await getNonSubmitters(w.month);
      const deadline = closes ? ` The deadline is ${fmt(closes.toISOString())}.` : "";
      const res = await sendAll(officialMails(
        pending,
        `Availability Now Open - ${label}`,
        () => `${label} availability is now open on the Off-Ice Officials Portal. Please log in and submit your availability.${deadline}`,
        `<p style="color:#444; font-size:14px; line-height:1.6;"><strong>${esc(label)}</strong> availability is now open on the Off-Ice Officials Portal. Please log in and submit your availability.${esc(deadline)}</p>`,
        "Submit Availability",
      ));
      log.push(`${w.month}: opened, emailed ${res.sent}${res.errors.length ? ", errors: " + res.errors.join(" | ") : ""}`);
    }

    // REMINDER — 48hrs before close, non-submitters only
    if (closes && !w.reminder_sent_at && isOpen && now < closes && now.getTime() >= closes.getTime() - 48 * 3600 * 1000) {
      await supabase.from("month_windows").update({ reminder_sent_at: now.toISOString() }).eq("month", w.month);
      if (justOpened) {
        log.push(`${w.month}: reminder skipped (window opened inside the last 48hrs)`);
      } else {
        const pending = await getNonSubmitters(w.month);
        const res = await sendAll(officialMails(
          pending,
          `Reminder: ${label} Availability Closes ${fmt(closes.toISOString())}`,
          () => `Reminder: you haven't submitted your ${label} availability yet. The window closes ${fmt(closes.toISOString())}.`,
          `<p style="color:#444; font-size:14px; line-height:1.6;">Reminder: you haven't submitted your <strong>${esc(label)}</strong> availability yet. The window closes <strong>${esc(fmt(closes.toISOString()))}</strong>.</p>`,
          "Submit Availability",
        ));
        log.push(`${w.month}: reminder emailed ${res.sent}${res.errors.length ? ", errors: " + res.errors.join(" | ") : ""}`);
      }
    }

    // CLOSE — set Hidden and email the summary to Matt + Wayne
    if (closes && !w.close_email_sent_at && closes <= now) {
      await supabase.from("month_windows").update({ status: "Hidden", close_email_sent_at: now.toISOString() }).eq("month", w.month);
      const pending = await getNonSubmitters(w.month);
      const listText = pending.length ? pending.map((o) => `- ${o.name}`).join("\n") : "Everyone submitted.";
      const listHtml = pending.length
        ? `<ul style="color:#444; font-size:14px; line-height:1.6;">${pending.map((o) => `<li>${esc(o.name)}</li>`).join("")}</ul>`
        : `<p style="color:#444; font-size:14px;">Everyone submitted.</p>`;
      const { data: summaryPeople } = await supabase.from("officials").select("email").in("name", SUMMARY_NAMES);
      const summaryEmails = (summaryPeople || []).map((p: any) => p.email).filter((e: any) => e && String(e).includes("@"));
      const mails: Mail[] = summaryEmails.map((to: string) => ({
        to,
        subject: `${label} Availability Closed - ${pending.length} Not Submitted`,
        text: `The ${label} availability window closed ${fmt(closes.toISOString())}.\n\nNot submitted (${pending.length}):\n${listText}\n\nOpen the portal: ${PORTAL_URL}\n\n--\nNiagara IceDogs Off-Ice Officials Portal\n${NO_REPLY_TEXT}`,
        html: emailHtml(
          "Hi,",
          `<p style="color:#444; font-size:14px; line-height:1.6;">The <strong>${esc(label)}</strong> availability window closed ${esc(fmt(closes.toISOString()))}.</p><p style="color:#1a1a1a; font-size:14px; font-weight:bold; margin-bottom:0;">Not submitted (${pending.length}):</p>${listHtml}`,
          "Open the Portal",
        ),
      }));
      const res = await sendAll(mails);
      log.push(`${w.month}: closed, summary emailed ${res.sent}${res.errors.length ? ", errors: " + res.errors.join(" | ") : ""}`);
    }
  }

  return log;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization, x-cron-secret",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    // Cron tick
    const cronHeader = req.headers.get("x-cron-secret");
    if (cronHeader) {
      // The secret lives in the private scheduler_config table (no public access).
      const { data: cfg } = await supabase.from("scheduler_config").select("value").eq("key", "cron_secret").maybeSingle();
      if (!cfg || !cfg.value || cronHeader !== cfg.value) return json({ success: false, msg: "Bad cron secret" }, 403);
      const log = await tick();
      return json({ success: true, log });
    }

    // Admin action
    const { token, action, payload } = await req.json();
    const session = await verifyAdmin(token);
    if (!session) return json({ success: false, msg: "Admin access required" }, 403);

    if (action === "save_window_times") {
      const { month, opensAt, closesAt } = payload || {};
      if (!month) return json({ success: false, msg: "Missing month" }, 400);
      if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) {
        return json({ success: false, msg: "Close time must be after open time" }, 400);
      }

      const { data: current } = await supabase.from("month_windows").select("*").eq("month", month).maybeSingle();
      if (!current) return json({ success: false, msg: "Window not found" }, 404);

      const now = Date.now();
      const update: Record<string, unknown> = { opens_at: opensAt || null, closes_at: closesAt || null };

      // A new future open time re-arms the open email.
      if ((opensAt || null) !== (current.opens_at || null) && opensAt && new Date(opensAt).getTime() > now) {
        update.open_email_sent_at = null;
      }
      // A changed close time re-arms the close summary, and the reminder if it's still ahead.
      if ((closesAt || null) !== (current.closes_at || null)) {
        if (closesAt && new Date(closesAt).getTime() > now) update.close_email_sent_at = null;
        if (closesAt && new Date(closesAt).getTime() - 48 * 3600 * 1000 > now) update.reminder_sent_at = null;
      }

      const { error } = await supabase.from("month_windows").update(update).eq("month", month);
      if (error) throw error;
      return json({ success: true });
    }

    return json({ success: false, msg: "Unknown action" }, 400);
  } catch (e) {
    return json({ success: false, msg: e.message }, 500);
  }
});
