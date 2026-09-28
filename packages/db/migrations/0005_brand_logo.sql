-- Brand kit logo storage. The logo lives in R2 like all media; the kit row
-- keeps its object key. logo_asset_id remains for pipeline generated logo
-- treatments later.
ALTER TABLE "brand_kits" ADD COLUMN IF NOT EXISTS "logo_r2_key" text;
