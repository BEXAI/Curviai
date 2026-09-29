-- Phase 16 workstream 2 (docs/phases/PHASE_16.md, "More A+ modules").
--
-- products.endorsements keeps the press quotes or awards the seller typed for the
-- A+ endorsement module, one printable line each, exactly as typed (the
-- 0014 box_contents and comparison_facts pattern). Nullable jsonb held to an
-- array or null by a named check; RLS unchanged, since products already has
-- its workspace policies. Null or empty means the module is skipped: a model
-- never writes an endorsement.
ALTER TABLE "products" ADD COLUMN "endorsements" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_endorsements_array" CHECK ("products"."endorsements" IS NULL OR jsonb_typeof("products"."endorsements") = 'array');