-- Provider evidence also covers refusals, which have no funded payment row.
create table if not exists public.gate_provider_checks (
  id uuid primary key,
  payment_id text,
  wallet text not null,
  check_id text not null,
  status text not null check (status in ('pass', 'flag', 'fail')),
  reason_code text not null,
  evidence_hash text not null,
  provider text not null,
  environment text not null,
  public_note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists gate_provider_checks_payment on public.gate_provider_checks(payment_id);
alter table public.gate_provider_checks enable row level security;
revoke all on public.gate_provider_checks from public, anon, authenticated;
grant all privileges on public.gate_provider_checks to service_role;
