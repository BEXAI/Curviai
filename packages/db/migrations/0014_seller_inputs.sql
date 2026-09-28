-- Seller inputs the planner needs (docs/phases/PHASE_11.md, b2/inputs).
--
-- products gains the seller's own SKU, what is in the box and comparison
-- facts. Box contents and comparison facts are JSON arrays of short lines,
-- printed exactly as typed on the in_the_box and comparison images, so those
-- shots become plannable once a product has them.
--
-- source_media gains the role the seller gave each photo (front, back, side,
-- detail, in_the_box, scale), so the planner draws every angle from the
-- photo that really shows it. Null means the seller did not say.
--
-- No new table, so no new policy: the 0011 policies on products (members
-- read; owner, admin and editor write) and source_media (members read, the
-- owner connection writes) cover the new columns. Every column is nullable
-- and the check only constrains the new column, so the migration never
-- rewrites or rejects an existing row.
ALTER TABLE "products" ADD COLUMN "sku" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "box_contents" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "comparison_facts" jsonb;--> statement-breakpoint
ALTER TABLE "source_media" ADD COLUMN "angle" text;--> statement-breakpoint
ALTER TABLE "source_media" ADD CONSTRAINT "source_media_angle_check" CHECK ("source_media"."angle" is null or "source_media"."angle" in ('front', 'back', 'side', 'detail', 'in_the_box', 'scale'));
