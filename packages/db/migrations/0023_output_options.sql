-- Output options (docs/phases/PHASE_15.md, seller controls for every output).
--
-- generation_jobs.output_options keeps the seller's resolved choices for a
-- pack (look, background, badge, originals, extras), products.output_defaults
-- the choices saved on a product as picked (never the resolved hex), and
-- source_media.ingest what the ingest check found in one uploaded photo. All
-- nullable with no defaults: existing rows read null, and a null
-- output_options reads as the defaults, so every older pack reads as
-- Marketplace ready. Each column holds a JSON object or null (the object
-- checks). Existing tenant tables, so RLS is unchanged (the 0020 pattern).
ALTER TABLE "generation_jobs" ADD COLUMN "output_options" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "output_defaults" jsonb;--> statement-breakpoint
ALTER TABLE "source_media" ADD COLUMN "ingest" jsonb;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_output_options_object" CHECK ("generation_jobs"."output_options" IS NULL OR jsonb_typeof("generation_jobs"."output_options") = 'object');--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_output_defaults_object" CHECK ("products"."output_defaults" IS NULL OR jsonb_typeof("products"."output_defaults") = 'object');--> statement-breakpoint
ALTER TABLE "source_media" ADD CONSTRAINT "source_media_ingest_object" CHECK ("source_media"."ingest" IS NULL OR jsonb_typeof("source_media"."ingest") = 'object');