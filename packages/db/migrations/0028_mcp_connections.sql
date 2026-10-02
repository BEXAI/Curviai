-- PHASE_19 sign in for ChatGPT and Codex (docs/phases/PHASE_19.md, P19-04
-- and P19-05, "Sign in design" and "Data model summary").
--
-- mcp_connections: which workspace an OAuth client such as ChatGPT acts in
--   for a user. One live row (revoked_at null) per (user_id,
--   oauth_client_id), enforced by a partial unique index (decision 18). The
--   consent page writes it and the MCP server reads it by the token's (sub,
--   client_id) on every call, over the owner connection, after its own
--   checks. profile_id is a random 16 byte base64url id (22 characters),
--   made once per user and copied into every later row for that user, so
--   get_profile keeps one id across reconnects (OpenAI O1). user_id has no
--   foreign key, as members.user_id. Like api_keys it guards access to the
--   workspace, so the row's user (while a member) and the workspace's owners
--   and admins read it; no client role inserts, updates or deletes, and anon
--   and authenticated lose their write privileges as a second layer.
--
-- no_oauth_clients: a token from Supabase's OAuth server is a full user
--   token, so without this today's RLS would let ChatGPT's token read the
--   workspace (with stripe_customer_id), its subscriptions and every recipe
--   prompt through the Data API, and rename the workspace. A restrictive
--   policy on every public table keeps any JWT that carries client_id out,
--   the pattern Supabase documents for OAuth clients (docs/verification.md,
--   "PHASE_19", SB1 token security). Restrictive policies are ANDed with the
--   permissive ones, so web sessions (no client_id) are unaffected. The MCP
--   server uses the owner connection and never needs PostgREST. A later
--   migration that adds a public table must add the same policy;
--   packages/db/src/mcp-connections.test.ts fails until it does.
--
-- curvi_access_token_hook: Supabase's Custom Access Token hook (SB2). It
--   sets aud to the MCP resource for tokens whose claims carry client_id
--   (only OAuth issued tokens do) and returns every other event unchanged,
--   so web sessions keep "authenticated". Supabase never binds the resource
--   parameter to the token (SB4), so the audience binding rests on the
--   client id allowlist in apps/web/src/lib/mcp-auth/verify.ts. The hook
--   runs on every sign in and refresh for every user, so it reads no table
--   and cannot raise: a failure would block all logins. The resource URL is
--   a literal because it is permanent (decision 9). Only supabase_auth_admin
--   may execute it. The founder switches it on in the dashboard (runbook B2).
CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"oauth_client_id" text NOT NULL,
	"client_name" text,
	"profile_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mcp_connections_profile_id_check" CHECK ("mcp_connections"."profile_id" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "mcp_connections_lengths_check" CHECK (char_length("mcp_connections"."oauth_client_id") between 1 and 200 and char_length(coalesce("mcp_connections"."client_name", '')) <= 200)
);
--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_live_user_client_uq" ON "mcp_connections" USING btree ("user_id","oauth_client_id") WHERE "mcp_connections"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "mcp_connections_user_client_idx" ON "mcp_connections" USING btree ("user_id","oauth_client_id");--> statement-breakpoint
CREATE INDEX "mcp_connections_workspace_id_idx" ON "mcp_connections" USING btree ("workspace_id");--> statement-breakpoint

ALTER TABLE "mcp_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "mcp_connections_select_own_or_admin" ON "mcp_connections"
  FOR SELECT
  USING (
    (user_id = auth.uid() and workspace_id in (select workspace_id from members where user_id = auth.uid()))
    or workspace_id in (select workspace_id from members where user_id = auth.uid() and role in ('owner','admin'))
  );--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.mcp_connections FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
--> statement-breakpoint

-- Keep OAuth client tokens out of the Data API: one restrictive policy on
-- every table in public, mcp_connections included. (select auth.jwt()) is
-- evaluated once per statement instead of once per row.
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOR t IN
      SELECT c.relname FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS no_oauth_clients ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY no_oauth_clients ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (((select auth.jwt()) ->> %L) IS NULL) WITH CHECK (((select auth.jwt()) ->> %L) IS NULL)',
        t, 'client_id', 'client_id'
      );
    END LOOP;
  END IF;
END
$do$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.curvi_access_token_hook(event jsonb) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN jsonb_typeof(event) = 'object'
      AND jsonb_typeof(event -> 'claims') = 'object'
      AND jsonb_typeof(event -> 'claims' -> 'client_id') = 'string'
      AND (event -> 'claims' ->> 'client_id') <> ''
    THEN pg_catalog.jsonb_set(event, '{claims,aud}', '"https://curvi.ai/api/mcp"'::jsonb, true)
    ELSE event
  END
$fn$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION public.curvi_access_token_hook(jsonb) FROM PUBLIC;--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.curvi_access_token_hook(jsonb) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.curvi_access_token_hook(jsonb) TO supabase_auth_admin;
  END IF;
END
$do$;
