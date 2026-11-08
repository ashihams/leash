create table if not exists public.user_credentials (
  wallet text primary key,
  status text not null default 'Pending',
  phase text not null default 'Connect Phantom',
  didit_session_id text,
  session_url text,
  kyc_ref_hash text,
  screening_list_hash text,
  screening_list_version integer,
  screened_at timestamptz,
  expires_at timestamptz,
  attest_tx text,
  revoke_tx text,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_onboarding_audit (
  id bigint generated always as identity primary key,
  wallet text not null,
  action text not null,
  status text not null,
  session_ref_hash text,
  tx_signature text,
  created_at timestamptz not null default now()
);

create table if not exists public.user_onboarding_rate_limits (
  bucket_hash text primary key,
  reset_at timestamptz not null,
  attempts integer not null
);

create or replace function public.consume_user_onboarding_limit(
  p_bucket_hash text,
  p_limit integer,
  p_now timestamptz,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_attempts integer;
begin
  insert into public.user_onboarding_rate_limits(bucket_hash, reset_at, attempts)
  values (p_bucket_hash, p_now + make_interval(secs => p_window_seconds), 1)
  on conflict (bucket_hash) do update set
    attempts = case when user_onboarding_rate_limits.reset_at <= p_now then 1 else user_onboarding_rate_limits.attempts + 1 end,
    reset_at = case when user_onboarding_rate_limits.reset_at <= p_now then p_now + make_interval(secs => p_window_seconds) else user_onboarding_rate_limits.reset_at end
  returning attempts into current_attempts;
  return current_attempts <= p_limit;
end;
$$;

alter table public.user_credentials enable row level security;
alter table public.user_onboarding_audit enable row level security;
alter table public.user_onboarding_rate_limits enable row level security;
revoke all on public.user_credentials, public.user_onboarding_audit, public.user_onboarding_rate_limits from anon, authenticated;
grant all on public.user_credentials, public.user_onboarding_audit, public.user_onboarding_rate_limits to service_role;
revoke all on function public.consume_user_onboarding_limit(text, integer, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.consume_user_onboarding_limit(text, integer, timestamptz, integer) to service_role;
grant usage, select on sequence public.user_onboarding_audit_id_seq to service_role;

-- Cache the latest provider decision so polling does not repeatedly call Didit.
-- This contains only the decision and check time, never provider documents or identity fields.
alter table public.user_credentials add column if not exists provider_status text;
alter table public.user_credentials add column if not exists provider_checked_at timestamptz;
