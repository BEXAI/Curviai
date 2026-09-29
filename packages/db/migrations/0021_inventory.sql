-- Product inventory (docs/phases/PHASE_13.md, inventory stage).
--
-- generation_jobs.inventory holds what the runner found in each photo of the
-- job before any paid generation: the significant pieces of the photo's
-- cutout with deterministic facts (box, area share, shape, dominant color),
-- the label intake gave each piece when one matched, and which piece the
-- pack featured and which it removed. Nullable with no default: existing
-- rows and demo runs read null and behave as before. Existing table, so RLS
-- is unchanged.
ALTER TABLE "generation_jobs" ADD COLUMN "inventory" jsonb;
