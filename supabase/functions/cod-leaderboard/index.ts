// Cat of Duty leaderboard — single public endpoint (verify_jwt OFF by design:
// the game has no accounts, so there is no JWT to verify; THIS code is the
// gate). Deployed into the shared 67lab.website Supabase project, hence the
// cod- prefix on the function and cod_ on tables. Contract (client:
// src/net/Leaderboard.ts):
//   GET  /board?window=week|all -> { ok, rows: [{callsign, score, wave, ts}] }
//   POST /submit {callsign, score, wave, kills, accuracy, duration_s,
//                 client_id}   -> { ok, rankWeek, rankAll, totalWeek }
// Abuse posture: strict schema + plausibility gates + per-IP-hash throttle,
// all rejections a generic 400 {ok:false} (never explain to a bot why).
// Spoof-RESISTANT, not cheat-proof — the board is wipeable and Terms say so.
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ALLOWED_ORIGINS = [/^https:\/\/cat-of-duty\.vercel\.app$/, /^http:\/\/127\.0\.0\.1:\d+$/];
// Callsigns are public on a board strangers see — keep the floor high.
const BLOCKED = ["FUCK", "SHIT", "CUNT", "NIGG", "FAGG", "RAPE", "NAZI", "HITLER", "KKK", "PORN", "SEX", "DICK", "COCK", "PUSSY", "WHORE", "SLUT", "BITCH", "ANAL", "CUM", "JIZZ", "PEDO", "TWAT"];
const RATE_LIMIT_PER_HOUR = 10;
const IP_SALT = "cod-board-2026"; // privacy hygiene for stored hashes, not a secret

function cors(origin: string | null): HeadersInit {
  const ok = origin !== null && ALLOWED_ORIGINS.some((re) => re.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : "https://cat-of-duty.vercel.app",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Content-Type": "application/json",
  };
}

const reject = (h: HeadersInit) => new Response(JSON.stringify({ ok: false }), { status: 400, headers: h });

async function ipHash(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(IP_SALT + ip));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleBoard(url: URL, h: HeadersInit): Promise<Response> {
  const window_ = url.searchParams.get("window") === "all" ? "all" : "week";
  let q = supabase.from("cod_scores")
    .select("callsign, score, wave, created_at")
    .order("score", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(50);
  if (window_ === "week") {
    const { data: wk, error: wkErr } = await supabase.rpc("cod_current_week");
    if (wkErr) return reject(h);
    q = q.eq("week", wk);
  }
  const { data, error } = await q;
  if (error) return reject(h);
  const rows = (data ?? []).map((r) => ({ callsign: r.callsign, score: r.score, wave: r.wave, ts: r.created_at }));
  return new Response(JSON.stringify({ ok: true, rows }), {
    headers: { ...h, "Cache-Control": "public, max-age=30" },
  });
}

async function handleSubmit(req: Request, h: HeadersInit): Promise<Response> {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return reject(h);
  }
  const callsign = typeof b.callsign === "string" ? b.callsign : "";
  const score = Number(b.score), wave = Number(b.wave), kills = Number(b.kills);
  const accuracy = Number(b.accuracy), duration = Number(b.duration_s);
  const clientId = typeof b.client_id === "string" ? b.client_id : "";

  const shapeOk =
    /^[A-Z0-9_-]{3,12}$/.test(callsign) &&
    !BLOCKED.some((w) => callsign.includes(w)) &&
    Number.isInteger(score) && score >= 0 && score <= 10_000_000 &&
    Number.isInteger(wave) && wave >= 1 && wave <= 200 &&
    Number.isInteger(kills) && kills >= 0 && kills <= 20_000 &&
    Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100 &&
    Number.isInteger(duration) && duration >= 10 && duration <= 14_400 &&
    clientId.length > 0 && clientId.length <= 64;
  // Plausibility ceilings: ~2-3x the real theoretical max per wave reached,
  // loose enough to never reject a legit run, tight enough to bin nonsense.
  const plausible = score <= wave * 40_000 + 50_000 && kills <= wave * 14 + 10 && duration >= wave * 8;
  if (!shapeOk || !plausible) return reject(h);

  const hash = await ipHash(req);
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error: rlErr } = await supabase
    .from("cod_rate_events").select("*", { count: "exact", head: true })
    .eq("ip_hash", hash).gte("ts", hourAgo);
  if (rlErr || (count ?? 0) >= RATE_LIMIT_PER_HOUR) return reject(h);
  await supabase.from("cod_rate_events").insert({ ip_hash: hash });
  // Opportunistic prune keeps the throttle table tiny in the shared DB.
  await supabase.from("cod_rate_events").delete().lt("ts", new Date(Date.now() - 7_200_000).toISOString());

  const { data: inserted, error: insErr } = await supabase
    .from("cod_scores")
    .insert({ callsign, score, wave, kills, accuracy, duration_s: duration, client_id: clientId, mode: "solo" })
    .select("week").single();
  if (insErr || !inserted) return reject(h);

  const [wkRank, allRank, wkTotal] = await Promise.all([
    supabase.from("cod_scores").select("*", { count: "exact", head: true }).eq("week", inserted.week).gt("score", score),
    supabase.from("cod_scores").select("*", { count: "exact", head: true }).gt("score", score),
    supabase.from("cod_scores").select("*", { count: "exact", head: true }).eq("week", inserted.week),
  ]);
  if (wkRank.error || allRank.error || wkTotal.error) return reject(h);
  return new Response(
    JSON.stringify({
      ok: true,
      rankWeek: (wkRank.count ?? 0) + 1,
      rankAll: (allRank.count ?? 0) + 1,
      totalWeek: wkTotal.count ?? 0,
    }),
    { headers: h },
  );
}

Deno.serve(async (req: Request) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname.endsWith("/board")) return await handleBoard(url, h);
    if (req.method === "POST" && url.pathname.endsWith("/submit")) return await handleSubmit(req, h);
  } catch {
    return reject(h);
  }
  return reject(h);
});
