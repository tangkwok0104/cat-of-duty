/** LEADERBOARD — fetch client for the (not-yet-built) solo leaderboard
 *  backend. Fixed JSON contract, owned by the orchestrator:
 *    GET  {BASE}/board?window=week|all -> { ok: true, rows: BoardRow[] }
 *    POST {BASE}/submit                -> { ok: true, rankWeek, rankAll, totalWeek }
 *
 *  LEADERBOARD_BASE_URL is '' until the backend wave ships (see
 *  leaderboard-config.ts) — every call here short-circuits to an
 *  unreachable result with NO network request in that state, and that
 *  short-circuit is not logged (it's the expected Phase-1 state, not a
 *  failure). Genuine failures (timeout, network error, malformed shape)
 *  fail silent-safe into `{ ok: false }` with at most one console.warn
 *  each — never console.error, never an automatic retry loop. Callers
 *  (TopCats.ts, Hud.ts) decide what the unreachable state looks like on
 *  screen; this module only ever hands back honest ok/not-ok results. */

import { LEADERBOARD_BASE_URL } from './leaderboard-config';

const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 60_000;
const CLIENT_ID_KEY = 'cod-client-id';

export type BoardWindow = 'week' | 'all';

export interface BoardRow {
  callsign: string;
  score: number;
  wave: number;
  ts: string;
}

export type BoardResult = { ok: true; rows: BoardRow[] } | { ok: false };

interface SubmitOk {
  ok: true;
  rankWeek: number;
  rankAll: number;
  totalWeek: number;
}
export type SubmitResult = SubmitOk | { ok: false };

/** GameState-derived fields the caller must supply per submit (wired via
 *  Hud.configureLeaderboard in main.ts). callsign comes from the K.I.A.
 *  input; client_id is managed entirely inside this module — neither is
 *  the caller's concern. */
export interface LeaderboardRunStats {
  score: number;
  wave: number;
  kills: number;
  /** 0-100, integer. */
  accuracy: number;
  duration_s: number;
}

// ---- client_id: one random id per browser, persisted, reused forever ----

let cachedClientId: string | null = null;

function generateClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for a non-secure-context/older browser — this is a dedup key,
  // not a security credential, so Math.random entropy is fine here.
  return `cod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getClientId(): string {
  if (cachedClientId) return cachedClientId;
  try {
    const stored = localStorage.getItem(CLIENT_ID_KEY);
    if (stored) {
      cachedClientId = stored;
      return stored;
    }
    const fresh = generateClientId();
    localStorage.setItem(CLIENT_ID_KEY, fresh);
    cachedClientId = fresh;
    return fresh;
  } catch {
    // Private mode / storage disabled — an in-memory id for this page load
    // is still a valid dedup key for the submits that happen during it.
    cachedClientId = cachedClientId ?? generateClientId();
    return cachedClientId;
  }
}

// ---- fetch with a hard timeout; every failure mode converges here ----

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isBoardRow(x: unknown): x is BoardRow {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.callsign === 'string' &&
    typeof r.score === 'number' &&
    typeof r.wave === 'number' &&
    typeof r.ts === 'string'
  );
}

function isBoardResponse(x: unknown): x is { ok: true; rows: BoardRow[] } {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as { ok?: unknown; rows?: unknown };
  return r.ok === true && Array.isArray(r.rows) && r.rows.every(isBoardRow);
}

function isSubmitResponse(x: unknown): x is SubmitOk {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as { ok?: unknown; rankWeek?: unknown; rankAll?: unknown; totalWeek?: unknown };
  return (
    r.ok === true &&
    typeof r.rankWeek === 'number' &&
    typeof r.rankAll === 'number' &&
    typeof r.totalWeek === 'number'
  );
}

// ---- board: 60s in-memory cache per window, RETRY busts it ----

const boardCache = new Map<BoardWindow, { at: number; result: BoardResult }>();

async function requestBoard(window: BoardWindow): Promise<BoardResult> {
  if (!LEADERBOARD_BASE_URL) return { ok: false }; // offline by design — not a failure, no warn
  try {
    const data = await fetchJson(`${LEADERBOARD_BASE_URL}/board?window=${window}`);
    if (isBoardResponse(data)) return { ok: true, rows: data.rows };
    console.warn('[leaderboard] malformed board response');
    return { ok: false };
  } catch (err) {
    console.warn('[leaderboard] board fetch failed:', err instanceof Error ? err.message : err);
    return { ok: false };
  }
}

/** Fetches a board window. Cached 60s per window; pass `bust: true` (the
 *  panel's RETRY button) to force a fresh request regardless of cache age. */
export async function fetchBoard(window: BoardWindow, opts: { bust?: boolean } = {}): Promise<BoardResult> {
  const cached = boardCache.get(window);
  if (!opts.bust && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }
  const result = await requestBoard(window);
  boardCache.set(window, { at: Date.now(), result });
  return result;
}

// ---- submit: one POST, no retry loop ----

/** Posts a run's result. Never retries automatically — a fresh call (the
 *  player clicking POST SCORE again) is a new deliberate attempt, not part
 *  of a loop this module runs on its own. */
export async function submitScore(stats: LeaderboardRunStats & { callsign: string }): Promise<SubmitResult> {
  if (!LEADERBOARD_BASE_URL) return { ok: false }; // offline by design — not a failure, no warn
  try {
    const body = {
      callsign: stats.callsign,
      score: stats.score,
      wave: stats.wave,
      kills: stats.kills,
      accuracy: stats.accuracy,
      duration_s: stats.duration_s,
      client_id: getClientId(),
    };
    const data = await fetchJson(`${LEADERBOARD_BASE_URL}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (isSubmitResponse(data)) {
      // The new score can reshuffle either window — force both to refetch
      // rather than show a 60s-stale board right after a successful submit.
      boardCache.clear();
      return data;
    }
    console.warn('[leaderboard] malformed submit response');
    return { ok: false };
  } catch (err) {
    console.warn('[leaderboard] submit failed:', err instanceof Error ? err.message : err);
    return { ok: false };
  }
}
