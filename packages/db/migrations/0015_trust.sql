-- Trust and data rights (docs/phases/PHASE_11.md, branch b2/trust).
--
-- terms_acceptances: the server side record that a user accepted a version
-- of the terms of service, with the server's timestamp, the request IP and
-- user agent. Until now the only record was terms_accepted_at in Supabase
-- user metadata, which the browser writes and the user can change at will.
-- The web app writes this table over its owner connection (signup
-- confirmation callback, or the first signed in visit to /app). Tenant table
-- pattern as in 0011: RLS on, members read their own rows, and no write
-- policy, so the anon and authenticated roles can never insert or change a
-- record. workspace_id is set null when a workspace goes; account deletion
-- removes the user's rows itself.
--
-- source_media_created_at_idx: the 30 day source purge
-- (apps/web/src/lib/trust/purge.ts) selects source rows by age.

CREATE TABLE "terms_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "terms_acceptances_user_version_uq" ON "terms_acceptances" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "terms_acceptances_workspace_id_idx" ON "terms_acceptances" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_media_created_at_idx" ON "source_media" USING btree ("created_at");--> statement-breakpoint

ALTER TABLE "terms_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "terms_acceptances_select_own" ON "terms_acceptances"
  FOR SELECT
  USING (user_id = auth.uid());
