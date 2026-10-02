CREATE TABLE "workspace_credit_budget_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"prior_limit" numeric(12, 1),
	"new_limit" numeric(12, 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_credit_budget_audit_limits" CHECK (("workspace_credit_budget_audit"."prior_limit" IS NULL OR ("workspace_credit_budget_audit"."prior_limit" >= 0 AND "workspace_credit_budget_audit"."prior_limit" <= 1000000000)) AND ("workspace_credit_budget_audit"."new_limit" IS NULL OR ("workspace_credit_budget_audit"."new_limit" >= 0 AND "workspace_credit_budget_audit"."new_limit" <= 1000000000)))
);
--> statement-breakpoint
CREATE TABLE "workspace_credit_budgets" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"monthly_limit" numeric(12, 1),
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_credit_budgets_limit" CHECK ("workspace_credit_budgets"."monthly_limit" IS NULL OR ("workspace_credit_budgets"."monthly_limit" >= 0 AND "workspace_credit_budgets"."monthly_limit" <= 1000000000))
);
--> statement-breakpoint
ALTER TABLE "workspace_credit_budget_audit" ADD CONSTRAINT "workspace_credit_budget_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credit_budgets" ADD CONSTRAINT "workspace_credit_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_credit_budget_audit_workspace_created_idx" ON "workspace_credit_budget_audit" USING btree ("workspace_id","created_at");
--> statement-breakpoint
-- No workspace is opted in by this migration. Audit rows are retained for
-- 365 days by the application; workspace deletion cascades all preferences
-- and audit rows. Credits and provider-dollar policies remain unchanged.
INSERT INTO platform_settings (key,value) VALUES
 ('credit_budget_period','"utc_calendar_month"'::jsonb),
 ('credit_budget_max_monthly','1000000000'::jsonb)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
ALTER TABLE workspace_credit_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_credit_budget_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_credit_budgets_select_manager ON workspace_credit_budgets FOR SELECT USING (
  EXISTS (SELECT 1 FROM members WHERE workspace_id = workspace_credit_budgets.workspace_id AND user_id = auth.uid() AND role IN ('owner','admin'))
);
CREATE POLICY workspace_credit_budget_audit_select_manager ON workspace_credit_budget_audit FOR SELECT USING (
  EXISTS (SELECT 1 FROM members WHERE workspace_id = workspace_credit_budget_audit.workspace_id AND user_id = auth.uid() AND role IN ('owner','admin'))
);
--> statement-breakpoint
CREATE FUNCTION workspace_credit_budget_snapshot(ws uuid)
RETURNS TABLE(period_start timestamptz,period_end timestamptz,monthly_limit numeric,consumed numeric,held numeric,remaining numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  WITH period AS (SELECT date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start_at,
    (date_trunc('month',now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS end_at),
  amounts AS (
    SELECT coalesce(-sum(delta) FILTER (WHERE reason='charge' AND created_at >= period.start_at AND created_at < period.end_at),0)::numeric AS consumed,
      greatest(0,coalesce(-sum(delta) FILTER (WHERE reason IN ('reserve','release')),0))::numeric AS held
    FROM period LEFT JOIN credit_ledger ON workspace_id=ws
  )
  SELECT period.start_at,period.end_at,b.monthly_limit,a.consumed,a.held,
    CASE WHEN b.monthly_limit IS NULL THEN NULL ELSE greatest(0,b.monthly_limit-a.consumed-a.held) END
  FROM period CROSS JOIN amounts a LEFT JOIN workspace_credit_budgets b ON b.workspace_id=ws;
$fn$;
--> statement-breakpoint
CREATE FUNCTION set_workspace_credit_budget(ws uuid, actor uuid, monthly_limit numeric) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
#variable_conflict use_variable
DECLARE previous_limit numeric; configured_max numeric;
BEGIN
  PERFORM 1 FROM workspaces WHERE id=ws FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace not found'; END IF;
  PERFORM 1 FROM members WHERE workspace_id=ws AND user_id=actor AND role='owner' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only the workspace owner can change its credit budget' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key='credit_budget_period' AND value='"utc_calendar_month"'::jsonb) THEN
    RAISE EXCEPTION 'unsupported credit budget period';
  END IF;
  SELECT (value #>> '{}')::numeric INTO configured_max FROM platform_settings WHERE key='credit_budget_max_monthly';
  IF configured_max IS NULL OR configured_max < 0 OR configured_max > 1000000000 THEN
    RAISE EXCEPTION 'invalid credit budget policy';
  END IF;
  IF monthly_limit IS NOT NULL AND (monthly_limit < 0 OR monthly_limit > configured_max OR monthly_limit <> trunc(monthly_limit,1)) THEN
    RAISE EXCEPTION 'credit budget must be finite, nonnegative and in tenths';
  END IF;
  SELECT b.monthly_limit INTO previous_limit FROM workspace_credit_budgets b WHERE b.workspace_id=ws;
  IF previous_limit IS NOT DISTINCT FROM monthly_limit THEN RETURN monthly_limit; END IF;
  INSERT INTO workspace_credit_budgets(workspace_id,monthly_limit,updated_by) VALUES(ws,monthly_limit,actor)
  ON CONFLICT(workspace_id) DO UPDATE SET monthly_limit=excluded.monthly_limit,updated_by=excluded.updated_by,updated_at=now();
  INSERT INTO workspace_credit_budget_audit(workspace_id,actor_user_id,prior_limit,new_limit) VALUES(ws,actor,previous_limit,monthly_limit);
  RETURN monthly_limit;
END $fn$;
--> statement-breakpoint
-- Serializes reservations, settlements and owner limit changes on the same
-- workspace row. Charge converts reserve to paired release/charge exactly once;
-- all-period reserve/release holds survive UTC rollover until settlement.
CREATE OR REPLACE FUNCTION reserve_credits(ws uuid, amount numeric, job uuid) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE bal numeric; budget record;
BEGIN
  IF amount IS NULL OR amount <= 0 OR amount > 99999999999.9 OR amount <> trunc(amount,1) THEN
    RAISE EXCEPTION 'reserve amount must be positive finite tenths';
  END IF;
  PERFORM 1 FROM workspaces WHERE id=ws FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace % not found', ws; END IF;
  IF job IS NOT NULL AND NOT EXISTS (SELECT 1 FROM generation_jobs WHERE id=job AND workspace_id=ws) THEN
    RAISE EXCEPTION 'reservation job must belong to workspace';
  END IF;
  SELECT coalesce(sum(delta),0)::numeric INTO bal FROM credit_ledger WHERE workspace_id=ws;
  IF bal < amount THEN RAISE EXCEPTION 'insufficient credit balance for workspace %: have %, need %',ws,bal,amount USING ERRCODE='CU402'; END IF;
  SELECT * INTO budget FROM workspace_credit_budget_snapshot(ws);
  IF budget.monthly_limit IS NOT NULL AND budget.consumed + budget.held + amount > budget.monthly_limit THEN
    RAISE EXCEPTION 'workspace monthly credit budget reached; ask the owner to change the limit or wait for the next UTC month' USING ERRCODE='CU429';
  END IF;
  INSERT INTO credit_ledger(workspace_id,delta,reason,source,job_id) VALUES(ws,-amount,'reserve','system',job);
  IF job IS NOT NULL THEN UPDATE generation_jobs SET credits_reserved=credits_reserved+amount,updated_at=now() WHERE id=job AND workspace_id=ws; END IF;
  RETURN bal-amount;
END $fn$;
--> statement-breakpoint
CREATE FUNCTION enforce_credit_budget_history() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_TABLE_NAME='workspace_credit_budget_audit' AND TG_OP='UPDATE' THEN RAISE EXCEPTION 'credit budget audit is immutable'; END IF;
  IF TG_OP='UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN RAISE EXCEPTION 'credit budget workspace is immutable'; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER workspace_credit_budgets_parent BEFORE UPDATE ON workspace_credit_budgets FOR EACH ROW EXECUTE FUNCTION enforce_credit_budget_history();
CREATE TRIGGER workspace_credit_budget_audit_immutable BEFORE UPDATE ON workspace_credit_budget_audit FOR EACH ROW EXECUTE FUNCTION enforce_credit_budget_history();
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_credit_budget_snapshot(uuid),set_workspace_credit_budget(uuid,uuid,numeric),reserve_credits(uuid,numeric,uuid) FROM PUBLIC;
DO $do$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_credit_budgets','workspace_credit_budget_audit'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',t,'client_id','client_id');
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',t,r); END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role',t); END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION workspace_credit_budget_snapshot(uuid),set_workspace_credit_budget(uuid,uuid,numeric),reserve_credits(uuid,numeric,uuid) FROM %I',r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN GRANT SELECT ON workspace_credit_budgets,workspace_credit_budget_audit TO authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION workspace_credit_budget_snapshot(uuid),set_workspace_credit_budget(uuid,uuid,numeric),reserve_credits(uuid,numeric,uuid) TO service_role; END IF;
END $do$;
