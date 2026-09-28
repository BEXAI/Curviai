CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_grants" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"email_key" text,
	"credits" numeric(12, 1) DEFAULT 0 NOT NULL,
	"withheld_reason" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signup_grants" ADD CONSTRAINT "signup_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signup_grants_workspace_id_idx" ON "signup_grants" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signup_grants_paid_email_key_uq" ON "signup_grants" USING btree ("email_key") WHERE credits > 0 and email_key is not null;--> statement-breakpoint

-- Signup grant on confirmed email (Update.md 1.9, Phase 10 decision 4).
--
-- Before this migration the free grant was 15 credits hardcoded in
-- bootstrap_workspace (0004), paid at auth user creation whether or not the
-- email was ever confirmed, and the seed amount the app passed to
-- provision_workspace (0009) never mattered. Now:
--   * the amount lives in platform_settings.free_signup_credits, upserted from
--     packages/pipeline seed data by pnpm db:seed (CLAUDE.md rule 2);
--   * grant_signup_credits is the only path that pays it, with ledger source
--     'signup', and only once auth.users.email_confirmed_at is set (including
--     users created already confirmed);
--   * signup_grants holds one row per user, so the grant lands exactly once
--     per user, and at most once per normalized email address;
--   * bootstrap_workspace (auth trigger) and provision_workspace (first app
--     request) create the workspace the same way and both defer to it.
-- A grant that cannot be settled yet (unconfirmed email, no workspace, amount
-- not seeded) writes nothing, so a later call settles it. pnpm db:seed runs
-- grant_pending_signup_credits after seeding to settle confirmed users.

-- Platform tables: RLS on with no policies, and no table privileges for
-- client facing roles, like spend_cap_counters (0010). Only the owner or
-- service role connection and the SECURITY DEFINER functions below touch them.
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signup_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.platform_settings, public.signup_grants FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
--> statement-breakpoint

-- reserve_credits: same logic as 0007, but the insufficient balance case now
-- raises SQLSTATE CU402 so callers can tell it apart from any other failure
-- (Update.md 1.8). CREATE OR REPLACE keeps the 0007 execute grants.
CREATE OR REPLACE FUNCTION reserve_credits(ws uuid, amount numeric, job uuid) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  bal numeric;
BEGIN
  IF amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'reserve amount must be positive, got %', amount;
  END IF;
  PERFORM 1 FROM workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace % not found', ws;
  END IF;
  SELECT coalesce(sum(delta), 0)::numeric INTO bal FROM credit_ledger WHERE workspace_id = ws;
  IF bal < amount THEN
    RAISE EXCEPTION 'insufficient credit balance for workspace %: have %, need %', ws, bal, amount
      USING ERRCODE = 'CU402';
  END IF;
  INSERT INTO credit_ledger (workspace_id, delta, reason, source, job_id)
  VALUES (ws, -amount, 'reserve', 'system', job);
  IF job IS NOT NULL THEN
    UPDATE generation_jobs
    SET credits_reserved = credits_reserved + amount, updated_at = now()
    WHERE id = job;
  END IF;
  RETURN bal - amount;
END;
$fn$;--> statement-breakpoint

-- The dedupe key for one inbox: lower case, plus tag removed, and for Gmail
-- the dots removed and googlemail.com folded into gmail.com. Stored as a
-- sha256 hex digest, never as the address itself.
CREATE OR REPLACE FUNCTION public.normalized_email_key(p_email text) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
DECLARE
  addr text := lower(btrim(coalesce(p_email, '')));
  domain text;
  local_part text;
BEGIN
  domain := substring(addr from '@([^@]+)$');
  IF domain IS NULL THEN
    RETURN NULL;
  END IF;
  local_part := left(addr, length(addr) - length(domain) - 1);
  local_part := split_part(local_part, '+', 1);
  IF domain IN ('gmail.com', 'googlemail.com') THEN
    local_part := replace(local_part, '.', '');
    domain := 'gmail.com';
  END IF;
  IF local_part = '' THEN
    RETURN NULL;
  END IF;
  RETURN encode(sha256(convert_to(local_part || '@' || domain, 'UTF8')), 'hex');
END;
$fn$;--> statement-breakpoint

-- The seeded free grant, or NULL when pnpm db:seed has not written it.
CREATE OR REPLACE FUNCTION public.free_signup_credits() RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric END
  FROM platform_settings
  WHERE key = 'free_signup_credits';
$fn$;--> statement-breakpoint

-- Pays the free signup grant into the user's own workspace, exactly once per
-- user. Returns the credits granted (0 when nothing was paid). The per user
-- advisory lock is the one provision_workspace takes, so concurrent callers
-- serialize. p_fallback_credits covers a database where the seed has not run
-- yet; the app passes the same seed value.
CREATE OR REPLACE FUNCTION public.grant_signup_credits(p_user_id uuid, p_fallback_credits numeric DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_email text;
  v_confirmed timestamptz;
  v_ws uuid;
  v_amount numeric;
  v_key text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 42));
  IF EXISTS (SELECT 1 FROM signup_grants WHERE user_id = p_user_id) THEN
    RETURN 0;
  END IF;

  -- On Supabase the grant waits for a confirmed email. Plain Postgres and
  -- PGlite have no auth.users, so there is no confirmation to wait for.
  IF to_regclass('auth.users') IS NOT NULL THEN
    EXECUTE 'SELECT email::text, email_confirmed_at FROM auth.users WHERE id = $1'
      INTO v_email, v_confirmed
      USING p_user_id;
    IF v_confirmed IS NULL THEN
      RETURN 0;
    END IF;
  END IF;

  SELECT m.workspace_id INTO v_ws
  FROM members m
  WHERE m.user_id = p_user_id AND m.role = 'owner'
  ORDER BY m.created_at, m.workspace_id
  LIMIT 1;
  IF v_ws IS NULL THEN
    RETURN 0;
  END IF;

  v_amount := coalesce(free_signup_credits(), p_fallback_credits);
  IF v_amount IS NULL THEN
    RAISE WARNING 'free_signup_credits is not seeded, so the signup grant for user % waits for pnpm db:seed', p_user_id;
    RETURN 0;
  END IF;
  v_amount := greatest(v_amount, 0);

  v_key := normalized_email_key(v_email);
  IF v_key IS NOT NULL AND v_amount > 0 THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 43));
    IF EXISTS (SELECT 1 FROM signup_grants WHERE email_key = v_key AND credits > 0) THEN
      INSERT INTO signup_grants (user_id, workspace_id, email_key, credits, withheld_reason)
      VALUES (p_user_id, v_ws, v_key, 0, 'email_already_granted');
      INSERT INTO events (workspace_id, name, props)
      VALUES (v_ws, 'free_grant_withheld', jsonb_build_object('reason', 'email_already_granted'));
      RETURN 0;
    END IF;
  END IF;

  INSERT INTO signup_grants (user_id, workspace_id, email_key, credits)
  VALUES (p_user_id, v_ws, v_key, v_amount);
  IF v_amount > 0 THEN
    INSERT INTO credit_ledger (workspace_id, delta, reason, source)
    VALUES (v_ws, v_amount, 'grant', 'signup');
  END IF;
  RETURN v_amount;
END;
$fn$;--> statement-breakpoint

-- The auth trigger path: the user's workspace and owner membership, then the
-- grant, which only pays once the email is confirmed.
CREATE OR REPLACE FUNCTION public.bootstrap_workspace(uid uuid, email text) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ws uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(uid::text, 42));
  SELECT m.workspace_id INTO ws FROM members m WHERE m.user_id = uid ORDER BY m.created_at LIMIT 1;
  IF ws IS NULL THEN
    INSERT INTO workspaces (name, plan)
    VALUES (coalesce(nullif(split_part(coalesce(email, ''), '@', 1), ''), 'My workspace'), 'free')
    RETURNING id INTO ws;
    INSERT INTO members (workspace_id, user_id, role) VALUES (ws, uid, 'owner');
  END IF;
  PERFORM grant_signup_credits(uid);
  RETURN ws;
END;
$fn$;--> statement-breakpoint

-- The first app request path (DbService.provisionWorkspace): same workspace
-- creation, same grant. p_free_credits is the app's seed value, used only when
-- platform_settings has not been seeded. CREATE OR REPLACE keeps the 0009
-- execute grants.
CREATE OR REPLACE FUNCTION provision_workspace(p_user_id uuid, p_name text, p_free_credits numeric) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  ws uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'provision_workspace requires a user id';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 42));
  SELECT m.workspace_id INTO ws FROM members m WHERE m.user_id = p_user_id ORDER BY m.created_at LIMIT 1;
  IF ws IS NULL THEN
    INSERT INTO workspaces (name, plan) VALUES (coalesce(p_name, 'Your workspace'), 'free')
    RETURNING id INTO ws;
    INSERT INTO members (workspace_id, user_id, role) VALUES (ws, p_user_id, 'owner');
  END IF;
  PERFORM grant_signup_credits(p_user_id, p_free_credits);
  RETURN ws;
END;
$fn$;--> statement-breakpoint

-- Signup must never fail because of workspace setup: the app provisions on
-- the first request if this does not complete.
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  BEGIN
    PERFORM public.bootstrap_workspace(NEW.id, NEW.email);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'workspace bootstrap failed for user %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

-- Email confirmation pays the grant. Confirmation must never fail because of
-- it; a grant that errors here is settled by the next grant call.
CREATE OR REPLACE FUNCTION public.handle_user_email_confirmed() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  BEGIN
    PERFORM public.bootstrap_workspace(NEW.id, NEW.email);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup grant failed for user %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$fn$;--> statement-breakpoint

-- Settles every confirmed user who has no grant row yet, for example users
-- who confirmed before pnpm db:seed wrote free_signup_credits. Returns how
-- many users were settled (paid or withheld).
CREATE OR REPLACE FUNCTION public.grant_pending_signup_credits() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  u record;
  before_count integer;
  after_count integer;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RETURN 0;
  END IF;
  SELECT count(*) INTO before_count FROM signup_grants;
  FOR u IN EXECUTE
    'SELECT au.id, au.email::text AS email FROM auth.users au
     WHERE au.email_confirmed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.signup_grants sg WHERE sg.user_id = au.id)
     ORDER BY au.created_at, au.id'
  LOOP
    PERFORM bootstrap_workspace(u.id, u.email);
  END LOOP;
  SELECT count(*) INTO after_count FROM signup_grants;
  RETURN after_count - before_count;
END;
$fn$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.normalized_email_key(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.free_signup_credits() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.grant_signup_credits(uuid, numeric) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.handle_user_email_confirmed() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.grant_pending_signup_credits() FROM PUBLIC;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.normalized_email_key(text), public.free_signup_credits(), public.grant_signup_credits(uuid, numeric), public.handle_user_email_confirmed(), public.grant_pending_signup_credits(), public.bootstrap_workspace(uuid, text), public.handle_new_user() FROM %I',
        r
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.grant_signup_credits(uuid, numeric), public.grant_pending_signup_credits() TO service_role;
  END IF;
END
$do$;
--> statement-breakpoint

-- Every user who already has a membership was granted at creation under the
-- old paths (bootstrap_workspace always paid 15, provision_workspace always
-- paid the seed amount), so record them as settled: confirming an old
-- unconfirmed account must not pay a second grant.
INSERT INTO signup_grants (user_id, workspace_id, credits, granted_at)
SELECT DISTINCT ON (m.user_id)
  m.user_id,
  m.workspace_id,
  coalesce((
    SELECT sum(cl.delta)
    FROM credit_ledger cl
    WHERE cl.workspace_id = m.workspace_id
      AND cl.reason = 'grant'
      AND cl.source IN ('signup', 'system')
      AND cl.job_id IS NULL
  ), 0),
  m.created_at
FROM members m
ORDER BY m.user_id, (m.role = 'owner') DESC, m.created_at
ON CONFLICT (user_id) DO NOTHING;
--> statement-breakpoint

-- On Supabase: give the earliest paid account per inbox its email key, so
-- plus addressed or dotted variants of an existing account get no second
-- grant, and install the confirmation trigger. The insert trigger from 0004
-- stays; its function now defers the grant to confirmation.
DO $do$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE public.signup_grants sg
      SET email_key = picked.email_key
      FROM (
        SELECT DISTINCT ON (k.email_key) s.user_id, k.email_key
        FROM public.signup_grants s
        JOIN auth.users au ON au.id = s.user_id
        CROSS JOIN LATERAL (SELECT public.normalized_email_key(au.email::text) AS email_key) k
        WHERE k.email_key IS NOT NULL AND s.credits > 0
        ORDER BY k.email_key, au.created_at, au.id
      ) picked
      WHERE sg.user_id = picked.user_id
    $sql$;
    EXECUTE 'DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users';
    EXECUTE 'CREATE TRIGGER on_auth_user_email_confirmed AFTER UPDATE ON auth.users FOR EACH ROW WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL) EXECUTE FUNCTION public.handle_user_email_confirmed()';
  END IF;
END
$do$;
