do $$
begin
  if exists (select 1 from public.user_credentials limit 1)
     or exists (select 1 from public.user_onboarding_audit limit 1)
     or exists (select 1 from public.user_onboarding_rate_limits limit 1) then
    raise exception 'USER_ONBOARDING_DATA_PRESENT';
  end if;
end;
$$;

drop function if exists public.consume_user_onboarding_limit(text, integer, timestamptz, integer);
drop table if exists public.user_onboarding_rate_limits;
drop table if exists public.user_onboarding_audit;
drop table if exists public.user_credentials;

alter table public.auth_nonces
  drop constraint if exists auth_nonces_purpose_check;
delete from public.auth_nonces where purpose = 'user_auth';
alter table public.auth_nonces
  add constraint auth_nonces_purpose_check
  check (purpose in ('buyer_auth', 'vendor_auth', 'intent', 'link_wallet', 'review'));
