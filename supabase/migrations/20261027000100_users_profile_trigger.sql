-- Keeps public.users (created by Prisma's init_schema migration) in step with Supabase auth.
-- Apply AFTER `prisma migrate deploy`: this file needs public.users to exist.
-- Run as the trusted migration owner (normally postgres), never as an end-user role.
--
-- Why triggers instead of a foreign key to auth.users: Prisma refuses to introspect a public table
-- whose FK points into another schema (error P4002), which would break `prisma migrate dev`.
-- Triggers are invisible to Prisma, and only these triggers create or delete users rows.

-- Copies each registered username into public.users. Fires for new signups (through
-- scorecontrol_auth.register_signup_username) and for older accounts claiming a username later
-- (through public.auth_claim_username), since both insert into scorecontrol_auth.usernames.
create function scorecontrol_auth.sync_user_from_username()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, username)
    values (new.user_id, new.username)
    on conflict (id) do update set username = excluded.username, updated_at = pg_catalog.now();
  return new;
end;
$$;
revoke all on function scorecontrol_auth.sync_user_from_username()
  from public, anon, authenticated, service_role, supabase_auth_admin;

create trigger on_username_created
  after insert on scorecontrol_auth.usernames
  for each row execute function scorecontrol_auth.sync_user_from_username();

-- Deleting an auth account deletes its users row, which cascades to the projects it owns.
create function scorecontrol_auth.delete_user_for_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.users where id = old.id;
  return old;
end;
$$;
revoke all on function scorecontrol_auth.delete_user_for_account()
  from public, anon, authenticated, service_role, supabase_auth_admin;

create trigger scorecontrol_delete_user_for_account
  after delete on auth.users
  for each row execute function scorecontrol_auth.delete_user_for_account();

-- Accounts that registered a username before this migration.
insert into public.users (id, username)
  select mapping.user_id, mapping.username from scorecontrol_auth.usernames as mapping
  on conflict (id) do nothing;

comment on trigger on_username_created on scorecontrol_auth.usernames is
  'Creates the public.users row for an account when its username is registered.';
