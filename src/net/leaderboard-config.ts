/** Leaderboard backend base URL — the cod-leaderboard edge function in the
 *  shared 67lab.website Supabase project (source-tracked at
 *  supabase/functions/cod-leaderboard/index.ts). No API key needed: the
 *  endpoint is public by design and does its own validation/rate limiting.
 *  This host must stay listed in vercel.json's connect-src or prod CSP
 *  silently kills the board (harness memory #13).
 *
 *  Empty string = the board is offline: every fetch/submit short-circuits to
 *  an unreachable result with zero network calls, and the UI renders its
 *  real offline state instead of ever showing placeholder or sample data. */
export const LEADERBOARD_BASE_URL =
  'https://jjgarzufcuckokvsznsz.supabase.co/functions/v1/cod-leaderboard';
