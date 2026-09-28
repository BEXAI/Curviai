CREATE TABLE "spend_cap_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"total_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Shared spend cap totals (plan 4.4). Platform table: RLS on with no
-- policies, and no table privileges for client facing roles, so only the
-- worker's owner or service role connection can read or move a counter.
ALTER TABLE "spend_cap_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.spend_cap_counters FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
