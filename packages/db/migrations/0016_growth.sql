-- Growth (Phase 11, b2/growth): real share pages, the opt in gallery and
-- lead capture on the free tools.
--
-- share_links gains the job it shows, what it shows (a before and after or
-- the whole pack), a title and publish timestamps. One row per job, so
-- publishing again reuses the slug. gallery_items gets one row per share.
-- leads is a platform table: anonymous emails, no workspace_id, RLS on with
-- no policies and no client privileges, like signup_grants and
-- spend_cap_counters. Only the server's owner connection writes it.

CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"source" text NOT NULL,
	"last_source" text,
	"hits" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "kind" text DEFAULT 'before_after' NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_email_uq" ON "leads" USING btree ("email");--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gallery_items_share_slug_uq" ON "gallery_items" USING btree ("share_slug") WHERE share_slug is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_job_id_uq" ON "share_links" USING btree ("job_id") WHERE job_id is not null;--> statement-breakpoint

-- A share page's slug is its only secret: a pack shared by link, and not
-- to the gallery, must not be discoverable. share_links_public_read (0001)
-- let anyone holding the public anon key list every public slug, with its
-- workspace and job ids. The public page reads through the server's owner
-- connection and returns only what the page shows, so no anonymous policy
-- is needed. Members keep share_links_select_member (0011).
DROP POLICY IF EXISTS "share_links_public_read" ON "share_links";--> statement-breakpoint

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.leads FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
