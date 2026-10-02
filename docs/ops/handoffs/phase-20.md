# Phase 20 implementation handoff — 2026-10-02

Checkout: `/tmp/curvi-phases-18-20`, branch `codex/complete-phases-18-20`. Parent owns all publication, live configuration and deployment. This handoff covers the Phase 20 data/billing/operator/pack lane; it is not a declaration that the phase or production acceptance is complete. Full 66-item matrix is in `docs/phases/PHASE_20.md`. Other owners' evidence: `customer.md`, `schema.md` and their delivery/worker handoffs.

## Implemented by this lane

- Central operations/retention/support/auth/Turnstile/regenerate policy seeds. Schema child coordinated additive migrations 0040–0044; its exact migration and snapshot evidence is in `schema.md`.
- P20-06 next-renewal Stripe subscription schedules, pending plan/Keep current plan UI, owner/admin authorization, serialized schedule/cancel actions, schedule release/terminal webhook clearing. No immediate paid-tier downgrade and no credit ledger mutation from a schedule request. Cancellation's smaller-plan offer uses the same persisted schedule writer.
- P20-07 activation mail migrated onto the common transactional sender; annual/monthly renewal notices with deterministic keys; price-change notice CLI; daily tick integration via scheduling owner. Billing consent rows remain independent and retained.
- P20-09 workspace-scoped grouped credit history, stable cursor, safe current-page CSV, owner/admin Stripe invoice/PDF listing with bounded cache. Spreadsheet formula escaping also covers leading whitespace/control characters while trusted signed numeric amounts stay numeric.
- P20-45/46 operator overview, switch editor, audited grant UI, provider reset/probe controls, job filters/timeline and workspace-guarded five-minute source links. Every page/action calls the AAL2 operator helper. Forced actions require explicit confirmation; normal recovery refuses a fresh heartbeat. Backend restart locks, run keys and one-restart/hour limit are reused. Requeued jobs get scoped unique pickup. Operator nav is owned by the customer lane.
- P20-42b/c streamed All files ZIP includes generated `ads/ads.csv` with exact selected ZIP paths; colliding scene versions preserve the stored filename under `versions/<shotId>/` rather than adding `-2`. Report JSON/PDF is rebuilt from currently picked variants on each read.
- Exact post-packaging `PackFileReport` records are persisted at `assets.qc.fileReports[r2Key]` inside the same delivery transaction as variant rows. Worker owner approved the narrow `db-store.ts`, `pipeline-runner.ts` and `follow-up.ts` propagation edits. Existing QC, source identity, COGS and run fencing remain. No schema migration required. `listJobFiles` fidelity reads exact object proof too. Legacy original report fallback is permitted only for the original exact object key; an older variation/followup without saved checks is explicitly unmeasured, never given another file's metrics.

## Verification

All commands used Node 22.23.3 with `PATH=/tmp/node-v22.23.3-darwin-arm64/bin:$PATH`. Tests use local mocks/PGlite and no real provider spend or email delivery.

```sh
pnpm --filter @curvi/web exec vitest run src/lib/billing src/lib/ops/jobs.test.ts src/lib/ops/switches.test.ts src/lib/ops/boundary.test.ts src/app/app/ops
```

Result: 39 passing files, one skipped file; 496 passed tests, two PostgreSQL-only race tests skipped. Billing and operator targeted ESLint and web TypeScript passed.

```sh
pnpm --filter @curvi/trigger exec vitest run src/db-store.test.ts src/follow-up.test.ts
```

Result: 32 passed tests. Includes regenerated `.v2` with a full channel bypass, delivered-only ledger charge, `picked:false` and exact saved per-file report; original delivery persists reports alongside variants.

```sh
pnpm --filter @curvi/pipeline exec vitest run src/packager/ads-pack.test.ts
pnpm --filter @curvi/web exec vitest run src/lib/pack-zip.test.ts src/lib/picked-compliance.test.ts src/lib/compliance-report.test.ts src/lib/compliance-pdf.test.ts src/lib/services/db.test.ts src/lib/services/file-fidelity.test.ts src/lib/billing/history.test.ts src/app/api/jobs/compliance-routes.test.ts src/app/api/jobs/pack-contents.test.ts src/app/api/jobs/jobs-routes.test.ts src/lib/http/zip-stream.test.ts
pnpm --filter @curvi/trigger typecheck
pnpm --filter @curvi/web typecheck
```

Final combined web suite: **131 tests in 11 files passed**. Packager ads: **four passed**. Worker and web TypeScript checks passed. Earlier 94/89-test focused batches overlap and are not additional unique tests. Targeted ESLint on all changed packaging/report/worker files passed, including shared `services/db.ts`.

## Remaining acceptance gates and limitations

- Real Stripe monthly/annual schedule transition, release/Keep current plan, renewal/price-change notices and invoice/PDF access; captured test-mode fixtures and external PostgreSQL race suite. Verify actual boundary event billing reason. No payment or mailbox acceptance claimed.
- Operator MFA enrollment, live pause/unpause/refusal with two audit rows, stale/forced recovery, provider reset and funded canary. Existing breaker interface exposes reason/reset/probe but no reliable expiry; overview does not invent one.
- Real picked-version ZIP/PDF smoke after deployment. Legacy versions cannot reconstruct absent post-packaging measurements, so the report marks those checks unmeasured.
- Live health/deployment/migration/backup/restore/monitor evidence belongs to parent and schema/delivery owners. Original ops-key cleanup remains deferred until every reader has spent a release in production.
- Model retirement warnings were found missing during audit; Phase 18 owner subsequently implemented P20-22 with 70 seed/58 web tests and TypeScript/lint passing. Planner v4/v5 are inactive at zero traffic, pending real eval and canary promotion.
- P20-47 cap/margin alert inputs are now wired by the scheduler owner with three fixture tests; incomplete historical QC omits margin telemetry and intentionally does not resolve an existing alert.
- Triggered P2 features remain disabled/unimplemented where their trigger has not been recorded. No arbitrary invite, batching, listing-text, customer-MFA, checkpoint or priority/fairness feature was activated.

## P20-58 docs refresh and publication sequence

Replaced the stale 2026-09-28 blanket-unbuilt PENDING list with current implementation vs external acceptance state and operational links. Rewrote Stripe portal/schedule/renewal instructions while retaining exact price/env/event inventory. Added RUNBOOK and refreshed ALERTS/BACKUP_RESTORE; staging/DR remain scheduler-owned, LAUNCH customer-owned, verification parent-owned. Main auto-deploy authorization is reflected; release CLI preserves the trigger by default and cannot drain a deployment that already started from a merge.

Suggested dependency order for parent-controlled publication (each from a clean candidate with its own typecheck/tests):

1. Packages and worker contracts: pipeline seeds/policies, AI cap/provider contracts, trigger ownership/recovery/spend/provider/report propagation plus exported package subpaths. Schema 0040–0044 is applied in production; local schema commit `7082ec4` is still pending code publication. Do not duplicate migrations. Do not publish an importer before its new export exists.
2. Web runtime and APIs: jobs/recovery/queue/memory, shared services and regenerate, storage/retention/tick/alert signals, provider preflight/canary, exact report/ZIP helpers and routes, corresponding API/MCP contracts. Keep `services/db.ts` and its service types/demo consumers in one candidate; it is shared by multiple lanes.
3. Billing as one feature batch: schedule/pending UI and cancel writer, webhook/reconcile changes, transactional notices, history/invoices and scripts, requiring batch-one policy exports and existing email/schema contracts. Renewal route may precede tick registration, but tick cannot import it before it exists.
4. Customer and operator surfaces with shared auth/MFA helpers: support/auth/help, operator security/cockpit/gallery/alerts, AppNav/layout, session and middleware gates. Provider controls depend on worker/provider exports; job actions depend on runtime recovery.
5. Delivery/security/docs: reviewed production/staging manifests, cron launcher, CI/security/smoke gates, CSP policy and runbooks. Env manifests may need to accompany the first consumer batch for completeness tests. Inactive recipe/eval scaffolds can ship separately after shared policy contracts; no live traffic promotion.

This is a grouping recommendation, not a verified cherry-pick recipe: the integration checkout has cross-file edits, so rebuild each exact candidate and add any required dependency before merge. Parent controls final Git manifests and live observations.

### Audit repairs before final freeze

- Schedule recovery now verifies the live attachment's customer and subscription under the checkout lock, restores a missing pending target after an accepted-but-lost response, and exposes Keep current plan for an empty/unknown attachment without inventing a target. Owner/admin Billing refreshes this state; a failed refresh is visible. The keep action also works when no pending fields were persisted. Recovery tests cover ambiguous update plus failed cleanup, empty orphan and cross-customer rejection.
- Credit history SQL truncates group timestamps to the same millisecond precision used by its serialized cursor. A 53-row fixture with explicit PostgreSQL microseconds proves no rows disappear between pages.
- CSV formatting moved to browser-safe `@curvi/pipeline/csv`; the packager reexports it for compatibility. This removes Node/archive/image modules from the client path through `pack-zip.ts`.
- Schema owner fixed reconciliation cron bookkeeping: failed/truncated runs retain diagnostics/resume state without advancing last success (24 tests passed). Phase 18 owner handles the equivalent lifecycle aggregate-failure/skip rule.

Final audit/docs check: seven suites passed **104 tests** (history3, schedule recovery7, billing render20, reconcile24, billing plans16, release docs2, alert docs32), then owned ESLint and `git diff --check` passed. Browser-safe CSV retest: web ZIP/report/route **13 passed**, pipeline ads **four passed**. Latest backend memory evidence is in `pipeline.md`: 2 GiB/concurrency two passed locally at 1012.20 MiB RSS; 512 MiB/concurrency one failed at 724.66 MiB. Real staging load remains pending.

Publication clarification from parent: main currently contains only the earlier foundation/copy PR batches, not the complete `release/2026-10-02` baseline. Each proposed feature batch must include its still-unpublished Phase 18/19/20 baseline dependencies as well as this working tree’s new changes. Production SQL application and Git code publication are separate facts.

Final combined freeze check (supersedes the earlier overlapping billing/operator counts):

```sh
pnpm --filter @curvi/web exec vitest run src/lib/billing src/lib/ops/jobs.test.ts src/lib/ops/switches.test.ts src/lib/ops/boundary.test.ts src/app/app/ops src/lib/ops/release-docs.test.ts src/lib/alerts-doc.test.ts src/lib/ops/recovery-docs.test.ts
```

**42 passing files, one skipped file; 540 passed tests, two PostgreSQL-only tests skipped.** This includes the updated recovery environment inventory. No full Next build or external acceptance is claimed by this result; the integration owner runs that gate on the exact publication candidate.

### Final release audit repair: renewal notice terms

The read-only release audit found that reminders quoted the current DB plan even when Stripe had accepted a different next-renewal plan. The approved narrow repair now verifies the live subscription/customer binding, attached schedule/subscription/customer binding, next phase and actual USD fixed recurring Price amount/cadence before sending. Pending DB display fields and catalog prices are not used as proof. Annual-to-monthly or annual changes and monthly anniversary notices describe the verified next term. Unknown prices, missing amounts, mismatches, unsupported future phase chains and lookup failures increment `failed`; the route returns 502 and the tick does not record success. Live cancellation is excluded. The price-change CLI selects the verified next-plan cohort and retains its explicit operator-supplied future amount.

No migration, broad seed, new credential or feature flag is needed. Existing Stripe read access must cover subscription, schedule, price and customer retrieval. Added lookups are read-only; no Stripe changes or email delivery were performed during verification.

```sh
pnpm --filter @curvi/web exec vitest run src/lib/billing/renewal-notices.test.ts src/lib/cron-tick.test.ts src/app/api/cron/tick/route.test.ts src/lib/billing/renewal-terms.test.ts
```

**49 passed**, including 25 notice tests. Independent review found that a future phase starting before the current period end can reset the billing anchor. Such transitions now fail closed: the October 2 / October 20 transition / November 11 old-boundary regression records one failure and sends nothing. Web TypeScript, owned ESLint and `git diff --check` passed for the final guard. The earlier 6,598-test integration result predates this narrow repair; only its affected checks were repeated by this lane.
