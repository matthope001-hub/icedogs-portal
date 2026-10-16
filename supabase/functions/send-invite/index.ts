// supabase/functions/send-invite/index.ts
// Admin-only: generates a one-time invite token for an official and emails them a link.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const JWT_SECRET = Deno.env.get("PORTAL_JWT_SECRET")!;
const GMAIL_ADDRESS = Deno.env.get("GMAIL_ADDRESS")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
const PORTAL_URL = "https://icedogofficials.ca";
// Display name shown in officials' inboxes. Override with the EMAIL_FROM_NAME secret.
const FROM_NAME = Deno.env.get("EMAIL_FROM_NAME") || "IceDogs Officials Portal";
// Shown at the bottom of every portal email — the sending mailbox isn't monitored.
const NO_REPLY_FOOTER = `<p style="color:#999; font-size:11px; text-align:center; margin:16px 0 0; line-height:1.5;">This email was sent from an unmonitored mailbox. Please do not reply &mdash; contact an IceDogs off-ice admin directly with any questions.</p>`;

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

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const { token, officialName, email } = await req.json();

    const session = await verifyAdmin(token);
    if (!session) {
      return new Response(JSON.stringify({ success: false, msg: "Admin access required" }), { status: 403, headers: cors });
    }

    if (!officialName || !email) {
      return new Response(JSON.stringify({ success: false, msg: "Official name and email are required" }), { status: 400, headers: cors });
    }

    const inviteToken = crypto.randomUUID().replace(/-/g, "");

    const { error: insertError } = await supabase.from("profile_tokens").insert({
      token: inviteToken,
      official_name: officialName,
      email,
      created_at: new Date().toISOString(),
    });
    if (insertError) throw insertError;

    const inviteUrl = `${PORTAL_URL}?invite=${inviteToken}`;
    const firstName = officialName.split(" ")[0];

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
      to: email,
      subject: "You're Invited - Niagara IceDogs Off-Ice Officials Portal",
      html: `
        <div style="font-family:Arial,sans-serif; max-width:500px; margin:0 auto;">
          <div style="background:#C8102E; padding:24px; text-align:center; border-radius:12px 12px 0 0;">
            <h2 style="color:white; margin:0; font-size:20px; text-transform:uppercase;">Niagara IceDogs</h2>
            <p style="color:rgba(255,255,255,0.85); margin:6px 0 0; font-size:13px;">Off-Ice Officials Portal</p>
          </div>
          <div style="background:#f9f9f9; padding:28px; border-radius:0 0 12px 12px; border:1px solid #eee;">
            <p style="color:#1a1a1a; font-size:15px;">Hi ${firstName},</p>
            <p style="color:#444; font-size:14px; line-height:1.6;">Please complete your profile to access the Off-Ice Officials Portal for the new season. This link is personal to you and can only be used once.</p>
            <p style="text-align:center; margin:28px 0;">
              <a href="${inviteUrl}" style="background:#C8102E; color:white; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:15px; display:inline-block;">Complete My Profile &rarr;</a>
            </p>
            <p style="color:#888; font-size:12px;">If the button doesn't work, copy and paste this link:<br>
            <a href="${inviteUrl}" style="color:#C8102E;">${inviteUrl}</a></p>
          </div>
          ${NO_REPLY_FOOTER}
        </div>`,
      content: `Hi ${firstName},\n\nPlease complete your profile to access the Off-Ice Officials Portal for the new season. This link is personal to you and can only be used once:\n\n${inviteUrl}\n\n--\nNiagara IceDogs Off-Ice Officials Portal\nThis email was sent from an unmonitored mailbox. Please do not reply - contact an IceDogs off-ice admin directly with any questions.`,
    });
    await client.close();

    // Track that an invite was sent, so admins can see who's been invited
    // (and when) without cross-referencing profile_tokens.
    await supabase.from("officials").update({ invite_sent_at: new Date().toISOString() }).eq("name", officialName);

    return new Response(JSON.stringify({ success: true }), { headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers: cors });
  }
});
