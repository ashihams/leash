-- Provider evidence. These rows do not authorize a payment.
-- Store wallet, session id, status, and expiry only.

alter table public.check_results
  add column if not exists provider text not null default '';

alter table public.check_results
  add column if not exists environment text not null default '';

create table public.identity_verifications (
  vendor_wallet text primary key,
  provider text not null,
  session_id text not null unique,
  status text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.webhook_events (
  id text primary key,
  provider text not null,
  session_id text not null,
  received_at timestamptz not null default now(),
  verified boolean not null
);

alter table public.identity_verifications enable row level security;
alter table public.webhook_events enable row level security;

revoke all on public.identity_verifications from public, anon, authenticated;
revoke all on public.webhook_events from public, anon, authenticated;

grant select on public.identity_verifications to authenticated;
grant select on public.webhook_events to authenticated;
grant all privileges on public.identity_verifications to service_role;
grant all privileges on public.webhook_events to service_role;

create policy identity_select_staff
  on public.identity_verifications
  for select
  to authenticated
  using (public.current_profile_role() in ('owner', 'reviewer', 'auditor'));

create policy webhook_events_select_staff
  on public.webhook_events
  for select
  to authenticated
  using (public.current_profile_role() in ('owner', 'reviewer', 'auditor'));
