-- One source_media row per uploaded object (Update.md 6.3). Every retry of
-- the new pack form registered the same R2 key again, so production can
-- already hold duplicate rows for one (workspace_id, r2_key). Before the
-- unique index can exist each group collapses onto one row:
--   1. map every duplicate to the row kept for its group. When every row of
--      the group belongs to one product, the earliest row is kept (earliest
--      created_at, then lowest id). When the group spans more than one
--      product, the latest row is kept (latest created_at, then highest id):
--      that is the resubmit pattern of the old flow, where the upload was
--      first saved under a wrongly defaulted existing product, the attempt
--      was refused after the media insert (for example for credits), and the
--      seller resubmitted the same upload as the product the pack ran for.
--      Keeping the latest row leaves the photo on that product. Either way
--      the result is deterministic;
--   2. copy any measurement or mask the kept row lacks from its duplicates;
--   3. repoint every foreign key that references a duplicate to the kept row
--      (share_links.before_media_id today, found through pg_constraint so a
--      reference added later is covered too), so no link is nulled or lost;
--   4. only then delete the duplicates.
-- A multi column foreign key into source_media cannot be repointed safely by
-- this generic step, so the migration stops instead of deleting rows under it.
-- The app inserts with ON CONFLICT DO NOTHING against the new index.

DO $do$
DECLARE
  fk record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.source_media'::regclass
      AND array_length(c.conkey, 1) <> 1
  ) THEN
    RAISE EXCEPTION 'source_media has a multi column foreign key reference; dedupe it by hand before 0013';
  END IF;

  CREATE TEMP TABLE source_media_dedupe_map (
    dupe_id uuid PRIMARY KEY,
    keep_id uuid NOT NULL
  );

  INSERT INTO source_media_dedupe_map (dupe_id, keep_id)
  SELECT ranked.id, ranked.keep_id
  FROM (
    SELECT
      s.id,
      first_value(s.id) OVER (
        PARTITION BY s.workspace_id, s.r2_key
        ORDER BY
          -- Groups that span products: latest first. These two keys are NULL
          -- for single product groups, which fall through to earliest first.
          CASE WHEN g.cross_product THEN s.created_at END DESC NULLS LAST,
          CASE WHEN g.cross_product THEN s.id END DESC NULLS LAST,
          s.created_at,
          s.id
      ) AS keep_id
    FROM source_media s
    JOIN (
      SELECT workspace_id, r2_key, count(DISTINCT product_id) > 1 AS cross_product
      FROM source_media
      GROUP BY workspace_id, r2_key
      HAVING count(*) > 1
    ) g ON g.workspace_id = s.workspace_id AND g.r2_key = s.r2_key
  ) ranked
  WHERE ranked.id <> ranked.keep_id;

  IF EXISTS (SELECT 1 FROM source_media_dedupe_map) THEN
    UPDATE source_media keep
    SET
      width = coalesce(keep.width, merged.width),
      height = coalesce(keep.height, merged.height),
      mask_r2_key = coalesce(keep.mask_r2_key, merged.mask_r2_key),
      kind = coalesce(keep.kind, merged.kind)
    FROM (
      SELECT
        m.keep_id,
        max(d.width) AS width,
        max(d.height) AS height,
        max(d.mask_r2_key) AS mask_r2_key,
        max(d.kind) AS kind
      FROM source_media_dedupe_map m
      JOIN source_media d ON d.id = m.dupe_id
      GROUP BY m.keep_id
    ) merged
    WHERE keep.id = merged.keep_id
      -- 0011 added a NOT VALID prefix check. Postgres enforces it on UPDATE,
      -- so a legacy kept row whose key sits outside its workspace is left as
      -- is (its duplicates are still removed below) instead of failing the
      -- whole migration.
      AND starts_with(keep.r2_key, 'ws/' || keep.workspace_id::text || '/');

    FOR fk IN
      SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
        AND c.confrelid = 'public.source_media'::regclass
    LOOP
      EXECUTE format(
        'UPDATE %s AS t SET %I = m.keep_id FROM source_media_dedupe_map m WHERE t.%I = m.dupe_id',
        fk.tbl,
        fk.col,
        fk.col
      );
    END LOOP;

    DELETE FROM source_media s
    USING source_media_dedupe_map m
    WHERE s.id = m.dupe_id;
  END IF;

  DROP TABLE source_media_dedupe_map;
END
$do$;--> statement-breakpoint

CREATE UNIQUE INDEX "source_media_workspace_r2_key_uq" ON "source_media" USING btree ("workspace_id","r2_key");
