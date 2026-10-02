CREATE TABLE "disposable_email_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disposable_email_domains_normalized" CHECK ("disposable_email_domains"."domain" = lower(btrim("disposable_email_domains"."domain")) AND char_length("disposable_email_domains"."domain") BETWEEN 1 AND 253 AND "disposable_email_domains"."domain" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$')
);
--> statement-breakpoint

-- >>> Phase 20 hand written: disposable_domains
ALTER TABLE "disposable_email_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['disposable_email_domains'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS no_oauth_clients ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',
        t, 'client_id', 'client_id'
      );
    END LOOP;
  END IF;
END
$do$;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.disposable_email_domains FROM %I', r);
    END IF;
  END LOOP;
END
$do$;

--> statement-breakpoint

-- CREATE OR REPLACE preserves the restricted execute grants from 0012.
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
  v_domain text;
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
  -- Match exact domains and their parents via indexed equality checks.
  -- A lookalike such as notdisposable.example never matches disposable.example.
  v_domain := substring(lower(btrim(coalesce(v_email, ''))) from '@([^@]+)$');
  WHILE v_domain IS NOT NULL LOOP
    IF EXISTS (SELECT 1 FROM disposable_email_domains WHERE domain = v_domain) THEN
      INSERT INTO signup_grants (user_id, workspace_id, email_key, credits, withheld_reason)
      VALUES (p_user_id, v_ws, v_key, 0, 'disposable_email');
      INSERT INTO events (workspace_id, name, props)
      VALUES (v_ws, 'free_grant_withheld', jsonb_build_object('reason', 'disposable_email'));
      RETURN 0;
    END IF;
    v_domain := substring(v_domain from '[.](.+)$');
  END LOOP;
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
-- <<< Phase 20 hand written: disposable_domains
