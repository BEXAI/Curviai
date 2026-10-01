-- Cookieless count of site visitors (apps/web/src/lib/visits, /app/ops/visitors).
--
-- Render's dashboard reports no visitors, and PostHog loads only after cookie
-- consent, so neither can count everyone. The site counts page views itself,
-- the way Plausible documents it: no cookies, nothing stored on the device,
-- and no IP address or user agent stored anywhere.
--
-- site_visit_salts: one random 32 byte salt per UTC day (64 hex characters),
--   made by the first page view of the day. The web app deletes salts older
--   than yesterday, so a day's visitor_hash can never be recomputed, or
--   linked to the same person on another day, once its salt is gone.
-- site_visits: one row per page view. visitor_hash is the first 16 bytes of
--   HMAC-SHA256 under the server's VISITS_HASH_KEY over (salt, site host,
--   client IP, user agent), as hex; the key is never in the database, so
--   its contents alone cannot recompute a code. path is normalized (no query
--   string, ids as :id), referrer_host is a host name only. Only the UTC day
--   is kept, no time of day, in either table. (day, visitor_hash) backs the
--   unique count, the per visitor daily cap and every 30 day range.
-- site_visits_daily: unique visitors and page views per day, for the
--   Supabase SQL editor. security_invoker, so it reads site_visits with the
--   rights of whoever queries it and never widens access.
--
-- Platform tables, not tenant data, so no workspace_id. RLS is on with no
-- policies, and anon and authenticated lose every privilege on both tables,
-- the view and the id sequence (the 0010 spend_cap_counters pattern), so only
-- the owner connection and the service role can read or write a row.
CREATE TABLE "site_visit_salts" (
	"day" date PRIMARY KEY NOT NULL,
	"salt" text NOT NULL,
	CONSTRAINT "site_visit_salts_salt_check" CHECK ("site_visit_salts"."salt" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "site_visits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"visitor_hash" text NOT NULL,
	"path" text NOT NULL,
	"referrer_host" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"device" text NOT NULL,
	CONSTRAINT "site_visits_visitor_hash_check" CHECK ("site_visits"."visitor_hash" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "site_visits_device_check" CHECK ("site_visits"."device" in ('mobile', 'tablet', 'desktop')),
	CONSTRAINT "site_visits_lengths_check" CHECK (char_length("site_visits"."path") <= 300 and char_length(coalesce("site_visits"."referrer_host", '')) <= 255 and char_length(coalesce("site_visits"."utm_source", '')) <= 100 and char_length(coalesce("site_visits"."utm_medium", '')) <= 100 and char_length(coalesce("site_visits"."utm_campaign", '')) <= 100)
);
--> statement-breakpoint
CREATE INDEX "site_visits_day_visitor_hash_idx" ON "site_visits" USING btree ("day","visitor_hash");--> statement-breakpoint

ALTER TABLE "site_visit_salts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "site_visits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE VIEW "site_visits_daily" WITH (security_invoker = true) AS
  SELECT
    "day",
    count(DISTINCT "visitor_hash")::integer AS "visitors",
    count(*)::integer AS "page_views"
  FROM "site_visits"
  GROUP BY "day";--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.site_visit_salts, public.site_visits, public.site_visits_daily FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.site_visits_id_seq FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
