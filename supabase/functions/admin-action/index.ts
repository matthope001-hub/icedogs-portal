// supabase/functions/admin-action/index.ts
// Verifies the session token AND that the official is an Admin, then performs the requested write.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const GMAIL_ADDRESS = Deno.env.get("GMAIL_ADDRESS")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
const PORTAL_URL = "https://icedogofficials.ca";
// Display name shown in officials' inboxes. Override with the EMAIL_FROM_NAME secret.
const FROM_NAME = Deno.env.get("EMAIL_FROM_NAME") || "IceDogs Officials Portal";
// Shown at the bottom of every portal email — the sending mailbox isn't monitored.
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

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Email subjects must be plain ASCII — the mail library mangles other characters
// in headers, which breaks the whole email in stricter clients (e.g. Yahoo).
function asciiSubject(s: string): string {
  return String(s)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Escapes HTML and turns any non-ASCII character (accents, emoji, curly quotes)
// into a numeric entity so the email body is pure ASCII.
function safeHtml(s: string): string {
  return Array.from(escapeHtml(s)).map((ch) => {
    const code = ch.codePointAt(0) || 0;
    return code > 126 ? `&#${code};` : ch;
  }).join("");
}

function smtpClient(): SMTPClient {
  return new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: { username: GMAIL_ADDRESS, password: GMAIL_APP_PASSWORD },
    },
  });
}

// Emails a broadcast to every official with an email address on file, or only
// to `onlyOfficialId` when given (used by "Send test to me").
// Returns how many were sent and any per-recipient errors.
async function emailBroadcast(message: string, type: string, sentBy: string, onlyOfficialId?: string, isTest = false): Promise<{ sent: number; errors: string[] }> {
  let query = supabase.from("officials").select("name, email").not("email", "is", null);
  if (onlyOfficialId) query = query.eq("id", onlyOfficialId);
  const { data: officials } = await query;
  const recipients = (officials || []).filter((o: any) => o.email && String(o.email).includes("@"));
  if (!recipients.length) return { sent: 0, errors: [onlyOfficialId ? "Your official profile has no email address on file" : "No officials have an email address on file"] };

  const TYPE_CFG: Record<string, { label: string; color: string }> = {
    urgent:   { label: "URGENT",   color: "#C8102E" },
    reminder: { label: "REMINDER", color: "#b45309" },
    info:     { label: "NOTICE",   color: "#1d4ed8" },
  };
  const cfg = TYPE_CFG[type] || TYPE_CFG.info;
  const subjectPrefix = type === "urgent" ? "URGENT: " : (type === "reminder" ? "Reminder: " : "");
  const firstLine = message.split("\n")[0].trim();
  const subjectLine = asciiSubject(firstLine);
  const subject = (isTest ? "[TEST] " : "") + subjectPrefix + "IceDogs Off-Ice - " + (subjectLine.length > 60 ? subjectLine.slice(0, 57) + "..." : subjectLine);
  const bodyHtml = safeHtml(message).replace(/\r?\n/g, "<br>");

  const client = smtpClient();
  let sent = 0;
  const errors: string[] = [];
  for (const o of recipients) {
    const firstName = String(o.name || "").split(" ")[0] || "there";
    try {
      await client.send({
        from: `${FROM_NAME} <${GMAIL_ADDRESS}>`,
        to: o.email,
        subject,
        html: `
          <div style="font-family:Arial,sans-serif; max-width:500px; margin:0 auto;">
            <div style="background:#C8102E; padding:24px; text-align:center; border-radius:12px 12px 0 0;">
              <h2 style="color:white; margin:0; font-size:20px; text-transform:uppercase;">Niagara IceDogs</h2>
              <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:13px;">Off-Ice Officials Portal</p>
            </div>
            <div style="background:#f9f9f9; padding:28px; border-radius:0 0 12px 12px; border:1px solid #eee;">
              <div style="display:inline-block; font-size:11px; font-weight:bold; color:white; background:${cfg.color}; padding:4px 10px; border-radius:20px; margin-bottom:14px;">${cfg.label}</div>
              <p style="color:#1a1a1a; font-size:15px; margin-top:0;">Hi ${safeHtml(firstName)},</p>
              <p style="color:#333; font-size:14px; line-height:1.6;">${bodyHtml}</p>
              <p style="color:#888; font-size:12px; margin-top:20px;">&mdash; ${safeHtml(sentBy)}</p>
              <p style="text-align:center; margin:24px 0 4px;">
                <a href="${PORTAL_URL}" style="background:#C8102E; color:white; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:14px; display:inline-block;">Open the Portal &rarr;</a>
              </p>
            </div>
            ${NO_REPLY_FOOTER}
          </div>`,
      });
      sent++;
    } catch (e) {
      errors.push(`${o.email}: ${e.message}`);
    }
  }
  await client.close();
  return { sent, errors };
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const { token, action, payload } = await req.json();

    const session = await verifyAdmin(token);
    if (!session) {
      return new Response(JSON.stringify({ success: false, msg: "Admin access required" }), { status: 403, headers: cors });
    }

    if (action === "toggle_pin") {
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key: "pin_required", value: payload.value }, { onConflict: "key" });
      if (error) throw error;
      return ok(cors);
    }

    if (action === "toggle_month") {
      const { error } = await supabase
        .from("month_windows")
        .upsert({ month: payload.month, status: payload.status }, { onConflict: "month" });
      if (error) throw error;
      return ok(cors);
    }

    if (action === "send_broadcast") {
      const { error } = await supabase.from("broadcasts").insert({
        message: payload.message,
        type: payload.type,
        sent_by: session.name,
        sent_at: new Date().toISOString(),
        expires_at: payload.expiresAt || null,
        active: true,
      });
      if (error) throw error;

      // Optional: also email the broadcast to every official.
      if (payload.email) {
        const { sent, errors } = await emailBroadcast(String(payload.message || ""), String(payload.type || "info"), session.name);
        return new Response(JSON.stringify({
          success: true,
          emailed: sent,
          msg: errors.length ? `Posted. ${errors.length} email(s) failed: ` + errors.slice(0, 3).join(" | ") : undefined,
        }), { headers: { ...cors, "Content-Type": "application/json" } });
      }
      return ok(cors);
    }

    // Sends the broadcast email only to the logged-in admin, without posting it.
    if (action === "send_test_email") {
      const message = String(payload.message || "").trim() || "This is a test email from the IceDogs Off-Ice Officials Portal.";
      const { sent, errors } = await emailBroadcast(message, String(payload.type || "info"), session.name, session.id, true);
      if (!sent) {
        return new Response(JSON.stringify({ success: false, msg: errors.join(" | ") || "Test email failed" }), { status: 500, headers: cors });
      }
      return new Response(JSON.stringify({ success: true, emailed: sent }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (action === "deactivate_broadcast") {
      const { error } = await supabase.from("broadcasts").update({ active: false }).eq("id", payload.id);
      if (error) throw error;
      return ok(cors);
    }

    if (action === "save_game") {
      const p = payload;
      const row = {
        game_number: p.gameNumber,
        date: p.date,
        time: p.time,
        opponent_name: p.opponentName,
        type: p.type || "(R)",
        promo: p.promo || null,
        notes: p.notes || null,
      };
      if (p.id) {
        // Update only — window_month is intentionally left untouched so a manual
        // override (e.g. merging a Sept game into the Oct window) survives edits
        // to date/time/opponent. Change the window via the Avail Win admin UI, not here.
        const { error } = await supabase.from("games").update(row).eq("id", p.id);
        if (error) throw error;
      } else {
        const { data: newGame, error } = await supabase.from("games").insert({ ...row, window_month: p.date.slice(0, 7) }).select("id").single();
        if (error) throw error;
        const { data: announcer } = await supabase.from("officials").select("id").eq("name", "Rod Mahwood").maybeSingle();
        if (announcer && newGame) {
          await supabase.from("assignments").upsert(
            { game_id: newGame.id, position: "PA ANNOUNCER", official_id: announcer.id },
            { onConflict: "game_id,position" }
          );
        }
      }
      return ok(cors);
    }

    if (action === "delete_game") {
      const { error } = await supabase.from("games").delete().eq("id", payload.id);
      if (error) throw error;
      return ok(cors);
    }

    if (action === "save_official") {
      const p = payload;
      // PIN no longer lives on officials — it's stored separately in official_auth.
      const row: Record<string, unknown> = {
        name: p.name,
        email: p.email || null,
        phone: p.phone || null,
        role: p.role || "Official",
      };

      let officialId = p.id;

      if (officialId) {
        const { error } = await supabase.from("officials").update(row).eq("id", officialId);
        if (error) throw error;
      } else {
        const { data: created, error } = await supabase
          .from("officials")
          .insert({ ...row, pass_pref: "Digital", profile_complete: false })
          .select("id")
          .single();
        if (error) throw error;
        officialId = created.id;
      }

      if (p.pin) {
        const { error: pinError } = await supabase
          .from("official_auth")
          .upsert({ official_id: officialId, pin: p.pin }, { onConflict: "official_id" });
        if (pinError) throw pinError;
      }

      return ok(cors);
    }

    if (action === "delete_official") {
      const { error } = await supabase.from("officials").delete().eq("id", payload.id);
      if (error) {
        if (error.code === "23503") {
          return new Response(JSON.stringify({ success: false, msg: "Cannot delete — this official has existing assignments or availability records." }), { status: 409, headers: cors });
        }
        throw error;
      }
      return ok(cors);
    }

    if (action === "update_assignment") {
      const { gameId, position, officialName } = payload;
      const MULTI_ROLE_EXCEPTIONS = ["Wayne Briggs-Jude", "Curtis Pirson"];
      const FIXED_POSITIONS = ["PA ANNOUNCER", "VIDEO REPLAY"];
      const posUpper = position.toUpperCase();

      if (!officialName) {
        const { error } = await supabase.from("assignments").delete().eq("game_id", gameId).eq("position", position);
        if (error) throw error;
        return ok(cors);
      }

      const { data: official } = await supabase.from("officials").select("id").eq("name", officialName).maybeSingle();
      if (!official) {
        return new Response(JSON.stringify({ success: false, msg: "Official not found" }), { status: 404, headers: cors });
      }

      if (FIXED_POSITIONS.includes(posUpper)) {
        const { data: restrictions } = await supabase
          .from("role_restrictions")
          .select("officials(name)")
          .eq("position", posUpper);
        const allowed = (restrictions || []).map((r: any) => r.officials?.name);
        if (!allowed.includes(officialName)) {
          return new Response(JSON.stringify({ success: false, msg: `RESTRICTION: ${officialName} is not authorized for ${position}.` }), { status: 400, headers: cors });
        }
      } else {
        const { data: skill } = await supabase
          .from("official_skills")
          .select("id")
          .eq("official_id", official.id)
          .eq("position", posUpper)
          .maybeSingle();
        if (!skill) {
          return new Response(JSON.stringify({ success: false, msg: `SKILL: ${officialName} is not marked qualified for ${position}.` }), { status: 400, headers: cors });
        }
      }

      // Check duplicate assignment within this game
      const { data: existingAssignments } = await supabase
        .from("assignments")
        .select("position, officials(name)")
        .eq("game_id", gameId);
      const otherAssignmentsForOfficial = (existingAssignments || []).filter(
        (a: any) => a.officials?.name === officialName && a.position !== position
      );

      if (otherAssignmentsForOfficial.length > 0) {
        const isMultiRoleException = MULTI_ROLE_EXCEPTIONS.includes(officialName);
        const newPositionIsCrewChief = posUpper === "CREW CHIEF";
        const existingIncludesCrewChief = otherAssignmentsForOfficial.some((a: any) => a.position === "CREW CHIEF");
        const secondRoleAllowed = isMultiRoleException
          && otherAssignmentsForOfficial.length === 1
          && (newPositionIsCrewChief || existingIncludesCrewChief);

        if (!secondRoleAllowed) {
          return new Response(JSON.stringify({ success: false, msg: `CONFLICT: ${officialName} is already assigned in this game.` }), { status: 400, headers: cors });
        }
      }

      const { error } = await supabase
        .from("assignments")
        .upsert({ game_id: gameId, position, official_id: official.id }, { onConflict: "game_id,position" });
      if (error) throw error;
      return ok(cors);
    }

    if (action === "admin_save_availability") {
      const { officialId, month, results } = payload;
      if (!Array.isArray(results) || results.length === 0) {
        return new Response(JSON.stringify({ success: false, msg: "No results provided" }), { status: 400, headers: cors });
      }

      const gameNumbers = results.map((r: any) => r.gameId.toString());
      const { data: games } = await supabase.from("games").select("id, game_number").in("game_number", gameNumbers);
      const gameByNumber: Record<string, string> = {};
      (games || []).forEach((g: any) => { gameByNumber[g.game_number] = g.id; });

      const rows = results
        .filter((r: any) => gameByNumber[r.gameId.toString()])
        .map((r: any) => ({
          official_id: officialId,
          game_id: gameByNumber[r.gameId.toString()],
          month: month,
          status: r.status,
          reason: r.status === "Not Available" ? (r.reason || null) : null,
          submitted_at: new Date().toISOString(),
          submitted_by: session.name,
        }));

      const { error } = await supabase.from("availability").upsert(rows, { onConflict: "official_id,game_id" });
      if (error) throw error;
      return ok(cors);
    }

    if (action === "wipe_games") {
      const { data: games } = await supabase.from("games").select("*");
      const { data: assignments } = await supabase.from("assignments").select("*");
      const { data: availability } = await supabase.from("availability").select("*");
      const { error: backupError } = await supabase.from("backups").insert({
        label: "games+assignments+availability",
        backed_up_by: session.name,
        data: { games: games || [], assignments: assignments || [], availability: availability || [] },
      });
      if (backupError) throw backupError;

      const { error } = await supabase.from("games").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
      return ok(cors);
    }

    if (action === "wipe_assignments") {
      const { data: assignments } = await supabase.from("assignments").select("*");
      const { error: backupError } = await supabase.from("backups").insert({
        label: "assignments",
        backed_up_by: session.name,
        data: { assignments: assignments || [] },
      });
      if (backupError) throw backupError;

      const { error } = await supabase.from("assignments").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
      return ok(cors);
    }

    if (action === "wipe_availability") {
      const { data: availability } = await supabase.from("availability").select("*");
      const { error: backupError } = await supabase.from("backups").insert({
        label: "availability",
        backed_up_by: session.name,
        data: { availability: availability || [] },
      });
      if (backupError) throw backupError;

      const { error } = await supabase.from("availability").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
      return ok(cors);
    }

    if (action === "save_team") {
      const p = payload;
      const row = { name: p.name, logo_url: p.logoUrl || null };
      if (p.id) {
        const { error } = await supabase.from("teams").update(row).eq("id", p.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("teams").insert(row);
        if (error) throw error;
      }
      return ok(cors);
    }

    if (action === "delete_team") {
      const { error } = await supabase.from("teams").delete().eq("id", payload.id);
      if (error) throw error;
      return ok(cors);
    }

    if (action === "notify_availability_open") {
      const { month } = payload;
      const monthLabel = new Date(month + "-01T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });

      const { data: fixedStaff } = await supabase.from("role_restrictions").select("official_id").in("position", ["PA ANNOUNCER", "VIDEO REPLAY"]);
      const fixedStaffIds = new Set((fixedStaff || []).map((r: any) => r.official_id));

      const { data: officials } = await supabase.from("officials").select("id, name, email").not("email", "is", null);
      const candidates = (officials || []).filter((o: any) => !fixedStaffIds.has(o.id) && o.email);

      const { data: monthGames } = await supabase
        .from("games")
        .select("id")
        .eq("window_month", month);
      const monthGameIds = (monthGames || []).map((g: any) => g.id);

      let recipients = candidates;
      if (monthGameIds.length > 0) {
        const { data: existingAvail } = await supabase
          .from("availability")
          .select("official_id, game_id")
          .in("game_id", monthGameIds);

        const submittedCountByOfficial: Record<string, number> = {};
        (existingAvail || []).forEach((a: any) => {
          submittedCountByOfficial[a.official_id] = (submittedCountByOfficial[a.official_id] || 0) + 1;
        });

        recipients = candidates.filter((o: any) => (submittedCountByOfficial[o.id] || 0) < monthGameIds.length);
      }

      if (!recipients.length) {
        return new Response(JSON.stringify({ success: false, msg: "Everyone with an email has already submitted for this month" }), { status: 400, headers: cors });
      }

      const client = smtpClient();

      let sent = 0;
      const errors: string[] = [];
      for (const o of recipients) {
        const firstName = o.name.split(" ")[0];
        try {
          await client.send({
            from: `${FROM_NAME} <${GMAIL_ADDRESS}>`,
            to: o.email,
            subject: `Availability Now Open - ${monthLabel}`,
            html: `
              <div style="font-family:Arial,sans-serif; max-width:500px; margin:0 auto;">
                <div style="background:#C8102E; padding:24px; text-align:center; border-radius:12px 12px 0 0;">
                  <h2 style="color:white; margin:0; font-size:20px; text-transform:uppercase;">Niagara IceDogs</h2>
                  <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:13px;">Off-Ice Officials Portal</p>
                </div>
                <div style="background:#f9f9f9; padding:28px; border-radius:0 0 12px 12px; border:1px solid #eee;">
                  <p style="color:#1a1a1a; font-size:15px;">Hi ${firstName},</p>
                  <p style="color:#444; font-size:14px; line-height:1.6;"><strong>${monthLabel}</strong> availability is now open on the Off-Ice Officials Portal. Please log in and submit your availability as soon as possible.</p>
                  <p style="text-align:center; margin:28px 0;">
                    <a href="${PORTAL_URL}" style="background:#C8102E; color:white; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:15px; display:inline-block;">Submit Availability &rarr;</a>
                  </p>
                </div>
                ${NO_REPLY_FOOTER}
              </div>`,
          });
          sent++;
        } catch (e) {
          errors.push(`${o.email}: ${e.message}`);
        }
      }
      await client.close();

      if (errors.length > 0) {
        return new Response(JSON.stringify({ success: sent > 0, count: sent, msg: "Some failed: " + errors.join(" | ") }), { headers: cors });
      }
      return new Response(JSON.stringify({ success: true, count: sent }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (action === "toggle_schedule_locked") {
      const { gameId, locked } = payload;

      if (locked) {
        // Read the live, admin-configured position list instead of a hardcoded
        // array, so disabled positions don't block locking. Crew Chief is a
        // designation flag (not a fillable position) and was never counted here.
        const { data: activePositions } = await supabase
          .from("position_settings")
          .select("position")
          .eq("enabled", true);
        let requiredPositions = (activePositions || []).map((p: any) => p.position);

        const { data: gameRow } = await supabase.from("games").select("type").eq("id", gameId).maybeSingle();
        if (gameRow?.type === "(PRE)") {
          const PRESEASON_EXCLUDED = ["PLUS/MINUS", "VIDEO TECH", "VIDEO REPLAY"];
          requiredPositions = requiredPositions.filter((p: string) => !PRESEASON_EXCLUDED.includes(p));
        }

        const { data: assignments } = await supabase.from("assignments").select("position").eq("game_id", gameId);
        const filledPositions = new Set((assignments || []).map((a: any) => a.position));
        const vacantCount = requiredPositions.filter(p => !filledPositions.has(p)).length;
        if (vacantCount > 0) {
          return new Response(JSON.stringify({ success: false, msg: `${vacantCount} position(s) still vacant` }), { status: 400, headers: cors });
        }
      }

      const { error } = await supabase.from("games").update({ schedule_locked: locked }).eq("id", gameId);
      if (error) throw error;
      return ok(cors);
    }

    if (action === "toggle_fixed_role") {
      const { officialId, position, assigned } = payload;
      const posUpper = position.toUpperCase();
      if (assigned) {
        const { error } = await supabase
          .from("role_restrictions")
          .upsert({ official_id: officialId, position: posUpper }, { onConflict: "position,official_id" });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("role_restrictions")
          .delete()
          .eq("official_id", officialId)
          .eq("position", posUpper);
        if (error) throw error;
      }
      return ok(cors);
    }

    if (action === "toggle_skill") {
      const { officialId, position, qualified } = payload;
      if (qualified) {
        const { error } = await supabase
          .from("official_skills")
          .upsert({ official_id: officialId, position: position.toUpperCase() }, { onConflict: "official_id,position" });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("official_skills")
          .delete()
          .eq("official_id", officialId)
          .eq("position", position.toUpperCase());
        if (error) throw error;
      }
      return ok(cors);
    }

    if (action === "toggle_position") {
      const { position, enabled } = payload;
      if (!position || typeof enabled !== "boolean") {
        return new Response(JSON.stringify({ success: false, msg: "Missing position or enabled value" }), { status: 400, headers: cors });
      }
      const { error } = await supabase
        .from("position_settings")
        .update({ enabled })
        .eq("position", position.toUpperCase());
      if (error) throw error;
      return ok(cors);
    }

    return new Response(JSON.stringify({ success: false, msg: "Unknown action" }), { status: 400, headers: cors });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers: cors });
  }
});

function ok(cors: Record<string, string>) {
  return new Response(JSON.stringify({ success: true }), { headers: { ...cors, "Content-Type": "application/json" } });
}
