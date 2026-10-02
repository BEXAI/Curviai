ALTER TABLE "share_links" ADD COLUMN "show_proof" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- >>> Phase 18 hand written: share_proof
-- P18-16, docs/phases/PHASE_18.md. share_links keeps its policies: members
-- read their own workspace's rows (share_links_select_member, 0011) and only
-- the server's owner connection writes, so no client can turn the public
-- proof panel on or off. No new policy or grant is needed; the comment
-- records the column's purpose in the database itself.
COMMENT ON COLUMN "share_links"."show_proof" IS 'P18-16: the public share page shows each image''s measured checks. Off by default; written by the server only.';
-- <<< Phase 18 hand written: share_proof
