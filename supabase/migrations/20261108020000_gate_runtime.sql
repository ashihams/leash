-- Operational gate rows. The service role is the only client.
-- Solana remains the source of truth for balances.

create table public.gate_vendors (
  wallet text primary key,
  name text not null,
  country text not null,
  blocked smallint not null
);

create table public.gate_mandates (
  mandate_id bigint primary key,
  mandate text not null,
  owner text not null,
  agent text not null,
  budget bigint not null,
  spent bigint not null,
  per_payment_limit bigint not null,
  max_uses integer not null,
  uses integer not null,
  expires_at bigint not null,
  delivery_seconds integer not null,
  acceptance_seconds integer not null,
  category integer not null,
  revoked smallint not null,
  corridors jsonb not null
);

create table public.gate_corridors (
  from_country text not null,
  to_country text not null,
  enabled smallint not null,
  per_payment_cap bigint not null,
  daily_cap bigint not null,
  daily_spent bigint not null,
  spent_day integer not null,
  packet_threshold bigint not null,
  primary key (from_country, to_country)
);

create table public.gate_payments (
  payment_id text primary key,
  mandate_id bigint not null,
  mandate text not null,
  buyer text not null,
  agent text not null,
  vendor text not null,
  mint text not null,
  amount bigint not null,
  from_country text not null,
  to_country text not null,
  category integer not null,
  purpose_code integer not null,
  invoice_hash text not null,
  invoice_amount bigint not null,
  packet_hash text not null,
  state text not null,
  receipt_hash text,
  verification_hash text,
  delivery_deadline bigint not null,
  acceptance_deadline bigint not null
);

create table public.gate_evidence (
  id bigint generated always as identity primary key,
  created_at bigint not null,
  kind text not null,
  decision text not null,
  payment_id text not null,
  mandate text not null,
  buyer text not null,
  vendor text not null,
  amount bigint not null,
  reasons jsonb not null,
  checks_run integer not null,
  checks_failed integer not null,
  clearance_hash text not null,
  forced boolean not null
);

alter table public.gate_vendors enable row level security;
alter table public.gate_mandates enable row level security;
alter table public.gate_corridors enable row level security;
alter table public.gate_payments enable row level security;
alter table public.gate_evidence enable row level security;

revoke all on public.gate_vendors from public, anon, authenticated;
revoke all on public.gate_mandates from public, anon, authenticated;
revoke all on public.gate_corridors from public, anon, authenticated;
revoke all on public.gate_payments from public, anon, authenticated;
revoke all on public.gate_evidence from public, anon, authenticated;

grant all privileges on public.gate_vendors to service_role;
grant all privileges on public.gate_mandates to service_role;
grant all privileges on public.gate_corridors to service_role;
grant all privileges on public.gate_payments to service_role;
grant all privileges on public.gate_evidence to service_role;
grant usage, select on sequence public.gate_evidence_id_seq to service_role;
