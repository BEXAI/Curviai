CREATE TABLE "retired_source_objects" (
	"workspace_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retired_source_objects_workspace_id_r2_key_pk" PRIMARY KEY("workspace_id","r2_key"),
	CONSTRAINT "retired_source_objects_workspace_key" CHECK (starts_with("retired_source_objects"."r2_key", 'ws/' || "retired_source_objects"."workspace_id"::text || '/') AND length("retired_source_objects"."r2_key") > length('ws/' || "retired_source_objects"."workspace_id"::text || '/') AND position('..' in "retired_source_objects"."r2_key") = 0 AND position(chr(92) in "retired_source_objects"."r2_key") = 0 AND octet_length("retired_source_objects"."r2_key") <= 1024)
);
--> statement-breakpoint
ALTER TABLE "retired_source_objects" ADD CONSTRAINT "retired_source_objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Server-only deletion intentions. No member/public policy: even a member
-- cannot read or change the tombstones. They never expire; workspace deletion
-- cascades them. R2 keys are unique upload identities and must not be reused.
ALTER TABLE "retired_source_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "no_oauth_clients" ON "retired_source_objects" AS RESTRICTIVE FOR ALL TO authenticated
  USING (((select auth.jwt()) ->> 'client_id') IS NULL)
  WITH CHECK (((select auth.jwt()) ->> 'client_id') IS NULL);--> statement-breakpoint

-- Raw Data API writes cannot perform the object-retirement checks the server
-- performs under the workspace lock. Browser forms, API/CLI and worker writes
-- already use that server path. SELECT policies and Realtime reads stay intact.
-- contract: close unsupported direct member job inserts; server API remains available.
DROP POLICY "generation_jobs_insert_non_client" ON "generation_jobs";--> statement-breakpoint
-- contract: close unsupported direct member job updates; server and ledger writes remain available.
DROP POLICY "generation_jobs_update_non_client" ON "generation_jobs";--> statement-breakpoint
-- contract: close unsupported direct member brand-kit inserts; server form/API remains available.
DROP POLICY "brand_kits_insert_non_client" ON "brand_kits";--> statement-breakpoint
-- contract: close unsupported direct member brand-kit updates; server form/API remains available.
DROP POLICY "brand_kits_update_non_client" ON "brand_kits";
--> statement-breakpoint

REVOKE ALL ON TABLE "retired_source_objects" FROM PUBLIC;--> statement-breakpoint
DO $acl$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.retired_source_objects FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.retired_source_objects TO service_role;
  END IF;
END;
$acl$;
