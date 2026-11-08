create table public.agent_runs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  goal text not null check (length(goal) between 1 and 1000),
  steps jsonb not null default '[]'::jsonb,
  final jsonb,
  created_at timestamptz not null default now()
);
-- Atomic across serverless instances; failed runs also consume the minute.
create unique index agent_runs_user_minute on public.agent_runs
  (user_id, date_trunc('minute', created_at at time zone 'UTC'));
alter table public.agent_runs enable row level security;
revoke all on public.agent_runs from public, anon, authenticated;
grant select, insert, update on public.agent_runs to service_role;
