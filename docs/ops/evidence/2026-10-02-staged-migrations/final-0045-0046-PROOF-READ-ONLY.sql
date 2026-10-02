-- READ ONLY. Explicit final evidence for staged0045/0046; no customer content.
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SELECT jsonb_build_object(
 'journal',(SELECT jsonb_build_object('count',count(*),'latest',max(created_at)) FROM drizzle.__drizzle_migrations),
 'new_migrations',(SELECT jsonb_agg(jsonb_build_object('created_at',created_at,'hash',hash) ORDER BY created_at) FROM drizzle.__drizzle_migrations WHERE created_at>=1790953680011),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('pack_cases','pack_case_events','pack_case_notes','workspace_credit_budgets','workspace_credit_budget_audit')),
 'tenant_select_policies',(SELECT jsonb_agg(jsonb_build_object('table',tablename,'name',policyname,'qual',qual) ORDER BY tablename,policyname) FROM pg_policies WHERE schemaname='public' AND permissive='PERMISSIVE' AND tablename IN ('pack_cases','pack_case_events','pack_case_notes','workspace_credit_budgets','workspace_credit_budget_audit')),
 'budgets',(SELECT jsonb_build_object('configured',count(*),'enabled',count(*) FILTER(WHERE monthly_limit IS NOT NULL)) FROM public.workspace_credit_budgets),
 'policy_constants',(SELECT jsonb_object_agg(key,value) FROM public.platform_settings WHERE key IN ('credit_budget_period','credit_budget_max_monthly')),
 'snapshot_access',(SELECT jsonb_build_object('owner',r.rolname,'security_definer',p.prosecdef,'stable',p.provolatile='s','search_path',p.proconfig,'owner_full_ledger',r.rolsuper OR r.rolbypassrls OR (c.relowner=r.oid AND NOT c.relforcerowsecurity),'reserve_owner_can_execute',has_function_privilege((SELECT proowner FROM pg_proc WHERE oid='public.reserve_credits(uuid,numeric,uuid)'::regprocedure),p.oid,'EXECUTE')) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_class c ON c.oid='public.credit_ledger'::regclass WHERE p.oid='public.workspace_credit_budget_snapshot(uuid)'::regprocedure),
 'webhook_tables_absent',to_regclass('public.webhook_endpoints') IS NULL AND to_regclass('public.pack_completion_events') IS NULL AND to_regclass('public.webhook_deliveries') IS NULL,
 'logical_run_columns_absent',NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.generation_jobs'::regclass AND NOT attisdropped AND attname IN ('logical_run_id','logical_run_outcome'))
) AS curvi_staged_proof;
COMMIT;
