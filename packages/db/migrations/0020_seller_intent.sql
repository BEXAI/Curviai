-- Seller intent (docs/phases/PHASE_13.md items 2 and 3).
--
-- generation_jobs.seller_note keeps the seller's note exactly as typed, and
-- generation_jobs.seller_intent the structured intent intake parsed from it
-- (featureOnly, exclude, mustKeep, styleNotes), so follow ups and retries
-- keep what the seller asked for. source_media.target_box is the product in
-- a photo the pack is for, as a box normalized to 0..1 of the upright photo,
-- written by the product chooser. All nullable with no defaults: existing
-- rows read null and behave as before. Existing tables, so RLS is unchanged.
ALTER TABLE "generation_jobs" ADD COLUMN "seller_note" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "seller_intent" jsonb;--> statement-breakpoint
ALTER TABLE "source_media" ADD COLUMN "target_box" jsonb;
