// supabase/functions/save-availability/index.ts
// Verifies the session token, checks the month's window is open, then upserts
// availability rows for the logged-in official.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function verifyToken(token: string): Promise<{ id: string; name: string; role: string } | null> {
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
    const { token, month, results } = await req.json();

    const session = await verifyToken(token);
    if (!session) {
      return new Response(JSON.stringify({ success: false, msg: "Invalid or expired session" }), { status: 401, headers: cors });
    }

    if (!Array.isArray(results) || results.length === 0) {
      return new Response(JSON.stringify({ success: false, msg: "No results provided" }), { status: 400, headers: cors });
    }

    // Window must be open. A scheduled close time is enforced to the minute,
    // even before the 15-minute scheduler has flipped the status. Once the
    // scheduler has processed the close, a manual re-open (toggle on) is honoured.
    const { data: win } = await supabase
      .from("month_windows")
      .select("status, closes_at, close_email_sent_at")
      .eq("month", month)
      .maybeSingle();
    const pastScheduledClose = win && win.closes_at && !win.close_email_sent_at && Date.now() > new Date(win.closes_at).getTime();
    if (!win || win.status !== "Active" || pastScheduledClose) {
      return new Response(JSON.stringify({ success: false, msg: "This availability window is closed." }), { headers: cors });
    }

    // Check if already submitted for this month (mirrors original alreadySubmitted logic)
    const gameNumbers = results.map((r: any) => r.gameId.toString());
    const { data: games } = await supabase
      .from("games")
      .select("id, game_number")
      .in("game_number", gameNumbers);

    const gameByNumber: Record<string, string> = {};
    (games || []).forEach((g: any) => { gameByNumber[g.game_number] = g.id; });

    const { data: existing } = await supabase
      .from("availability")
      .select("game_id")
      .eq("official_id", session.id)
      .in("game_id", Object.values(gameByNumber));

    const existingSet = new Set((existing || []).map((e: any) => e.game_id));
    const allAlreadySubmitted = Object.values(gameByNumber).every((gid) => existingSet.has(gid));
    if (allAlreadySubmitted) {
      return new Response(JSON.stringify({ success: false, alreadySubmitted: true }), { headers: cors });
    }

    const rows = results
      .filter((r: any) => gameByNumber[r.gameId.toString()])
      .map((r: any) => ({
        official_id: session.id,
        game_id: gameByNumber[r.gameId.toString()],
        month: month,
        status: r.status,
        reason: r.status === "Not Available" ? (r.reason || null) : null,
        submitted_at: new Date().toISOString(),
        submitted_by: session.name,
      }));

    const { error } = await supabase
      .from("availability")
      .upsert(rows, { onConflict: "official_id,game_id" });

    if (error) {
      return new Response(JSON.stringify({ success: false, msg: error.message }), { status: 500, headers: cors });
    }

    return new Response(JSON.stringify({ success: true }), { headers: { ...cors, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: e.message }), { status: 500, headers: cors });
  }
});
