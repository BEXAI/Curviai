CREATE TABLE "ops_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule" text NOT NULL,
	"subject" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ops_alerts_status" CHECK ("ops_alerts"."status" IN ('open', 'resolved')),
	CONSTRAINT "ops_alerts_count_positive" CHECK ("ops_alerts"."count" > 0),
	CONSTRAINT "ops_alerts_detail_object" CHECK (jsonb_typeof("ops_alerts"."detail") = 'object')
);
--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "review_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gallery_items" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_open_rule_subject_uq" ON "ops_alerts" USING btree ("rule","subject") WHERE "ops_alerts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "ops_alerts_resolved_at_idx" ON "ops_alerts" USING btree ("resolved_at");--> statement-breakpoint
ALTER TABLE "gallery_items" ADD CONSTRAINT "gallery_items_review_status" CHECK ("gallery_items"."review_status" IN ('pending', 'approved', 'rejected'));--> statement-breakpoint

-- >>> Phase 20 hand written: ops_alerts_gallery
-- Preserve existing public approvals while future submissions default pending.
UPDATE "gallery_items" SET "review_status" = 'approved' WHERE "published" = true;--> statement-breakpoint
ALTER POLICY "gallery_items_public_read" ON "gallery_items"
  USING (published = true AND review_status = 'approved' AND consent_at IS NOT NULL);--> statement-breakpoint

ALTER TABLE "ops_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH t IN ARRAY ARRAY['ops_alerts'] LOOP
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
      EXECUTE format('REVOKE ALL ON TABLE public.ops_alerts FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
-- <<< Phase 20 hand written: ops_alerts_gallery
