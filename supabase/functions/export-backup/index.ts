// supabase/functions/export-backup/index.ts
// Exports all key tables as one JSON file and emails it via Gmail SMTP.
// Can be called manually (Admin token required) or by pg_cron (no token — same
// pattern as sync-ohl-schedule, since this only reads data and sends it to a
// fixed address, no user-supplied data involved).
//
// Sent FROM the portal mailbox (GMAIL_ADDRESS) TO BACKUP_EMAIL, so backups reach
// a monitored inbox even when the portal sends from an unmonitored account.
// Falls back to GMAIL_ADDRESS if BACKUP_EMAIL isn't set.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const JWT_SECRET = Deno.env.get("PORTAL_JWT_SECRET")!;
const GMAIL_ADDRESS = Deno.env.get("GMAIL_ADDRESS")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
const BACKUP_EMAIL = Deno.env.get("BACKUP_EMAIL") || GMAIL_ADDRESS;
const FROM_NAME = "IceDogs Off-Ice Officials";

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

const TABLES = [
  "officials", "games", "assignments", "availability", "teams",
  "role_restrictions", "official_skills", "broadcasts", "reasons",
  "month_windows", "schedule", "app_settings",
];

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

    const exportData: Record<string, unknown> = {};
    for (const table of TABLES) {
      const { data, error } = await supabase.from(table).select("*");
      exportData[table] = error ? { error: error.message } : data;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const jsonStr = JSON.stringify(exportData, null, 2);
    const jsonBase64 = btoa(unescape(encodeURIComponent(jsonStr)));

    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: GMAIL_ADDRESS, password: GMAIL_APP_PASSWORD },
      },
    });

    await client.send({
      from: `${FROM_NAME} <${GMAIL_ADDRESS}>`,
      to: BACKUP_EMAIL,
      subject: `IceDogs Portal Backup — ${dateStr}`,
      content: `Automatic backup of the IceDogs Officials Portal database, generated ${dateStr}.\n\nAttached as JSON. Keep this somewhere safe.\n\nThis email was sent from an unmonitored mailbox. Please do not reply.`,
      attachments: [
        {
          filename: `icedogs-backup-${dateStr}.json`,
          content: jsonBase64,
          encoding: "base64",
          contentType: "application/json",
        },
      ],
    });
    await client.close();

    return new Response(JSON.stringify({ success: true, tablesExported: TABLES.length, sentTo: BACKUP_EMAIL }), { headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers: cors });
  }
});
