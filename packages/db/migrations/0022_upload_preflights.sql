-- Preflight at upload (docs/phases/PHASE_14.md workstream 4 and item 3.2).
--
-- upload_preflights holds what the preflight found in one uploaded photo
-- before any pack started: the seller facing verdict (ready, a product to
-- choose, a problem that stops the pack, or a check that could not run),
-- the per photo intake answer the pack reuses when the note and the recipe
-- version still match, and the provider spend of the check (cost_micros,
-- booked on the workspace, never charged in credits). One row per workspace
-- and upload key. Tenant table pattern as in 0011: RLS on, members read
-- their own workspace's rows, and no write policy, so only the web app's
-- owner connection writes.
CREATE TABLE "upload_preflights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"note_key" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb NOT NULL,
	"intake" jsonb,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_preflights_status_check" CHECK ("upload_preflights"."status" in ('ready', 'choose', 'blocked', 'unavailable'))
);
--> statement-breakpoint
ALTER TABLE "upload_preflights" ADD CONSTRAINT "upload_preflights_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_preflights_workspace_r2_key_uq" ON "upload_preflights" USING btree ("workspace_id","r2_key");--> statement-breakpoint
CREATE INDEX "upload_preflights_workspace_id_idx" ON "upload_preflights" USING btree ("workspace_id");--> statement-breakpoint

ALTER TABLE "upload_preflights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "upload_preflights_select_member" ON "upload_preflights"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));
