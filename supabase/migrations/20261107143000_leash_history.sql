-- Leash history, evidence, reviews, and login.
-- Solana is the source of truth for balances, mandates, and escrow.
-- These tables are a record. They do not authorize a payment.

create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role text not null default 'auditor' check (role in ('owner', 'reviewer', 'auditor')),
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create table public.linked_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  wallet text not null unique,
  kind text not null check (kind in ('owner', 'reviewer')),
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.vendors (
  wallet text primary key,
  name text not null,
  country char(2) not null,
  category integer not null default 0,
  status text not null default 'active' check (status in ('active', 'suspended')),
  credential_expires_at timestamptz,
  credential_is_mock boolean not null default true
);

create table public.screening_list (
  wallet text primary key,
  list_version bigint not null default 1,
  label text not null default 'MOCK LIST - demo only'
);

create table public.payment_history (
  payment_id text primary key,
  buyer text not null,
  vendor text not null,
  amount_usdc bigint not null,
  status text not null check (
    status in ('funded', 'delivered', 'verified', 'released', 'refunded', 'disputed')
  ),
  created_at timestamptz not null default now()
);

create index payment_history_vendor_created_idx
  on public.payment_history (vendor, created_at);

create index payment_history_buyer_created_idx
  on public.payment_history (buyer, created_at);

create table public.clearances (
  payment_id text primary key,
  decision text not null check (decision in ('allow', 'review', 'deny')),
  checks_run bigint not null,
  checks_failed bigint not null,
  policy_version bigint not null,
  list_version bigint not null,
  expires_at timestamptz not null,
  signature text not null,
  created_at timestamptz not null default now()
);

create table public.check_results (
  id uuid primary key default gen_random_uuid(),
  payment_id text not null,
  check_id text not null,
  status text not null check (status in ('pass', 'flag', 'fail')),
  reason_code text not null default '',
  evidence_hash text not null default '',
  created_at timestamptz not null default now()
);

create index check_results_payment_idx on public.check_results (payment_id, created_at);

create table public.review_queue (
  payment_id text primary key,
  flagged jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'denied', 'timed_out')
  ),
  reviewer_user_id uuid references public.profiles (id),
  reviewer_wallet text,
  reviewer_signature text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table public.auth_nonces (
  nonce text primary key,
  wallet text not null,
  purpose text not null check (
    purpose in ('buyer_auth', 'vendor_auth', 'intent', 'link_wallet', 'review')
  ),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  used boolean not null default false
);

create index auth_nonces_wallet_idx on public.auth_nonces (wallet, expires_at);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('user', 'wallet', 'system')),
  actor_id text not null,
  action text not null,
  payment_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_payment_idx on public.audit_log (payment_id, created_at);

create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

revoke all on function public.current_profile_role() from public, anon;
grant execute on function public.current_profile_role() to authenticated, service_role;

-- New dashboard users are auditors. The role is not copied from user metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role, display_name)
  values (
    new.id,
    new.email,
    'auditor',
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      split_part(coalesce(new.email, 'user'), '@', 1)
    )
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A signed-in user cannot change profiles.role. The service role and the
-- database owner can. auth.role() reads the JWT, not a client-supplied field.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role then
    if auth.role() = 'service_role'
      or current_user in ('postgres', 'supabase_admin', 'service_role') then
      return new;
    end if;
    raise exception 'role cannot be changed by the user' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_role_guard on public.profiles;
create trigger profiles_role_guard
  before update on public.profiles
  for each row execute function public.protect_profile_role();

-- audit_log is append-only. The database owner can still maintain it.
-- service_role bypasses RLS, so the trigger is what stops an update or delete.
create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  raise exception 'audit_log is append-only' using errcode = '42501';
end;
$$;

drop trigger if exists audit_log_append_only on public.audit_log;
create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.reject_audit_mutation();

-- Runs as the database owner so the seed can clear demo rows, including audit_log.
create or replace function public.wipe_demo_history()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.check_results;
  delete from public.review_queue;
  delete from public.clearances;
  delete from public.payment_history;
  delete from public.audit_log;
  delete from public.auth_nonces;
  delete from public.linked_wallets;
  delete from public.screening_list;
  delete from public.vendors;
end;
$$;

revoke all on function public.wipe_demo_history() from public, anon, authenticated;
grant execute on function public.wipe_demo_history() to service_role;

-- Auditors and reviewers see display name and role, not email.
create or replace view public.profile_directory
with (security_barrier = true, security_invoker = false) as
select p.id, p.display_name, p.role
from public.profiles p
where exists (
  select 1
  from public.profiles me
  where me.id = auth.uid()
    and me.role in ('auditor', 'reviewer')
);

revoke all on public.profiles from public, anon, authenticated;
revoke all on public.linked_wallets from public, anon, authenticated;
revoke all on public.vendors from public, anon, authenticated;
revoke all on public.screening_list from public, anon, authenticated;
revoke all on public.payment_history from public, anon, authenticated;
revoke all on public.clearances from public, anon, authenticated;
revoke all on public.check_results from public, anon, authenticated;
revoke all on public.review_queue from public, anon, authenticated;
revoke all on public.auth_nonces from public, anon, authenticated;
revoke all on public.audit_log from public, anon, authenticated;
revoke all on public.profile_directory from public, anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.linked_wallets to authenticated;
grant select on public.vendors to authenticated;
grant select on public.screening_list to authenticated;
grant select on public.payment_history to authenticated;
grant select on public.clearances to authenticated;
grant select on public.check_results to authenticated;
grant select on public.review_queue to authenticated;
grant select on public.audit_log to authenticated;
grant select on public.profile_directory to authenticated;

grant all privileges on public.profiles to service_role;
grant all privileges on public.linked_wallets to service_role;
grant all privileges on public.vendors to service_role;
grant all privileges on public.screening_list to service_role;
grant all privileges on public.payment_history to service_role;
grant all privileges on public.clearances to service_role;
grant all privileges on public.check_results to service_role;
grant all privileges on public.review_queue to service_role;
grant all privileges on public.auth_nonces to service_role;
grant all privileges on public.audit_log to service_role;

alter table public.profiles enable row level security;
alter table public.linked_wallets enable row level security;
alter table public.vendors enable row level security;
alter table public.screening_list enable row level security;
alter table public.payment_history enable row level security;
alter table public.clearances enable row level security;
alter table public.check_results enable row level security;
alter table public.review_queue enable row level security;
alter table public.auth_nonces enable row level security;
alter table public.audit_log enable row level security;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy profiles_update_own_name
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy linked_wallets_select_own
  on public.linked_wallets
  for select
  to authenticated
  using (user_id = auth.uid());

create policy vendors_select_authenticated
  on public.vendors
  for select
  to authenticated
  using (true);

create policy screening_select_authenticated
  on public.screening_list
  for select
  to authenticated
  using (true);

create policy payment_history_select_staff
  on public.payment_history
  for select
  to authenticated
  using (public.current_profile_role() in ('owner', 'reviewer', 'auditor'));

create policy clearances_select_staff
  on public.clearances
  for select
  to authenticated
  using (public.current_profile_role() in ('owner', 'reviewer', 'auditor'));

create policy check_results_select_staff
  on public.check_results
  for select
  to authenticated
  using (public.current_profile_role() in ('owner', 'reviewer', 'auditor'));

create policy audit_log_select_staff
  on public.audit_log
  for select
  to authenticated
  using (public.current_profile_role() in ('owner', 'reviewer', 'auditor'));

create policy review_queue_select_reviewer
  on public.review_queue
  for select
  to authenticated
  using (public.current_profile_role() = 'reviewer');

-- No insert, update, or delete policies for anon or authenticated.
-- Those writes go through the server, which uses the service key.
-- auth_nonces has no policies for authenticated users.
