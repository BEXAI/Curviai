# Phase 1: Data and auth

Status: complete (2026-09-27). 24 PGlite tests green including cross workspace RLS isolation under a non superuser role and ledger math.
Date started: 2026-09-27

## Plan

1. packages/db/src/schema.ts: full Drizzle schema from plan section 4.3, all 19 tables with foreign keys, unique constraints (jobs.idempotency_key, one subscription row per workspace) and indexes on every workspace_id.
2. SQL migrations via drizzle-kit generate plus a hand written migration enabling RLS on every tenant table with the membership policy, denying client role writes to generation_jobs and credit_ledger, and defining credit_balance, reserve_credits, charge_credits and release_credits as plpgsql functions with a workspace row lock.
3. Migrations never create the auth schema. Supabase provides auth.uid() in production; tests create a shim before applying migrations.
4. Tests on PGlite (real Postgres in WASM): migrations apply, cross workspace isolation under a non superuser role (RLS is bypassed by superusers, so tests SET ROLE app_user), ledger math, seed idempotency for the 18 channel specs.
5. Supabase Auth wiring in apps/web: SSR client helpers, middleware guarding /app, login and signup pages that degrade to a waitlist notice when Supabase env is absent.

## Acceptance

A user cannot read another workspace (isolation test passes). pnpm test packages/db green.
