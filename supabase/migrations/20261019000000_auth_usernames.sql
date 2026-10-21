-- Auth-only identity registry. Application profiles/models remain independently owned.
-- Run as the trusted migration owner (normally postgres), never as an end-user role.
-- Supabase's migration runner wraps this file in one transaction, including all ACLs.

create schema scorecontrol_auth;
revoke all on schema scorecontrol_auth from public, anon, authenticated, service_role, supabase_auth_admin;

create function scorecontrol_auth.normalize_username(requested_username text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  canonical text := pg_catalog.lower(pg_catalog.btrim(requested_username) collate "C");
begin
  if canonical is null
     or pg_catalog.char_length(canonical) not between 1 and 39
     or canonical collate "C" !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or canonical in ('admin', 'api', 'auth', 'login', 'logout', 'signup', 'settings', 'support', 'help', 'www', 'scorecontrol') then
    raise exception using errcode = '22023', message = 'Invalid username';
  end if;
  return canonical;
end;
$$;
revoke all on function scorecontrol_auth.normalize_username(text)
  from public, anon, authenticated, service_role, supabase_auth_admin;

create table scorecontrol_auth.usernames (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text collate "C" not null unique,
  constraint usernames_canonical check (username = scorecontrol_auth.normalize_username(username))
);
alter table scorecontrol_auth.usernames enable row level security;
revoke all on table scorecontrol_auth.usernames from public, anon, authenticated, service_role, supabase_auth_admin;
-- No end-user policies: access is only through the service-role RPCs below.

create function public.auth_resolve_username(requested_username text)
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select mapping.user_id, account.email::text
  from scorecontrol_auth.usernames as mapping
  join auth.users as account on account.id = mapping.user_id
  where mapping.username = scorecontrol_auth.normalize_username(requested_username)
    and account.email is not null;
$$;
revoke all on function public.auth_resolve_username(text)
  from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function public.auth_resolve_username(text) to service_role;

create function public.auth_username_for_user(account_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select mapping.username from scorecontrol_auth.usernames as mapping where mapping.user_id = account_id;
$$;
revoke all on function public.auth_username_for_user(uuid)
  from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function public.auth_username_for_user(uuid) to service_role;

create function public.auth_claim_username(account_id uuid, requested_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical text := scorecontrol_auth.normalize_username(requested_username);
  existing text;
begin
  -- Serialize claims for the same account. A username UNIQUE constraint arbitrates
  -- competing accounts; a failed claim rolls back its entire transaction.
  perform account.id from auth.users as account where account.id = account_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'Account does not exist';
  end if;
  select mapping.username into existing from scorecontrol_auth.usernames as mapping where mapping.user_id = account_id;
  if found then return existing; end if;
  insert into scorecontrol_auth.usernames (user_id, username) values (account_id, canonical);
  return canonical;
end;
$$;
revoke all on function public.auth_claim_username(uuid, text)
  from public, anon, authenticated, service_role, supabase_auth_admin;
grant execute on function public.auth_claim_username(uuid, text) to service_role;

create function scorecontrol_auth.register_signup_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Provider is trusted app metadata, not the caller's editable user metadata.
  if new.raw_app_meta_data ->> 'provider' is distinct from 'email' then
    return new;
  end if;
  -- Every email account requires a username. This also covers direct calls to Supabase's signup
  -- API with the public key, which bypass the app. Accounts created before this migration
  -- can claim one through auth_claim_username.
  if pg_catalog.jsonb_typeof(new.raw_user_meta_data -> 'scorecontrol_username') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'A valid username is required';
  end if;
  insert into scorecontrol_auth.usernames (user_id, username)
    values (new.id, scorecontrol_auth.normalize_username(new.raw_user_meta_data ->> 'scorecontrol_username'));
  return new;
end;
$$;
revoke all on function scorecontrol_auth.register_signup_username()
  from public, anon, authenticated, service_role, supabase_auth_admin;

create trigger scorecontrol_register_signup_username
  after insert on auth.users
  for each row execute function scorecontrol_auth.register_signup_username();

comment on schema scorecontrol_auth is 'Private authentication username registry; keep out of exposed Data API schemas.';
comment on table scorecontrol_auth.usernames is 'Canonical unique login handles. UUID ownership is immutable; emails are resolved from auth.users.';
comment on function public.auth_resolve_username(text) is 'Private backend-only username-to-current-email lookup. Never grant to anon/authenticated.';
