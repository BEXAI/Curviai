ALTER TABLE "workspaces" ADD COLUMN "seller_profile" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_seller_profile_object" CHECK ("workspaces"."seller_profile" IS NULL OR (jsonb_typeof("workspaces"."seller_profile") = 'object' AND octet_length("workspaces"."seller_profile"::text) <= 1024));--> statement-breakpoint

-- >>> Phase 18 hand written: seller_profile
-- workspaces.seller_profile (docs/phases/PHASE_18.md P18-20): the first run
-- answers, what the workspace sells and where. RLS on workspaces is
-- unchanged: members read (workspaces_select_member, 0002), and owners and
-- admins keep their UPDATE policy for the name. The profile is written only
-- by the server (the web app's owner connection, after it checks the
-- answers against the seed), so it joins the columns the 0002 trigger
-- protects: a client connection, even the owner's, cannot change it.
CREATE OR REPLACE FUNCTION enforce_workspace_protected_columns() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
     OR NEW.shopify_shop IS DISTINCT FROM OLD.shopify_shop
     OR NEW.seller_profile IS DISTINCT FROM OLD.seller_profile THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolname = 'service_role')
    ) THEN
      RAISE EXCEPTION 'workspaces.plan, stripe_customer_id, shopify_shop and seller_profile can only be changed by the service role';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
-- <<< Phase 18 hand written: seller_profile
