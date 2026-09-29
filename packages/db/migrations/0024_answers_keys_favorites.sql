-- Phase 16 data (docs/phases/PHASE_16.md, "Data model summary").
--
-- generation_jobs.seller_answers keeps the seller's answers to the question
-- step (workstream 4): nullable jsonb, held to an object or null by a named
-- check, RLS unchanged (the 0023 pattern). asset_variants.picked marks the
-- scene variation that ships (workstream 6); every existing row reads true,
-- so every older pack packages exactly as before.
--
-- api_keys (workstream 5) holds workspace API keys for the public API, the
-- hosted MCP server and the CLI: the key is shown once and only its hash is
-- stored, prefix is the unique public start of the key the server looks it
-- up by, and a key is revoked (revoked_at), never deleted. Like integrations
-- it guards access to the workspace, so only owners and admins read, create
-- or update keys, and nobody deletes them through a client role.
--
-- favorites (workstream 6) is one row per workspace and asset. Members read;
-- owners, admins and editors add and remove; the client seat stays read
-- only. The asset foreign key takes (asset_id, workspace_id), so a favorite
-- can never point at another workspace's asset, whoever writes the row.
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_workspace_id_asset_id_pk" PRIMARY KEY("workspace_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "asset_variants" ADD COLUMN "picked" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "seller_answers" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_id_workspace_id_uq" ON "assets" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_asset_workspace_fk" FOREIGN KEY ("asset_id","workspace_id") REFERENCES "public"."assets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "favorites_asset_id_idx" ON "favorites" USING btree ("asset_id");--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_seller_answers_object" CHECK ("generation_jobs"."seller_answers" IS NULL OR jsonb_typeof("generation_jobs"."seller_answers") = 'object');--> statement-breakpoint

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "api_keys_select_owner_admin" ON "api_keys"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin')));--> statement-breakpoint

CREATE POLICY "api_keys_insert_owner_admin" ON "api_keys"
  FOR INSERT
  WITH CHECK (
    workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin'))
    and created_by = auth.uid()
  );--> statement-breakpoint

CREATE POLICY "api_keys_update_owner_admin" ON "api_keys"
  FOR UPDATE
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin')))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin')));--> statement-breakpoint

ALTER TABLE "favorites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "favorites_select_member" ON "favorites"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

CREATE POLICY "favorites_insert_non_client" ON "favorites"
  FOR INSERT
  WITH CHECK (
    workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor'))
    and created_by = auth.uid()
  );--> statement-breakpoint

CREATE POLICY "favorites_delete_non_client" ON "favorites"
  FOR DELETE
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));
