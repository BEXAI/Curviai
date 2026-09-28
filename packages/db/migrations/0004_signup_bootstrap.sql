-- Signup bootstrap. A new Supabase auth user gets a workspace, an owner
-- membership and the one time free tier grant (creditsOnce in
-- packages/pipeline/src/seed/credits.ts, 15 credits). Membership and ledger
-- writes are service role territory (0001 and 0002), so this runs as a
-- SECURITY DEFINER owned by the migration role and is revoked from every
-- client facing role. The trigger lives on auth.users, which only exists on
-- Supabase; the conditional block keeps the migration valid in plain
-- Postgres and PGlite where the auth schema has no users table.
CREATE OR REPLACE FUNCTION public.bootstrap_workspace(uid uuid, email text) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ws uuid;
BEGIN
  SELECT workspace_id INTO ws FROM members WHERE user_id = uid LIMIT 1;
  IF ws IS NOT NULL THEN
    RETURN ws;
  END IF;
  INSERT INTO workspaces (name, plan)
  VALUES (coalesce(nullif(split_part(coalesce(email, ''), '@', 1), ''), 'My workspace'), 'free')
  RETURNING id INTO ws;
  INSERT INTO members (workspace_id, user_id, role) VALUES (ws, uid, 'owner');
  INSERT INTO credit_ledger (workspace_id, delta, reason, source)
  VALUES (ws, 15, 'grant', 'signup');
  RETURN ws;
END;
$fn$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  PERFORM public.bootstrap_workspace(NEW.id, NEW.email);
  RETURN NEW;
END;
$fn$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.bootstrap_workspace(uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.bootstrap_workspace(uuid, text), public.handle_new_user() FROM %I',
        r
      );
    END IF;
  END LOOP;
END
$do$;
--> statement-breakpoint

-- Install the trigger and backfill existing users only where auth.users
-- exists (Supabase). PGlite and plain Postgres test harnesses skip this.
DO $do$
DECLARE
  u record;
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users';
    EXECUTE 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()';
    FOR u IN EXECUTE 'SELECT id, email FROM auth.users' LOOP
      PERFORM public.bootstrap_workspace(u.id, u.email);
    END LOOP;
  END IF;
END
$do$;
