-- Restore drill checks (docs/phases/PHASE_20.md P20-11, docs/ops/BACKUP_RESTORE.md).
--
-- Loaded by pnpm ops:restore-drill into the isolated drill database only,
-- right after pnpm db:migrate and before any data arrives. It creates the
-- schema drill_check with:
--   snapshot_acl_baseline()  grants, RLS switches and policies of the fresh
--                            migrate, taken before the data is loaded;
--   fail_live_jobs()         every generation job that was live when the
--                            backup was taken is failed and its stored run
--                            payload cleared, so nothing can run it again on
--                            real provider keys;
--   verify()                 one row per check: (check_name, ok, detail).
-- The drill fills drill_check.manifest_counts and drill_check.expected from
-- the backup's manifest.json before calling verify().
--
-- Plain SQL and PL/pgSQL only (no psql meta commands), so
-- apps/web/src/lib/ops/verify-restore.test.ts runs it on PGlite.

create schema if not exists drill_check;

-- Rows per schema.table in the backup, from manifest.json.
create table if not exists drill_check.manifest_counts (
  table_name text primary key,
  expected bigint not null
);

-- Single values from manifest.json: latest_migration, ledger_total_tenths.
create table if not exists drill_check.expected (
  key text primary key,
  value text
);

create table if not exists drill_check.acl_baseline (
  kind text not null,
  name text not null,
  acl text not null,
  primary key (kind, name)
);

-- Function grants, table grants with the RLS switches, and policies in the
-- public schema, as one list that two points in time can be compared on.
create or replace function drill_check.current_acls()
returns table (kind text, name text, acl text)
language sql
stable
as $$
  select 'function'::text,
         p.oid::regprocedure::text,
         coalesce(p.proacl::text, 'default') || case when p.prosecdef then ' security definer' else '' end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
  union all
  select 'table'::text,
         c.relname::text,
         coalesce(c.relacl::text, 'default') || ' rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  union all
  select 'policy'::text,
         pol.tablename::text || '.' || pol.policyname::text,
         pol.permissive || ' ' || pol.cmd || ' ' || pol.roles::text || ' using ' || coalesce(pol.qual, '') || ' check ' || coalesce(pol.with_check, '')
  from pg_policies pol
  where pol.schemaname = 'public'
$$;

create or replace function drill_check.snapshot_acl_baseline()
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  delete from drill_check.acl_baseline;
  insert into drill_check.acl_baseline (kind, name, acl)
  select a.kind, a.name, a.acl from drill_check.current_acls() a;
  get diagnostics n = row_count;
  return n;
end
$$;

create or replace function drill_check.fail_live_jobs()
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  update public.generation_jobs
     set status = 'failed',
         error = 'Restored into a drill database; not run.',
         updated_at = now()
   where status not in ('done', 'failed', 'canceled');
  get diagnostics n = row_count;
  -- run_payload arrives with P20-33 (or P18-23); clear it wherever it exists.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'generation_jobs' and column_name = 'run_payload'
  ) then
    execute 'update public.generation_jobs set run_payload = null where run_payload is not null';
  end if;
  return n;
end
$$;

create or replace function drill_check.verify()
returns table (check_name text, ok boolean, detail text)
language plpgsql
as $$
declare
  r record;
  actual bigint;
  want numeric;
  have numeric;
  latest text;
  total_tables integer := 0;
  missing text[] := '{}';
  mismatched text[] := '{}';
  orphans text[] := '{}';
  open_to text[] := '{}';
  differences text[] := '{}';
  baseline_rows integer;
  -- The functions migrations 0002, 0004, 0007, 0009 and 0012 lock with
  -- REVOKE EXECUTE; a schema restored from a dump would open them again.
  locked text[] := array[
    'credit_balance', 'reserve_credits', 'charge_credits', 'release_credits',
    'provision_workspace', 'grant_signup_credits', 'grant_pending_signup_credits',
    'bootstrap_workspace', 'handle_new_user', 'handle_user_email_confirmed',
    'free_signup_credits', 'normalized_email_key'
  ];
begin
  -- 1 and 2. Every table of the backup exists and holds the same rows. The
  -- drizzle bookkeeping comes from pnpm db:migrate, not the backup.
  for r in
    select m.table_name, m.expected from drill_check.manifest_counts m
    where m.table_name not like 'drizzle.%'
    order by m.table_name
  loop
    total_tables := total_tables + 1;
    if to_regclass(r.table_name) is null then
      missing := missing || r.table_name;
      continue;
    end if;
    execute format('select count(*) from %s', to_regclass(r.table_name)) into actual;
    if actual <> r.expected then
      mismatched := mismatched || format('%s has %s rows, the backup %s', r.table_name, actual, r.expected);
    end if;
  end loop;
  check_name := 'tables_present';
  ok := total_tables > 0 and cardinality(missing) = 0;
  detail := case
    when total_tables = 0 then 'The manifest lists no tables.'
    when cardinality(missing) = 0 then format('%s tables from the backup exist.', total_tables)
    else 'Missing: ' || array_to_string(missing[1:10], ', ')
  end;
  return next;
  check_name := 'row_counts';
  ok := total_tables > 0 and cardinality(missing) = 0 and cardinality(mismatched) = 0;
  detail := case
    when cardinality(mismatched) = 0 then format('Every row count matches the backup across %s tables.', total_tables - cardinality(missing))
    else array_to_string(mismatched[1:10], '; ')
  end;
  return next;

  -- 3. The schema is at least as new as the one the backup came from.
  select e.value into latest from drill_check.expected e where e.key = 'latest_migration';
  check_name := 'latest_migration';
  if to_regclass('drizzle.__drizzle_migrations') is null then
    ok := false;
    detail := 'drizzle.__drizzle_migrations does not exist: pnpm db:migrate did not run.';
  else
    execute 'select max(created_at)::numeric from drizzle.__drizzle_migrations' into have;
    if latest is null then
      ok := have is not null;
      detail := format('The backup names no migration; the drill is at %s.', coalesce(have::text, 'none'));
    else
      ok := have is not null and have >= latest::numeric;
      detail := case
        when have is null then format('The drill has no migrations; the backup is at %s.', latest)
        when have = latest::numeric then format('Both at migration %s.', latest)
        when have > latest::numeric then format('The drill is at %s, newer than the backup at %s.', have, latest)
        else format('The drill is at %s, older than the backup at %s: check out the commit production runs.', have, latest)
      end;
    end if;
  end if;
  return next;

  -- 4. The ledger restored in full: its total equals the backup's.
  select e.value::numeric into want from drill_check.expected e where e.key = 'ledger_total_tenths';
  select coalesce(sum(cl.delta), 0) * 10 into have from public.credit_ledger cl;
  check_name := 'ledger_total';
  ok := want is not null and have = want;
  detail := format('Ledger total %s credits, the backup %s.', round(have / 10, 1), coalesce(round(want / 10, 1)::text, 'unknown'));
  return next;

  -- 5. Balances read through credit_balance add up to the ledger, and no job
  -- holds a negative amount.
  check_name := 'ledger_balances';
  if to_regprocedure('public.credit_balance(uuid)') is null then
    ok := false;
    detail := 'credit_balance(uuid) does not exist.';
  else
    execute 'select coalesce(sum(public.credit_balance(w.id)), 0) from public.workspaces w' into want;
    select coalesce(sum(cl.delta), 0) into have from public.credit_ledger cl;
    select count(*) into actual from (
      select cl.job_id from public.credit_ledger cl
      where cl.job_id is not null and cl.reason in ('reserve', 'release')
      group by cl.job_id
      having sum(-cl.delta) < 0
    ) negative_holds;
    ok := want = have and actual = 0;
    detail := format('Balances add up to %s, the ledger to %s; %s jobs hold a negative amount.', want, have, actual);
  end if;
  return next;

  -- 6. No foreign key points at a missing row (the load ran with
  -- session_replication_role = replica, which skips those checks).
  actual := 0;
  for r in
    select c.conname::text as conname,
           c.conrelid::regclass as child,
           c.confrelid::regclass as parent,
           (select string_agg(format('ch.%I is not null', a.attname), ' and ' order by k.ord)
              from unnest(c.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as not_null,
           (select string_agg(format('pa.%I = ch.%I', pa.attname, ch.attname), ' and ' order by k.ord)
              from unnest(c.conkey, c.confkey) with ordinality as k(child_att, parent_att, ord)
              join pg_attribute ch on ch.attrelid = c.conrelid and ch.attnum = k.child_att
              join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = k.parent_att) as join_on
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = 'public'
    order by c.conname
  loop
    actual := actual + 1;
    execute format(
      'select count(*) from %s ch where %s and not exists (select 1 from %s pa where %s)',
      r.child, r.not_null, r.parent, r.join_on
    ) into want;
    if want > 0 then
      orphans := orphans || format('%s: %s rows', r.conname, want);
    end if;
  end loop;
  check_name := 'foreign_keys';
  ok := cardinality(orphans) = 0;
  detail := case
    when ok then format('%s foreign keys, no missing rows.', actual)
    else array_to_string(orphans[1:10], '; ')
  end;
  return next;

  -- 7. Grants, RLS and policies are what the fresh migrate made.
  select count(*) into baseline_rows from drill_check.acl_baseline;
  select coalesce(array_agg(distinct x.kind || ' ' || x.name), '{}') into differences
  from (
    (select b.kind, b.name, b.acl from drill_check.acl_baseline b
     except
     select a.kind, a.name, a.acl from drill_check.current_acls() a)
    union
    (select a.kind, a.name, a.acl from drill_check.current_acls() a
     except
     select b.kind, b.name, b.acl from drill_check.acl_baseline b)
  ) x;
  check_name := 'acl_unchanged';
  ok := baseline_rows > 0 and cardinality(differences) = 0;
  detail := case
    when baseline_rows = 0 then 'No baseline was taken after the migrate.'
    when ok then format('%s grants, RLS switches and policies match the fresh migrate.', baseline_rows)
    else 'Changed: ' || array_to_string(differences[1:10], ', ')
  end;
  return next;

  -- 8. The locked functions stay closed to the client roles.
  for r in
    select p.oid, p.oid::regprocedure::text as signature, role_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join unnest(array['anon', 'authenticated']) as roles(role_name)
    where n.nspname = 'public' and p.proname = any (locked)
      and exists (select 1 from pg_roles where rolname = role_name)
  loop
    if has_function_privilege(r.role_name, r.oid, 'EXECUTE') then
      open_to := open_to || format('%s to %s', r.signature, r.role_name);
    end if;
  end loop;
  check_name := 'ledger_functions_locked';
  ok := cardinality(open_to) = 0;
  detail := case
    when ok then 'anon and authenticated cannot run the ledger and provisioning functions.'
    else 'Open: ' || array_to_string(open_to[1:10], ', ')
  end;
  return next;

  -- 9. Nothing restored can run again.
  select count(*) into actual from public.generation_jobs j where j.status not in ('done', 'failed', 'canceled');
  check_name := 'live_jobs_reset';
  ok := actual = 0;
  detail := format('%s live generation jobs.', actual);
  return next;
end
$$;
