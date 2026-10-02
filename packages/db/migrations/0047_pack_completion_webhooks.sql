CREATE TABLE "pack_completion_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"logical_run_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"pack_status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_completion_events_outcome" CHECK ("pack_completion_events"."outcome" IN ('done','failed','canceled') AND "pack_completion_events"."pack_status" IN ('done','failed','canceled'))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_revision" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"expires_at" timestamp with time zone DEFAULT now() + interval '72 hours' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_status" CHECK ("webhook_deliveries"."status" IN ('pending','leased','succeeded','exhausted','canceled')),
	CONSTRAINT "webhook_deliveries_counts" CHECK ("webhook_deliveries"."attempts" >= 0 AND "webhook_deliveries"."replay_count" >= 0 AND "webhook_deliveries"."endpoint_revision" > 0),
	CONSTRAINT "webhook_deliveries_http_status" CHECK ("webhook_deliveries"."last_status_code" IS NULL OR "webhook_deliveries"."last_status_code" BETWEEN 100 AND 599),
	CONSTRAINT "webhook_deliveries_error" CHECK ("webhook_deliveries"."last_error" IS NULL OR "webhook_deliveries"."last_error" IN ('unsafe_destination','dns_failed','timeout','response_too_large','redirect_refused','network_failed','http_error','key_unavailable','expired','disabled')),
	CONSTRAINT "webhook_deliveries_lease" CHECK (("webhook_deliveries"."status" = 'leased') = ("webhook_deliveries"."lease_token" IS NOT NULL AND "webhook_deliveries"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"key_id" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"verification_attempted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_name_length" CHECK (char_length(btrim("webhook_endpoints"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "webhook_endpoints_url_length" CHECK (char_length("webhook_endpoints"."url") BETWEEN 9 AND 2048 AND "webhook_endpoints"."url" LIKE 'https://%'),
	CONSTRAINT "webhook_endpoints_key_length" CHECK (char_length("webhook_endpoints"."key_id") BETWEEN 1 AND 100 AND char_length("webhook_endpoints"."encrypted_secret") BETWEEN 1 AND 4096),
	CONSTRAINT "webhook_endpoints_revision" CHECK ("webhook_endpoints"."revision" > 0),
	CONSTRAINT "webhook_endpoints_activation" CHECK (NOT "webhook_endpoints"."enabled" OR ("webhook_endpoints"."verified_at" IS NOT NULL AND "webhook_endpoints"."revoked_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "logical_run_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "logical_run_outcome" text;--> statement-breakpoint
ALTER TABLE "pack_completion_events" ADD CONSTRAINT "pack_completion_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_completion_events" ADD CONSTRAINT "pack_completion_events_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_pack_completion_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."pack_completion_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pack_completion_events_job_run_uq" ON "pack_completion_events" USING btree ("job_id","logical_run_id");--> statement-breakpoint
CREATE INDEX "pack_completion_events_workspace_created_idx" ON "pack_completion_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_uq" ON "webhook_deliveries" USING btree ("endpoint_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_workspace_created_idx" ON "webhook_deliveries" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_expiry_idx" ON "webhook_deliveries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_idx" ON "webhook_endpoints" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_logical_outcome" CHECK ("generation_jobs"."logical_run_outcome" IS NULL OR "generation_jobs"."logical_run_outcome" IN ('done','failed','canceled'));
--> statement-breakpoint
-- All endpoint material and outbox rows are server-only. There is no endpoint
-- setup or delivery activation in this migration. Event/delivery metadata is
-- purged after 30 days; attempts expire at 72 hours; workspace deletion cascades.
CREATE FUNCTION protect_generation_job_completion() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
DECLARE server_writer boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls OR rolname='service_role')) INTO server_writer;
  IF TG_OP='UPDATE' AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    RAISE EXCEPTION 'generation job parent is immutable';
  END IF;
  IF TG_OP='INSERT' AND NOT EXISTS (SELECT 1 FROM products WHERE id=NEW.product_id AND workspace_id=NEW.workspace_id) THEN
    RAISE EXCEPTION 'generation job product must belong to workspace';
  END IF;
  IF NOT server_writer AND (
    (TG_OP='INSERT' AND (NEW.status <> 'queued' OR NEW.run_key IS NOT NULL OR NEW.logical_run_outcome IS NOT NULL))
    OR (TG_OP='UPDATE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.run_key IS DISTINCT FROM OLD.run_key
      OR NEW.logical_run_id IS DISTINCT FROM OLD.logical_run_id OR NEW.logical_run_outcome IS DISTINCT FROM OLD.logical_run_outcome))
  ) THEN RAISE EXCEPTION 'generation job completion metadata can only be changed by the server'; END IF;
  IF TG_OP='INSERT' THEN NEW.logical_run_id := gen_random_uuid();
  ELSIF OLD.status IN ('done','failed','canceled') AND NEW.status NOT IN ('done','failed','canceled') THEN
    NEW.logical_run_id := gen_random_uuid(); NEW.logical_run_outcome := NULL;
  ELSE NEW.logical_run_id := OLD.logical_run_id;
  END IF;
  IF NEW.status IN ('done','failed','canceled') THEN
    IF TG_OP='UPDATE' AND OLD.status IN ('done','failed','canceled') THEN NEW.logical_run_outcome := OLD.logical_run_outcome;
    ELSE NEW.logical_run_outcome := coalesce(NEW.logical_run_outcome,NEW.status); END IF;
  ELSIF NEW.logical_run_outcome IS NOT NULL THEN RAISE EXCEPTION 'active generation run cannot have a terminal outcome';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER generation_jobs_protect_completion BEFORE INSERT OR UPDATE ON generation_jobs FOR EACH ROW EXECUTE FUNCTION protect_generation_job_completion();
--> statement-breakpoint
CREATE FUNCTION enforce_webhook_parent() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP='UPDATE' AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN RAISE EXCEPTION 'webhook workspace is immutable'; END IF;
  IF TG_TABLE_NAME='pack_completion_events' THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'pack completion event is immutable'; END IF;
    IF NOT EXISTS (SELECT 1 FROM generation_jobs WHERE id=NEW.job_id AND workspace_id=NEW.workspace_id AND logical_run_id=NEW.logical_run_id) THEN
      RAISE EXCEPTION 'pack completion event must belong to job and run';
    END IF;
  ELSIF TG_TABLE_NAME='webhook_deliveries' THEN
    IF TG_OP='UPDATE' AND (NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id OR NEW.event_id IS DISTINCT FROM OLD.event_id) THEN RAISE EXCEPTION 'webhook delivery parent is immutable'; END IF;
    IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE id=NEW.endpoint_id AND workspace_id=NEW.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM pack_completion_events WHERE id=NEW.event_id AND workspace_id=NEW.workspace_id) THEN
      RAISE EXCEPTION 'webhook delivery parents must belong to workspace';
    END IF;
  ELSIF TG_TABLE_NAME='webhook_endpoints' THEN
    IF TG_OP='UPDATE' AND (NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.url IS DISTINCT FROM OLD.url) THEN
      RAISE EXCEPTION 'webhook endpoint destination is immutable; create and verify a replacement';
    END IF;
    IF TG_OP='INSERT' THEN NEW.revision := 1;
    ELSIF NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
      OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.key_id IS DISTINCT FROM OLD.key_id
      THEN NEW.revision := OLD.revision + 1;
    ELSE NEW.revision := OLD.revision; END IF;
    IF TG_OP='INSERT' AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.created_by AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'webhook endpoint creator must manage workspace';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER webhook_endpoints_parent BEFORE INSERT OR UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION enforce_webhook_parent();
CREATE TRIGGER pack_completion_events_parent BEFORE INSERT OR UPDATE ON pack_completion_events FOR EACH ROW EXECUTE FUNCTION enforce_webhook_parent();
CREATE TRIGGER webhook_deliveries_parent BEFORE INSERT OR UPDATE ON webhook_deliveries FOR EACH ROW EXECUTE FUNCTION enforce_webhook_parent();
--> statement-breakpoint
-- Same transaction as the terminal job update. Conflict preserves the original
-- event ID/outcome, even after recovery fencing changes or repeated settlement.
-- Completed historical jobs are not backfilled when adding the trigger.
CREATE FUNCTION enqueue_pack_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE created_event_id uuid;
BEGIN
  IF NEW.status NOT IN ('done','failed','canceled') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status IN ('done','failed','canceled') THEN RETURN NEW; END IF;
  INSERT INTO pack_completion_events(workspace_id,job_id,logical_run_id,outcome,pack_status,occurred_at)
  VALUES(NEW.workspace_id,NEW.id,NEW.logical_run_id,coalesce(NEW.logical_run_outcome,NEW.status),NEW.status,now())
  ON CONFLICT(job_id,logical_run_id) DO NOTHING RETURNING id INTO created_event_id;
  IF created_event_id IS NOT NULL THEN
    WITH eligible AS MATERIALIZED (
      SELECT e.id,e.revision FROM webhook_endpoints e
      WHERE e.workspace_id=NEW.workspace_id AND e.enabled AND e.verified_at IS NOT NULL AND e.revoked_at IS NULL
      ORDER BY e.id FOR KEY SHARE OF e
    )
    INSERT INTO webhook_deliveries(workspace_id,endpoint_id,event_id,endpoint_revision)
    SELECT NEW.workspace_id,e.id,created_event_id,e.revision FROM eligible e
    ON CONFLICT(endpoint_id,event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER generation_jobs_enqueue_completion AFTER INSERT OR UPDATE ON generation_jobs FOR EACH ROW EXECUTE FUNCTION enqueue_pack_completion();
--> statement-breakpoint
CREATE FUNCTION cancel_disabled_webhook_deliveries() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT NEW.enabled OR NEW.revoked_at IS NOT NULL OR NEW.verified_at IS NULL THEN
    UPDATE webhook_deliveries SET status='canceled',lease_token=NULL,lease_expires_at=NULL,last_error='disabled',updated_at=now()
      WHERE endpoint_id=NEW.id AND status IN ('pending','leased');
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER webhook_endpoints_cancel_delivery AFTER UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION cancel_disabled_webhook_deliveries();
--> statement-breakpoint
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_completion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION enqueue_pack_completion(),cancel_disabled_webhook_deliveries() FROM PUBLIC;
DO $do$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_endpoints','pack_completion_events','webhook_deliveries'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',t,'client_id','client_id');
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',t,r); END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role',t); END IF;
  END LOOP;
END $do$;
