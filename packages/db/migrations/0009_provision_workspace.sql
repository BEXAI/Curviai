-- First session provisioning (plan 9.1 free tier and 9.8 session one value):
-- creates the user's first workspace, owner membership and the free tier's
-- one time credit grant, exactly once per user. The advisory lock serializes
-- concurrent first requests; the membership re-check inside the lock makes
-- the function idempotent. Amount comes from the caller, which reads it from
-- the seed data (CLAUDE.md rule 2: no amounts hardcoded in logic).

CREATE FUNCTION provision_workspace(p_user_id uuid, p_name text, p_free_credits numeric) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  existing uuid;
  ws uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'provision_workspace requires a user id';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 42));
  SELECT m.workspace_id INTO existing FROM members m WHERE m.user_id = p_user_id LIMIT 1;
  IF FOUND THEN
    RETURN existing;
  END IF;
  INSERT INTO workspaces (name, plan) VALUES (coalesce(p_name, 'Your workspace'), 'free')
  RETURNING id INTO ws;
  INSERT INTO members (workspace_id, user_id, role) VALUES (ws, p_user_id, 'owner');
  IF p_free_credits IS NOT NULL AND p_free_credits > 0 THEN
    INSERT INTO credit_ledger (workspace_id, delta, reason, source)
    VALUES (ws, p_free_credits, 'grant', 'system');
  END IF;
  RETURN ws;
END;
$fn$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION provision_workspace(uuid, text, numeric) FROM PUBLIC;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION provision_workspace(uuid, text, numeric) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION provision_workspace(uuid, text, numeric) TO service_role;
  END IF;
END
$do$;
