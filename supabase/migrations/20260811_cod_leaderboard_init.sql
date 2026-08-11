-- Applied 2026-08-11 to the shared 67lab.website project (jjgarzufcuckokvsznsz)
-- via MCP apply_migration. This file is the repo-tracked source of truth.
-- Cat of Duty leaderboard (cod_ prefix — shared multi-product DB).
-- RLS enabled with NO policies on purpose: anon/authenticated are denied
-- entirely; all access goes through the cod-leaderboard edge function
-- (service role), which owns validation, plausibility gates, rate limiting.

create table public.cod_scores (
  id uuid primary key default gen_random_uuid(),
  callsign text not null check (callsign ~ '^[A-Z0-9_-]{3,12}$'),
  score integer not null check (score between 0 and 10000000),
  wave integer not null check (wave between 1 and 200),
  kills integer not null check (kills between 0 and 20000),
  accuracy real not null check (accuracy between 0 and 100),
  duration_s integer not null check (duration_s between 10 and 14400),
  mode text not null default 'solo' check (mode in ('solo', 'coop')),
  client_id text not null check (char_length(client_id) <= 64),
  -- ISO year-week, server clock — clients never supply time-derived fields.
  week text not null default to_char(timezone('utc', now()), 'IYYY-IW'),
  created_at timestamptz not null default now()
);
alter table public.cod_scores enable row level security;
create index cod_scores_score_idx on public.cod_scores (score desc);
create index cod_scores_week_score_idx on public.cod_scores (week, score desc);

-- Short-lived per-IP-hash submit throttle; rows pruned by the function.
create table public.cod_rate_events (
  ip_hash text not null,
  ts timestamptz not null default now()
);
alter table public.cod_rate_events enable row level security;
create index cod_rate_events_idx on public.cod_rate_events (ip_hash, ts);

-- (second migration, cod_current_week_fn) One clock for the board: reads
-- filter by the same server-computed ISO week that cod_scores.week defaults
-- to on insert.
create or replace function public.cod_current_week()
returns text
language sql
stable
as $$ select to_char(timezone('utc', now()), 'IYYY-IW') $$;
