-- Phase 16 security review: api_keys becomes read only for client roles.
--
-- 0024 let an owner or admin insert and update api_keys through the Supabase
-- client, and the update policy put no limit on which columns changed. A
-- signed in admin could call PostgREST directly and rewrite created_by (so a
-- key kept acting as the owner after the admin was removed), set revoked_at
-- back to null on a revoked key, or swap key_hash to take over another
-- member's key. The app never writes api_keys through a client role: every
-- write goes through the owner connection (DbApiKeyStore via createApiKey and
-- revokeApiKey), which checks the caller's role, the scope list and the
-- active key cap. So both write policies go, and the client roles lose their
-- write grants as a second layer. With RLS on and no insert, update or delete
-- policy, a client role cannot write a row even if a grant comes back.
-- Owners and admins keep api_keys_select_owner_admin for reading.
-- 0024 itself no longer creates the two write policies (it was fixed in place
-- before shipping), so the drops use IF EXISTS and only matter for a database
-- that applied an earlier draft of 0024.
DROP POLICY IF EXISTS "api_keys_insert_owner_admin" ON "api_keys";--> statement-breakpoint
DROP POLICY IF EXISTS "api_keys_update_owner_admin" ON "api_keys";--> statement-breakpoint

DO $do$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.api_keys FROM %I', r);
    END IF;
  END LOOP;
END
$do$;
