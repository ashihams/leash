alter table public.auth_nonces
  drop constraint if exists auth_nonces_purpose_check;

alter table public.auth_nonces
  add constraint auth_nonces_purpose_check
  check (purpose in ('buyer_auth', 'user_auth', 'vendor_auth', 'intent', 'link_wallet', 'review'));
