-- Tenant write lockdown (Update.md 4.1 and 4.2, Phase 10 package P3).
--
-- 0001 gave several tenant tables a single FOR ALL membership policy, so any
-- member, including the read only client role, could write them through the
-- public anon key plus their own JWT. The worst case (Update.md 4.1): a member
-- inserts a source_media, assets or asset_variants row whose r2_key points at
-- another workspace's object, and the server then presigns, zips or sends that
-- key to the LLM with owner R2 credentials. The client role could also flip
-- assets.approved, and brand_kits.logo_r2_key had the same foreign key problem
-- through getBrandKit (Update.md 4.2).
--
-- Every one of these rows is written by the web app's owner connection
-- (DATABASE_URL, apps/web/src/lib/services/db.ts) or by the worker's owner
-- connection (trigger/src/db-store.ts). Nothing writes them through the
-- browser or server Supabase client any more (saveBrandKit moved to the owner
-- connection in the same change), so member write policies can go.
--
-- Pattern, as in 0002 and 0007: members read, only the owner or service role
-- connection writes. Where a direct member write is harmless and plausible
-- (brand kit and product edits) it is limited to owner, admin and editor, and
-- the client role stays read only.

-- source_media: member read only.
DROP POLICY "source_media_tenant_isolation" ON "source_media";--> statement-breakpoint

CREATE POLICY "source_media_select_member" ON "source_media"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

-- assets: member read only. The approved flag and the QC verdict are written
-- by the worker; no member, client or otherwise, changes them from outside.
DROP POLICY "assets_tenant_isolation" ON "assets";--> statement-breakpoint

CREATE POLICY "assets_select_member" ON "assets"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

-- asset_variants: member read only.
DROP POLICY "asset_variants_tenant_isolation" ON "asset_variants";--> statement-breakpoint

CREATE POLICY "asset_variants_select_member" ON "asset_variants"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

-- brand_kits: every member reads; owner, admin and editor insert and update.
-- No delete policy: nothing in the product deletes a kit from a client.
DROP POLICY "brand_kits_tenant_isolation" ON "brand_kits";--> statement-breakpoint

CREATE POLICY "brand_kits_select_member" ON "brand_kits"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

CREATE POLICY "brand_kits_insert_non_client" ON "brand_kits"
  FOR INSERT
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));--> statement-breakpoint

CREATE POLICY "brand_kits_update_non_client" ON "brand_kits"
  FOR UPDATE
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));--> statement-breakpoint

-- products: every member reads; owner, admin and editor insert and update.
-- The FOR ALL policy let a client seat DELETE products, which cascades to
-- generation_jobs, assets, asset_variants and pack_files. No delete policy.
DROP POLICY "products_tenant_isolation" ON "products";--> statement-breakpoint

CREATE POLICY "products_select_member" ON "products"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

CREATE POLICY "products_insert_non_client" ON "products"
  FOR INSERT
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));--> statement-breakpoint

CREATE POLICY "products_update_non_client" ON "products"
  FOR UPDATE
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')))
  WITH CHECK (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin','editor')));--> statement-breakpoint

-- share_links and gallery_items: publishing is a consent decision. Any member
-- could insert a public share link or a published, consented gallery item for
-- the workspace's assets. Members read; the server writes. The public read
-- policies from 0001 and 0002 stay as they are.
DROP POLICY "share_links_tenant_isolation" ON "share_links";--> statement-breakpoint

CREATE POLICY "share_links_select_member" ON "share_links"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

DROP POLICY "gallery_items_tenant_isolation" ON "gallery_items";--> statement-breakpoint

CREATE POLICY "gallery_items_select_member" ON "gallery_items"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

-- referrals: credit bearing rows, written only by the server.
DROP POLICY "referrals_tenant_isolation" ON "referrals";--> statement-breakpoint

CREATE POLICY "referrals_select_member" ON "referrals"
  FOR SELECT
  USING (referrer_workspace_id in (select workspace_id from members where user_id = auth.uid()));--> statement-breakpoint

-- integrations: store credentials (encrypted_token). Only owners and admins
-- may even read the row, and only the server writes it.
DROP POLICY "integrations_tenant_isolation" ON "integrations";--> statement-breakpoint

CREATE POLICY "integrations_select_owner_admin" ON "integrations"
  FOR SELECT
  USING (workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin')));--> statement-breakpoint

-- Defense in depth: an object key must live under its own workspace's prefix
-- (ws/{workspace_id}/...), whoever writes the row. The constraints are added
-- NOT VALID on purpose: production rows written before this migration are not
-- scanned, so a legacy row can never fail the migration. Every new insert and
-- every update is checked. Run VALIDATE CONSTRAINT later, once the existing
-- rows have been audited.
ALTER TABLE "source_media" ADD CONSTRAINT "source_media_r2_key_workspace_prefix"
  CHECK (starts_with(r2_key, 'ws/' || workspace_id::text || '/')) NOT VALID;--> statement-breakpoint

ALTER TABLE "asset_variants" ADD CONSTRAINT "asset_variants_r2_key_workspace_prefix"
  CHECK (starts_with(r2_key, 'ws/' || workspace_id::text || '/')) NOT VALID;--> statement-breakpoint

ALTER TABLE "pack_files" ADD CONSTRAINT "pack_files_r2_key_workspace_prefix"
  CHECK (starts_with(r2_key, 'ws/' || workspace_id::text || '/')) NOT VALID;--> statement-breakpoint

ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_logo_r2_key_workspace_prefix"
  CHECK (logo_r2_key IS NULL OR starts_with(logo_r2_key, 'ws/' || workspace_id::text || '/')) NOT VALID;
