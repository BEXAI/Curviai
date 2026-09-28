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
- Before deploy (founder): apply 0011 to 0013 to production, then push.
