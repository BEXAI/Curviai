# Phase 10: full stack update, batch 1 (truthful, billable, reliable)

Date: 2026-09-28. Branch: `full-stack-update`. Source: the nine agent discovery sweep of 2026-09-28 (215 findings, file:line evidence each), grouped into 11 plan sections. This batch implements the code side of milestones M0 (truthful and safe to sell), M1 (first dollar) and M2 (reliable delivery) that needs no external account and no pricing decision.

## Out of scope for this batch

- Anything that needs an account or key that does not exist yet: Stripe live keys and prices, a Resend sending domain, Sentry DSN, Trigger.dev cloud (v4 upgrade), Upstash in production, Shopify Partner app, Amazon SP API. Code paths may be prepared behind env checks.
- Price changes. Discovery found generative stills sell below cost (1 credit, about $0.08 to $0.145 of revenue, against about $0.17 of provider cost). Repricing is a founder decision, recorded in the full plan.
- Render plan upgrade (costs money), production migrations, pushes to main (main auto deploys).
- New npm dependencies (lockfile merges across parallel work packages).

## Decisions taken as defaults (reversible)

1. Features that do not run in production stay visible on marketing and pricing only when labeled "Coming soon", and are never listed as included in what a plan pays for today.
2. Annual subscriptions grant the full year of credits on the paid annual invoice, since no scheduler runs in production for monthly grants.
3. A refund or dispute claws back the credits that invoice granted, never below zero.
4. Free signup credits are granted once the email is confirmed, not at auth user creation.
5. Rate limits use Upstash when its env vars are set, and an in process limiter otherwise.

## Work packages (parallel, one worktree each)

| Package | Scope | Findings |
|---|---|---|
| P1 truthful surface | Marketing, help, category and dashboard copy; demo imagery labels; FAQ structured flags | mkt-feature-claims-undelivered, grow-claims-honesty, money-claims-accuracy (outside pricing), mkt-pricing-copy-numbers (outside pricing), mkt-demo-imagery-fake, U6.12 |
| P2 billing | Checkout, portal, webhook, billing page, pricing CTAs and pricing copy, Stripe setup doc | U1.1 to U1.5, U4.4, U6.13, mkt-pricing-checkout-path, app-billing-page-flows, money-webhook-hardening, money-checkout-tax-promos, money-plan-change, money-dunning, money-pricing-intent, research-stripe-launch-config, money-stripe-launch-setup |
| P3 security | Tenant write lockdown (migration 0011), redirects, auth forms, route validation, brand kit checks, security headers, rate limits, plan intent through signup | U4.1 to U4.3, U4.6, U4.7, U6.11, mkt-auth-forms-hardening, app-api-hardening, plat-security-hardening, plat-api-rate-limits |
| P4 credits | Signup grant on confirmed email from the seed (migration 0012), reserve error mapping, no holds for undeliverable shots, seed driven entitlements, COGS persistence, spend alert delivery | U1.8, U1.9, plat-free-credit-abuse, money-free-tier-abuse, money-estimate-overreserve, app-tier-entitlements, money-tier-entitlements, cost-ledger, plat-cogs-spend-alerts |
| P5 core app | New pack form, job board, downloads, status codes, stale sweep, badges, source media dedupe (migration 0013) | app-new-pack-product-default, U6.1 to U6.8, U6.14, app-job-board-truth, app-concept-mode, U3.2, U3.5, U3.6 |
| P6a pipeline | Composite, QC, specs, packager and planner fixes in packages/pipeline and packages/specs | U2.4 to U2.8, U2.10, U2.12, U2.14 (pipeline side), U2.16, U7.8 |
| P6b AI layer | Router timeouts, cost estimates, safety blocks, reservation leaks, alert hook | U5.1, U5.3 to U5.7 |
| P6c runner | Live runtime and pipeline runner fixes: thin products, QC on shipped bytes, per channel outputs, segmentation guard, measured badge values, per shot failure isolation, prompt escaping, LLM plan validation, rule 2 literals | U2.2, U2.3, U2.11, U2.13, U2.14 (runtime side), U2.15, U3.3, U4.5, U1.7, U7.4 |
| P7 platform | /api/health, Render health check path, inline runner concurrency limit and graceful shutdown, root tsconfig for e2e, launch checklist of external steps | U0.2, plat-render-hosting (code side), plat-durable-pack-execution (inline side), plat-health-uptime, U7.7, plat-email-deliverability (doc), plat-ci-deploy-gate (doc) |

Migration numbers are pre-assigned so parallel packages cannot collide: 0011 (P3), 0012 (P4), 0013 (P5). A package that only needs SQL (policies, functions) writes the SQL by hand and adds a journal entry. A package that changes schema.ts also ships the matching snapshot.

## Gates

- Each package: its own tests, `pnpm typecheck` and `pnpm lint` pass in its worktree; rule 3 tests stay green; every new table or policy has an RLS test.
- After merge: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`, then the reviewer agent on RLS, cost caps and billing.
- Before deploy (founder): the ordered steps in "Before deploy" below.

## Before deploy

Order for the founder, after the batch 1 fix pass is merged into `full-stack-update` and passes `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`. docs/LAUNCH_CHECKLIST.md steps 5 to 8 give the details and how to verify each step; where the two differ, this order wins (the checklist does not yet list `pnpm db:seed`). Main auto deploys, so nothing below may run out of order. External facts behind these steps are recorded in docs/verification.md, "Phase 10 batch 1".

1. **Render deploys only after CI passes.** Render dashboard, the Curviai service, Settings, Auto-Deploy: After CI Checks Pass (checklist step 5).
2. **Set environment variables in Render** (Environment tab) before touching the database, so the first batch 1 build starts with them and the gap between the migrations and the push stays short. Saving may redeploy the version live today; that is harmless, since it does not read these variables. The service was created in the dashboard, so render.yaml values are not applied by themselves.
   - Add `CURVI_INLINE_PACK_CONCURRENCY` = `1` (new). Raise it only with a larger plan (checklist step 9).
   - Add `FOUNDER_ALERT_EMAIL` = the founder's inbox (new). With `RESEND_API_KEY` set, the $50 provider spend alert and the daily hard stop notice are emailed there; without both they only reach the logs.
   - Add `FOUNDER_ALERT_FROM` (new, optional) = a sender on a domain verified in Resend. The default, `Curvi Alerts <alerts@curvi.ai>`, works only once curvi.ai is verified in Resend (checklist step 2).
   - Keep `TRIGGER_SECRET_KEY` unset. Trigger.dev Cloud no longer runs v3, which the code still uses, so with the key set every pack fails to queue.
   - Keep `CURVI_SHUTDOWN_GRACE_MS` unset until step 8 shows `maxShutdownDelaySeconds` at 300; then `240000` is optional.
   - Keep `STRIPE_TAX_ENABLED` unset (new, optional) until Stripe Tax registrations exist (docs/STRIPE_SETUP.md section 7).
   - Keep `CURVI_ALLOW_DEMO_GENERATION` unset in production.
   - Optional: `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for rate limits shared across instances (checklist step 11); without them each instance counts on its own.
   - Also set any variable the fix pass added to `.env.example`. `RENDER_GIT_COMMIT` is set by Render, not by hand.
3. **Check production and take a backup.** Production must be at 0010: `select id, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1;` returns the `when` of `0010_spend_cap_counters` in `packages/db/migrations/meta/_journal.json`. Make sure a restorable backup from today exists in Supabase, because 0013 deletes duplicate `source_media` rows. See how many duplicate groups 0013 will collapse: `select workspace_id, r2_key, count(*) from source_media group by 1, 2 having count(*) > 1;`
4. **Audit object keys for 0011.** 0011 adds workspace prefix checks as NOT VALID, so old rows never fail the migration, but any later update of a row that breaks the rule is refused. List those rows first and fix or remove them:

   ```sql
   select 'source_media' as t, id, workspace_id, r2_key from source_media where not starts_with(r2_key, 'ws/' || workspace_id::text || '/')
   union all select 'asset_variants', id, workspace_id, r2_key from asset_variants where not starts_with(r2_key, 'ws/' || workspace_id::text || '/')
   union all select 'pack_files', id, workspace_id, r2_key from pack_files where not starts_with(r2_key, 'ws/' || workspace_id::text || '/')
   union all select 'brand_kits', id, workspace_id, logo_r2_key from brand_kits where logo_r2_key is not null and not starts_with(logo_r2_key, 'ws/' || workspace_id::text || '/');
   ```

   Validating the four `*_r2_key_workspace_prefix` constraints (`ALTER TABLE ... VALIDATE CONSTRAINT`) is optional and waits until this query returns no rows.
5. **Apply 0011, 0012 and 0013.** From a checkout of the merged `full-stack-update` (the migration files as they stand after the fix pass), over the direct connection, run `pnpm db:migrate` (checklist step 6). It applies exactly 0011, 0012 and 0013, in order.
6. **Run `pnpm db:seed` right away,** with the same `DATABASE_URL` and the same checkout. It writes `free_signup_credits` into `platform_settings` from the seed, upserts channel specs and recipes, and pays any confirmed signup still waiting for its grant. Until it runs, 0012 has no amount to grant, so newly confirmed signups get no free credits; the seed run pays them when it settles pending grants. The output ends with "Settled N pending signup grants."
7. **Push main.** Merge `full-stack-update` into main right after steps 5 and 6; keep that gap short. The code live today inserts `source_media` without the conflict clause, so once 0013 is applied, resubmitting an already registered upload fails until batch 1 is live. Then watch CI and the Render deploy (checklist step 7). `curl -s https://curvi.ai/api/health` must return 200 with `"schema":"current"`.
8. **Only then set the health check path.** Render, Settings, Health Checks: `/api/health`, then `maxShutdownDelaySeconds` 300 through the Render API (checklist step 8). Only the batch 1 code has `/api/health`; set against the code live today, the path returns 404 and Render restarts the instance every minute. For the same reason, do not create or sync a Render Blueprint from render.yaml before this step, since render.yaml already carries `healthCheckPath: /api/health`.
9. **Record the spot checks** listed in docs/verification.md, "Production spot checks to record after the batch 1 deploy", with the date.
