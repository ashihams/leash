-- Public OFAC SDN digital-currency addresses. No names or identity documents.
-- Service role only.

create table public.ofac_list_versions (
  id uuid primary key,
  retrieved_at timestamptz not null,
  source_url text not null,
  sha256 text not null,
  address_count integer not null,
  sol_address_count integer not null
);

create table public.ofac_addresses (
  version_id uuid not null references public.ofac_list_versions (id) on delete cascade,
  address text not null,
  currency text not null,
  sdn_entry_id text not null,
  primary key (version_id, address, currency)
);

alter table public.ofac_list_versions enable row level security;
alter table public.ofac_addresses enable row level security;

revoke all on public.ofac_list_versions from public, anon, authenticated;
revoke all on public.ofac_addresses from public, anon, authenticated;

grant all privileges on public.ofac_list_versions to service_role;
grant all privileges on public.ofac_addresses to service_role;
