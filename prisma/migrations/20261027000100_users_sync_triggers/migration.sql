-- Keeps public.users in step with Supabase auth, using triggers on the auth side.
--
-- This lives in a Prisma migration (not supabase/migrations) so it always runs after init_schema
-- creates public.users: `npx supabase start` applies supabase/migrations before Prisma runs.
--
-- Why triggers instead of a foreign key to auth.users: Prisma refuses to introspect a public table
-- whose FK points into another schema (error P4002), which would break `prisma migrate dev`.
-- Prisma doesn't introspect triggers or functions, and only these triggers create or delete users rows.
--
-- Where it runs:
-- - A Supabase database (auth schema present): installs the triggers. Fails if the username
--   registry from supabase/migrations/20261019000000_auth_usernames.sql hasn't been applied.
-- - Plain Postgres without an auth schema (Prisma's shadow database, CI): skips, since there is
--   no auth to sync with.

DO $migration$
BEGIN
  IF to_regnamespace('auth') IS NULL THEN
    RAISE NOTICE 'No auth schema (not a Supabase database): skipping users sync triggers.';
    RETURN;
  END IF;
  IF to_regclass('scorecontrol_auth.usernames') IS NULL THEN
    RAISE EXCEPTION 'Apply supabase/migrations/20261019000000_auth_usernames.sql before this migration.';
  END IF;

  -- Copies each registered username into public.users. Fires for new signups (through
  -- scorecontrol_auth.register_signup_username) and for accounts claiming a username later, such as
  -- Google sign-ins and older accounts (through public.auth_claim_username).
  CREATE FUNCTION scorecontrol_auth.sync_user_from_username()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
  AS $fn$
  BEGIN
    INSERT INTO public.users (id, username)
      VALUES (NEW.user_id, NEW.username)
      ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, updated_at = pg_catalog.now();
    RETURN NEW;
  END;
  $fn$;
  REVOKE ALL ON FUNCTION scorecontrol_auth.sync_user_from_username() FROM PUBLIC;

  CREATE TRIGGER on_username_created
    AFTER INSERT ON scorecontrol_auth.usernames
    FOR EACH ROW EXECUTE FUNCTION scorecontrol_auth.sync_user_from_username();

  -- Deleting an auth account deletes its users row, which cascades to the projects it owns.
  CREATE FUNCTION scorecontrol_auth.delete_user_for_account()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
  AS $fn$
  BEGIN
    DELETE FROM public.users WHERE id = OLD.id;
    RETURN OLD;
  END;
  $fn$;
  REVOKE ALL ON FUNCTION scorecontrol_auth.delete_user_for_account() FROM PUBLIC;

  CREATE TRIGGER scorecontrol_delete_user_for_account
    AFTER DELETE ON auth.users
    FOR EACH ROW EXECUTE FUNCTION scorecontrol_auth.delete_user_for_account();

  -- Accounts that registered a username before this migration.
  INSERT INTO public.users (id, username)
    SELECT mapping.user_id, mapping.username FROM scorecontrol_auth.usernames AS mapping
    ON CONFLICT (id) DO NOTHING;
END
$migration$;
