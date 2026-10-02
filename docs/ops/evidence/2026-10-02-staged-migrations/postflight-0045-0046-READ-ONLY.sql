-- PREPARED, NOT EXECUTED. READ ONLY. Staged 0045 and 0046 only; 0047 stays absent.
-- Source: Phase22 70c6036 / published Phase21 parent 9d1d594, unchanged migrations.
-- No customer content, connection strings, endpoint material or secrets are selected.
-- Every DO block only asserts catalog facts/counts and can abort; no data/schema writes.
-- SQL-editor roles below do NOT identify the app/worker DATABASE_URL role.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
DO $review$
BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 47 THEN
    RAISE EXCEPTION 'Expected exactly 47 staged migration journal records through 0046';
  END IF;
  IF EXISTS (
    WITH expected(created_at,hash) AS (VALUES (1790505645397::bigint,'eb4356bf10bf3fd24307da2a83e2928964dbbb50c79c5c6a853439587e4b3a11'::text),
(1790505652283::bigint,'449ce930b29f85430cb3b6bc4aae3b9f4d8cf3d1c4aa6c1da9142667ae9f0d0a'::text),
(1790509065912::bigint,'e277fc34451005157b9322ac70d5ad806a36014293f49a654b5d16dd6601dc9e'::text),
(1790512000000::bigint,'dc65a5ae09a68d585362c29fdb2911831ec787f684d4be869c8c78eec234817c'::text),
(1790576000000::bigint,'e75ccf78493288143627e54240409066faca12cab0e6d9d10f7cfc947de2b9a5'::text),
(1790583000000::bigint,'ba963e755db914eb2340df7bbf0df490819988ce5a57ca2b8bd54366f1a97e1c'::text),
(1790590000000::bigint,'e8ff39cda8b79f1debdbc9a0ff0793ffe5254d489fb6faf84fcf190fc877f404'::text),
(1790590100000::bigint,'f10f4bcc7e2420b2ced8ed753c7d63cc53469216b8aeaa6f465ec74b00898642'::text),
(1790590200000::bigint,'a2cd5336a7e4a4fe3ba48d25dd1d848ea889e8c14b847d888c7c518ff2796d11'::text),
(1790590300000::bigint,'9861eab37d54348e3bbad0f10cc04b53a6905ca93c35e61a42cebb85f922ba9b'::text),
(1790600735599::bigint,'8997469e4c764e572310e33c28105688a7636ac049a40f531eb319fcc4d233bf'::text),
(1790700000000::bigint,'8b74354d6cc33a5f59f2beb35d8654720332b4c66a3c06d7c175aafed7220de3'::text),
(1790700100000::bigint,'6f83b51dd6ddbb8e14b92078fbe39c20adcf7bd52a876df7177b59bea2da22a0'::text),
(1790700200000::bigint,'0361039b01d4da57f7412823113adc86375510738a2f26a7c28309084e09dc45'::text),
(1790700300000::bigint,'3bddf09c824d9d47e1073996f46504171a331b0efe5989e6f6db600664456000'::text),
(1790700400000::bigint,'6e1cd1001c71a9cb214f0f4d2ce1e48c720ee62d314e7671a1d42f4d2b7af7c4'::text),
(1790700600000::bigint,'668a3af54a0b1021651ac3312e4d4d1bb5f2422fdaa2a74ea3599499e3754e51'::text),
(1790700700000::bigint,'1312c6257b3144ca966eec97603cca0b9ac09b9fb0ea150c0281d7e4ee660866'::text),
(1790700800000::bigint,'c3477fb6aa6a47fb7c25f464601eeaa394c6d2d094b4f5f1069a49d38a9079fa'::text),
(1790700900000::bigint,'5b8876c943e54acde8b00fdd0ebc452c7dcdf68b157e33a9d43a91e9f1f1cc1d'::text),
(1790701000000::bigint,'e0db8ef45902d0f6ef55cc4716115dc4d5b3025432350824eebd0f43ff3fcc12'::text),
(1790701100000::bigint,'ec017e825d41c105b8b854ff2fa0aadea0e7b48c63a71989b90edd5afd51c303'::text),
(1790701200000::bigint,'4189135210a24d0e80b8aefeacf5661fa48ec2627b06dd391f8f01221b855bb3'::text),
(1790701300000::bigint,'ceac8d5543fec2cb0757a961f6dff9329d427cac91d9b230266f6d4c33f8a0fa'::text),
(1790701400000::bigint,'67bb8360948073382ac0fc8ca9b1d0c85c1b4f3f2f495c84203959942ce91b38'::text),
(1790701500000::bigint,'a8ac3f3c07736bf7baf78d7a4a0103631d713afe96429d6bf61b20e17e715f92'::text),
(1790701600000::bigint,'918a4a363cd6f00c1fc2bea8b135038458f3ed52046edcf61105a43f5c2f51ec'::text),
(1790701700000::bigint,'e089e32ae895544b73aa8975b481507e11a56e38db145142747b1e1d83424ac8'::text),
(1790864442094::bigint,'903a24cfe4aaa635f01ad106cb2d00c3c53cdde1094d8e07d52db6d570129984'::text),
(1790864502094::bigint,'7ac60856b6b071980666e616fb56ed7c112d26b28a2e102d11e288a5975a59d5'::text),
(1790866451714::bigint,'68d150b11f2947921c8709ddf897621bc40318aeb073281b589d6054ebd49f4c'::text),
(1790866641551::bigint,'8128f9a09b18198a2468cc3d04e2b7600816d7cc290690e3ba64a8a41e6f1450'::text),
(1790866646688::bigint,'eff55703eeeac8948e1fe05c1068033160bfba82c8a90a1633a20a50be5f23f6'::text),
(1790866816106::bigint,'f72dc01bf9ab50123b4bece67dac9ebafc2aeef3d7b9727b7a196267f9b368c8'::text),
(1790868078311::bigint,'5f65b1089dfe0fdbb64ef38547a608ad064166769f0f9ae7cb7cef32044deb76'::text),
(1790870292166::bigint,'1f55997df5db236d43e7dc2924ac76c8e3c167b2606d3fb96417ce8e7585640c'::text),
(1790870315379::bigint,'4aeaf49314b31032f4866813350a950a9f08aa5e388d33ac14a4bd5cf26f6bc3'::text),
(1790870469863::bigint,'65ad15e70dd5770d16e3a867df782196c3607a87780e17d0d0025669390fb765'::text),
(1790872346199::bigint,'dd2df4d0f8610f26face54d39c77e95be2d1ad04285fe0826a6c6164f104e646'::text),
(1790921588222::bigint,'42146c3a3e8a61db06018ef6b6c138392563ac37930745da5dea25ce744c082e'::text),
(1790938247303::bigint,'bff2546b9e060cb916981d9482e21d9a5c54ec472982ac782aadefa1440bbbd2'::text),
(1790938296172::bigint,'ee904ab37319fed5ceb97ef9c21401c10d85a39249034c6f12e9dc1f5f5cc673'::text),
(1790938380386::bigint,'9ceec762888fbb9c9cf5794ce8ae8c100ddb1695ea9a640018e39685783f7a8d'::text),
(1790938484592::bigint,'9a78a3e4332dc9fbc232d3f6f9e4af6f2d5a8329fb384e329629a8e2637e8e24'::text),
(1790938535212::bigint,'229894fcc8c89c1fa382e1289a7c03366f1e3dddaca6a7022c54d9fd63bc3270'::text),
(1790953680011::bigint,'1906760bd9b890f72922bb3dc9a75ab58e82081a3637fc7384a922d953f45380'::text),
(1790953746470::bigint,'7a90bfdeda33f6659d70f0b31ef89b7eb51ceab3d11276ac05a43091fb7d2983'::text))
    SELECT 1 FROM expected e LEFT JOIN drizzle.__drizzle_migrations m USING(created_at)
    WHERE m.hash IS DISTINCT FROM e.hash
  ) THEN RAISE EXCEPTION 'Staged migration journal hashes differ from reviewed source'; END IF;
END $review$;

DO $review$
DECLARE t text; role_name text; privilege_name text; f text; expected_select boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['webhook_endpoints','pack_completion_events','webhook_deliveries']) AS x(name)
             WHERE to_regclass('public.' || x.name) IS NOT NULL)
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.generation_jobs'::regclass AND NOT attisdropped
                AND attname IN ('logical_run_id','logical_run_outcome'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.generation_jobs'::regclass AND NOT tgisinternal
                AND tgname IN ('generation_jobs_protect_completion','generation_jobs_enqueue_completion'))
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['protect_generation_job_completion()','enforce_webhook_parent()',
                 'enqueue_pack_completion()','cancel_disabled_webhook_deliveries()']) AS x(signature)
                WHERE to_regprocedure('public.' || x.signature) IS NOT NULL) THEN
    RAISE EXCEPTION '0047 objects found: staged deployment must stop at 0046';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      RAISE EXCEPTION 'Expected Supabase role missing: %',role_name;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pack_cases','pack_case_events','pack_case_notes','workspace_credit_budgets','workspace_credit_budget_audit'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relname=t AND c.relkind='r' AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'Expected staged table with RLS missing: %',t;
    END IF;
    -- Normalize only deparser whitespace/parentheses, optional SELECT alias and
    -- text cast. The accepted expression is precisely (select auth.jwt()) ->>
    -- client_id IS NULL, in BOTH USING and WITH CHECK, not just a named policy.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid=to_regclass('public.' || t) AND p.polname='no_oauth_clients'
        AND NOT p.polpermissive AND p.polcmd='*'
        AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='authenticated')]
        AND replace(replace(lower(regexp_replace(pg_get_expr(p.polqual,p.polrelid),'[[:space:]()]','','g')),'::text',''),'asjwt','')
            = 'selectauth.jwt->>''client_id''isnull'
        AND replace(replace(lower(regexp_replace(pg_get_expr(p.polwithcheck,p.polrelid),'[[:space:]()]','','g')),'::text',''),'asjwt','')
            = 'selectauth.jwt->>''client_id''isnull'
    ) THEN RAISE EXCEPTION 'Restrictive OAuth policy differs from source: %',t; END IF;
    IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
               WHERE c.oid=to_regclass('public.' || t) AND a.grantee=0) THEN
      RAISE EXCEPTION 'Unexpected PUBLIC table grant: %',t;
    END IF;
    -- aclexplode rejects zero-dimensional empty ACL arrays. Its strict NULL
    -- input produces no rows; keep the guard inside its argument, not WHERE.
    IF EXISTS (SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(CASE WHEN cardinality(col.attacl)>0 THEN col.attacl END) a
               WHERE col.attrelid=to_regclass('public.' || t) AND col.attnum>0 AND NOT col.attisdropped AND a.grantee=0) THEN
      RAISE EXCEPTION 'Unexpected PUBLIC column grant: %',t;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        expected_select := role_name='authenticated' AND privilege_name='SELECT' AND t <> 'pack_case_notes';
        IF has_table_privilege(role_name,'public.' || t,privilege_name) IS DISTINCT FROM expected_select THEN
          RAISE EXCEPTION 'Unexpected effective table privilege: % % %',role_name,t,privilege_name;
        END IF;
      END LOOP;
      -- Table-level revocation alone does not remove a column-specific grant.
      FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
        expected_select := role_name='authenticated' AND privilege_name='SELECT' AND t <> 'pack_case_notes';
        IF has_any_column_privilege(role_name,'public.' || t,privilege_name) IS DISTINCT FROM expected_select THEN
          RAISE EXCEPTION 'Unexpected effective column privilege: % % %',role_name,t,privilege_name;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF NOT has_table_privilege('service_role','public.' || t,privilege_name) THEN
        RAISE EXCEPTION 'Missing service_role table privilege: % %',t,privilege_name;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND p.polpermissive AND p.polcmd='r' AND p.polroles=ARRAY[0::oid] AND p.polqual IS NOT NULL
      AND (c.relname,p.polname) IN (
        ('pack_cases','pack_cases_select_reporter_manager'),('pack_case_events','pack_case_events_select_visible_case'),
        ('workspace_credit_budgets','workspace_credit_budgets_select_manager'),
        ('workspace_credit_budget_audit','workspace_credit_budget_audit_select_manager'))) <> 4 THEN
    RAISE EXCEPTION 'Expected staged SELECT policies missing';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('pack_cases','pack_case_events','pack_case_notes','workspace_credit_budgets','workspace_credit_budget_audit')) <> 9 THEN
    RAISE EXCEPTION 'Unexpected additional policy on a staged table';
  END IF;
  FOREACH f IN ARRAY ARRAY['workspace_credit_budget_snapshot(uuid)','set_workspace_credit_budget(uuid,uuid,numeric)','reserve_credits(uuid,numeric,uuid)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.' || f) AND p.prosecdef
                   AND 'search_path=public'=ANY(coalesce(p.proconfig,ARRAY[]::text[]))) THEN
      RAISE EXCEPTION 'Expected SECURITY DEFINER function/search_path missing: %',f;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
               WHERE p.oid=to_regprocedure('public.' || f) AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected PUBLIC function execution grant: %',f;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF has_function_privilege(role_name,'public.' || f,'EXECUTE') THEN
        RAISE EXCEPTION 'Unexpected effective client function execution grant: % %',role_name,f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role','public.' || f,'EXECUTE') THEN
      RAISE EXCEPTION 'Missing service_role function execution grant: %',f;
    END IF;
  END LOOP;
  -- CREATE OR REPLACE preserves reserve_credits ownership; its definer must
  -- be able to call the newly created, non-PUBLIC budget snapshot function.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='public.reserve_credits(uuid,numeric,uuid)'::regprocedure
                 AND has_schema_privilege(p.proowner,'public','USAGE')
                 AND has_function_privilege(p.proowner,'public.workspace_credit_budget_snapshot(uuid)','EXECUTE')) THEN
    RAISE EXCEPTION 'reserve_credits owner cannot call the budget snapshot';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    JOIN pg_class c ON c.oid='public.workspace_credit_budgets'::regclass
    JOIN pg_class ledger ON ledger.oid='public.credit_ledger'::regclass
    WHERE p.oid='public.workspace_credit_budget_snapshot(uuid)'::regprocedure
      AND p.provolatile='s'
      AND has_schema_privilege(p.proowner,'public','USAGE')
      AND has_table_privilege(p.proowner,'public.workspace_credit_budgets','SELECT')
      AND has_table_privilege(p.proowner,'public.credit_ledger','SELECT')
      AND (r.rolsuper OR r.rolbypassrls OR (c.relowner=p.proowner AND NOT c.relforcerowsecurity))
      AND (r.rolsuper OR r.rolbypassrls OR (ledger.relowner=p.proowner AND NOT ledger.relforcerowsecurity))
  ) THEN RAISE EXCEPTION 'Budget snapshot definer cannot read the complete server-side balance'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.workspace_credit_budgets'::regclass
    WHERE r.rolname=current_user
      AND has_schema_privilege(r.oid,'public','USAGE')
      AND has_table_privilege(r.oid,c.oid,'SELECT')
      AND (r.rolsuper OR r.rolbypassrls OR (c.relowner=r.oid AND NOT c.relforcerowsecurity))
  ) THEN RAISE EXCEPTION 'Inspection role cannot prove budgets are globally disabled'; END IF;
  IF EXISTS (SELECT 1 FROM public.workspace_credit_budgets WHERE monthly_limit IS NOT NULL) THEN
    RAISE EXCEPTION 'A budget is enabled while the legacy application remains deployed';
  END IF;
END $review$;

SELECT current_user AS sql_editor_role,session_user AS sql_editor_session_role,current_setting('server_version') AS server_version;
SELECT count(*) AS recorded_migrations,max(created_at) AS latest_migration FROM drizzle.__drizzle_migrations;
SELECT c.relname AS table_name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('pack_cases','pack_case_events','pack_case_notes','workspace_credit_budgets','workspace_credit_budget_audit') ORDER BY c.relname;
-- MANUAL REVIEW REQUIRED: assertions above verify the exact restrictive OAuth
-- expressions, policy names/roles/commands and absence of additional policies.
-- The four tenant SELECT USING expressions below must also match source:
-- pack_cases: workspace member AND (reporter OR owner/admin);
-- pack_case_events: its parent case is visible in the same workspace;
-- both budget tables: owner/admin membership in that row's workspace.
-- A named SELECT policy with a non-null expression is NOT proof of tenant isolation.
SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
WHERE schemaname='public' AND tablename IN ('pack_cases','pack_case_events','pack_case_notes','workspace_credit_budgets','workspace_credit_budget_audit')
ORDER BY tablename,policyname;
SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name IN ('pack_cases','pack_case_events','pack_case_notes','workspace_credit_budgets','workspace_credit_budget_audit')
AND grantee IN ('anon','authenticated','service_role') ORDER BY table_name,grantee,privilege_type;
SELECT r.rolname AS role_name,f.signature,has_function_privilege(r.oid,'public.' || f.signature,'EXECUTE') AS can_execute
FROM pg_roles r CROSS JOIN (VALUES('workspace_credit_budget_snapshot(uuid)'),('set_workspace_credit_budget(uuid,uuid,numeric)'),('reserve_credits(uuid,numeric,uuid)')) f(signature)
WHERE r.rolname IN ('anon','authenticated','service_role') ORDER BY role_name,signature;
SELECT p.oid::regprocedure AS function_name,r.rolname AS function_owner,p.prosecdef AS security_definer,r.rolsuper,r.rolbypassrls
FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
WHERE p.oid IN ('public.workspace_credit_budget_snapshot(uuid)'::regprocedure,'public.set_workspace_credit_budget(uuid,uuid,numeric)'::regprocedure,'public.reserve_credits(uuid,numeric,uuid)'::regprocedure)
ORDER BY p.oid::regprocedure::text;
SELECT tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal
AND tgrelid IN ('public.pack_cases'::regclass,'public.pack_case_events'::regclass,'public.pack_case_notes'::regclass,'public.workspace_credit_budgets'::regclass,'public.workspace_credit_budget_audit'::regclass)
ORDER BY tgname;
SELECT count(*) AS configured_budgets,count(*) FILTER(WHERE monthly_limit IS NOT NULL) AS enabled_budgets FROM public.workspace_credit_budgets;
-- These two keys are nonsecret migration policy constants only.
SELECT key,value FROM public.platform_settings WHERE key IN ('credit_budget_period','credit_budget_max_monthly') ORDER BY key;
SELECT to_regclass('public.webhook_endpoints') AS endpoints_must_be_null,
       to_regclass('public.pack_completion_events') AS events_must_be_null,
       to_regclass('public.webhook_deliveries') AS deliveries_must_be_null;
COMMIT;
