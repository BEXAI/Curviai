-- Fractional credits and pack delivery (CURVI_BUILD_PLAN.md 9.1 and 4.4).
-- The plan prices deterministic assets at 0.5 credit, so the ledger functions
-- move from integer to numeric amounts. release_credits gains an optional
-- exact amount so the worker can release per failed shot instead of only all
-- at once. pack_files gets member read RLS; writes happen only through the
-- owner or service role connection, like assets.

DROP FUNCTION credit_balance(uuid);--> statement-breakpoint
DROP FUNCTION reserve_credits(uuid, integer, uuid);--> statement-breakpoint
DROP FUNCTION charge_credits(uuid, integer, uuid, text);--> statement-breakpoint
DROP FUNCTION release_credits(uuid, uuid);--> statement-breakpoint

CREATE FUNCTION credit_balance(ws uuid) RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  select coalesce(sum(delta), 0)::numeric from credit_ledger where workspace_id = ws;
$$;--> statement-breakpoint

CREATE FUNCTION reserve_credits(ws uuid, amount numeric, job uuid) RETURNS numeric
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
    RAISE EXCEPTION 'insufficient credit balance for workspace %: have %, need %', ws, bal, amount;
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

CREATE FUNCTION charge_credits(ws uuid, amount numeric, job uuid, step_key text DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
#variable_conflict use_variable
DECLARE
  held numeric;
BEGIN
  IF amount IS NULL OR amount <= 0 THEN
    RAISE EXCEPTION 'charge amount must be positive, got %', amount;
  END IF;
  IF job IS NULL THEN
    RAISE EXCEPTION 'charge_credits requires a job id';
  END IF;
  PERFORM 1 FROM workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace % not found', ws;
  END IF;
  SELECT coalesce(sum(-cl.delta), 0)::numeric INTO held
  FROM credit_ledger cl
  WHERE cl.workspace_id = ws AND cl.job_id = job AND cl.reason IN ('reserve', 'release');
  -- Idempotency: the workspace row lock above serializes concurrent charges, so a
  -- plain existence check is race-free here; the partial unique index still backs
  -- it up against any direct writes.
  IF step_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM credit_ledger cl
    WHERE cl.job_id = job AND cl.reason = 'charge' AND cl.step_key = step_key
  ) THEN
    RETURN held;
  END IF;
  IF held < amount THEN
    RAISE EXCEPTION 'charge of % exceeds held credits % for job %', amount, held, job;
  END IF;
  INSERT INTO credit_ledger (workspace_id, delta, reason, source, job_id, step_key)
  VALUES (ws, amount, 'release', 'system', job, NULL),
         (ws, -amount, 'charge', 'system', job, step_key);
  UPDATE generation_jobs
  SET credits_charged = credits_charged + amount, updated_at = now()
  WHERE id = job;
  RETURN held - amount;
END;
$fn$;--> statement-breakpoint

CREATE FUNCTION release_credits(ws uuid, job uuid, amount numeric DEFAULT NULL) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  held numeric;
  to_release numeric;
BEGIN
  IF job IS NULL THEN
    RAISE EXCEPTION 'release_credits requires a job id';
  END IF;
  PERFORM 1 FROM workspaces WHERE id = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace % not found', ws;
  END IF;
  SELECT coalesce(sum(-delta), 0)::numeric INTO held
  FROM credit_ledger
  WHERE workspace_id = ws AND job_id = job AND reason IN ('reserve', 'release');
  IF amount IS NULL THEN
    to_release := held;
  ELSE
    IF amount <= 0 THEN
      RAISE EXCEPTION 'release amount must be positive, got %', amount;
    END IF;
    IF amount > held THEN
      RAISE EXCEPTION 'release of % exceeds held credits % for job %', amount, held, job;
    END IF;
    to_release := amount;
  END IF;
  IF to_release > 0 THEN
    INSERT INTO credit_ledger (workspace_id, delta, reason, source, job_id)
    VALUES (ws, to_release, 'release', 'system', job);
  END IF;
  RETURN to_release;
END;
$fn$;--> statement-breakpoint

-- The recreated functions lose their execute permissions, so re-apply the
-- lockdown from migration 0002: nothing client facing may call them.
REVOKE EXECUTE ON FUNCTION credit_balance(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION reserve_credits(uuid, numeric, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION charge_credits(uuid, numeric, uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION release_credits(uuid, uuid, numeric) FROM PUBLIC;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION credit_balance(uuid), reserve_credits(uuid, numeric, uuid), charge_credits(uuid, numeric, uuid, text), release_credits(uuid, uuid, numeric) FROM %I',
        r
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION credit_balance(uuid), reserve_credits(uuid, numeric, uuid), charge_credits(uuid, numeric, uuid, text), release_credits(uuid, uuid, numeric) TO service_role;
  END IF;
END
$do$;--> statement-breakpoint

-- pack_files: members read their workspace's delivered packs. No insert,
-- update or delete policies exist, so client connections are denied by
-- default; only the worker's owner or service role connection writes rows.
ALTER TABLE "pack_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "pack_files_select_member" ON "pack_files"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));
