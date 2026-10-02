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

### P20-52 hosted security settings and CodeQL triage — 2026-10-02

Parent-authorized, free/reversible settings were enabled on the existing public `BEXAI/Curviai` repository through GitHub's REST API and read back:

| Setting | Verified result |
| --- | --- |
| Dependabot alerts | Enabled; `GET /repos/BEXAI/Curviai/vulnerability-alerts` returned 204. |
| Dependabot security updates | Enabled, `paused: false`; no auto-merge enabled and no Dependabot PR merged. |
| Private vulnerability reporting | Enabled; readback `enabled: true`. |
| CodeQL default setup | Configured for `actions` and `javascript-typescript`, default query suite, standard GitHub-hosted runners and weekly scheduling. |

Existing secret scanning and push protection remained enabled. Non-provider patterns and validity checks remained disabled, and repository `allow_auto_merge` remained false. No credentials, paid options, unrelated settings or workflow source files were changed by this setup.

[Setup run 37012185268](https://github.com/BEXAI/Curviai/actions/runs/37012185268) succeeded on source main `b4893d19f6a715395f204d56a7e156a5001d8dd1`, completing at 2026-10-02 13:22:11 UTC. Actions analysis `1881028480` reported zero findings; JavaScript/TypeScript analysis `1881036729` reported **11 findings**, both with empty analysis error fields. The triage compared that main revision with feature candidate `c9799aad5f614e0e48b38c868609728db3d46eb3`; the corrected final candidate is pending its final push and matching CodeQL analysis. These results do not establish a clean CodeQL run. None of the 11 findings is removed merely by retiring Trigger orchestration, and no alert was dismissed.

The locations below are the original main/SARIF locations, so later edits can move the lines. All 11 carried high security severity; none was critical. Alert numbers link to the repository's durable records.

| Alert / rule | Original location | Triage and disposition |
| --- | --- | --- |
| [#1](https://github.com/BEXAI/Curviai/security/code-scanning/1) `js/polynomial-redos` | `packages/ai/src/llm.ts:132` | Real quadratic parsing risk from provider text containing an unterminated fence and long whitespace. Shared candidate replaces the overlapping fence regex with linear fixed-delimiter searches. Await matching analysis. |
| [#2](https://github.com/BEXAI/Curviai/security/code-scanning/2) `js/polynomial-redos` | `packages/cli/src/client.ts:158` | Real quadratic trailing-slash trim, reached through locally supplied CLI/client base URL rather than an exposed server input. Shared candidate hardens it with a backwards character scan. Await matching analysis. |
| [#3](https://github.com/BEXAI/Curviai/security/code-scanning/3) `js/polynomial-redos` | `packages/pipeline/src/deterministic/original.ts:966` | Real risk in uploaded ICC description parsing. Shared candidate replaces both `desc` and `mluc` trailing-NUL regex trims with a linear scan. Await matching analysis. |
| [#4](https://github.com/BEXAI/Curviai/security/code-scanning/4) `js/polynomial-redos` | `packages/pipeline/src/planner/deterministic.ts:173` | Benign in this flow: line 166 first collapses every whitespace run to one space and trims it. The flagged expression cannot receive the overlapping long whitespace run; its parenthetical body excludes parentheses. |
| [#5](https://github.com/BEXAI/Curviai/security/code-scanning/5) `js/xss-through-dom` | `apps/web/src/components/app/brand-kit-form.tsx:210` | Selected `File` becomes a `URL.createObjectURL` blob URL used as an image `src`. It is not inserted as HTML or executed as a script. |
| [#6](https://github.com/BEXAI/Curviai/security/code-scanning/6) `js/bad-tag-filter` | `apps/web/src/components/ui/liquid-metal-hero.test.ts:26` | Private test-only `visibleText` helper extracts text for assertions; it is not an HTML sanitizer or production rendering path. |
| [#7](https://github.com/BEXAI/Curviai/security/code-scanning/7) `js/bad-tag-filter` | `apps/web/src/lib/billing/billing-render.test.ts:67` | Private test-only `textOf` helper feeds text assertions, with no production HTML sink. |
| [#8](https://github.com/BEXAI/Curviai/security/code-scanning/8) `js/bad-tag-filter` | `packages/pipeline/src/copy-lint.ts:13` | Typography/copy cleanup, including ASCII arrow text, feeds font-glyph/raster composition. It is not relied on to sanitize content for an HTML sink. |
| [#9](https://github.com/BEXAI/Curviai/security/code-scanning/9) `js/incomplete-sanitization` | `apps/web/src/lib/services/db-reveal.test.ts:117` | Replacement of a fixed `used.jpg` fixture appears only inside an expected test assertion; it is not a security boundary for external input. |
| [#10](https://github.com/BEXAI/Curviai/security/code-scanning/10) `js/insufficient-password-hash` | `apps/web/src/lib/api-keys/format.ts:45` | SHA-256 hashes server-generated bearer keys containing 32 cryptographically random bytes, not human passwords. The database backend also rejects the fixed demo-key prefix. |
| [#11](https://github.com/BEXAI/Curviai/security/code-scanning/11) `js/biased-cryptographic-random` | `apps/web/src/lib/shares/pick.ts:20` | The alphabet has exactly 32 symbols and bytes have 256 values. Each symbol has exactly eight byte preimages under modulo 32, so this mapping is unbiased. |

The full dependency audit also exposed development-tool advisories beyond the earlier production-only audit. Root updated Vitest to exact `4.1.11` and added the scoped `@esbuild-kit/core-utils>esbuild` override to exact `0.25.12`. `/tmp/curvi-final-all-audit.json` now records **zero advisories across 788 total dependencies** (all severity counts zero). This is an audit snapshot, not a claim that all code is secure. The scoped override passed six transform cases, DB source typechecking and 19 migration/snapshot/PGlite tests. Drizzle generation used copied schema/snapshots with an explicit credential-free temporary config and reported no schema changes; all 88 migration/snapshot files remained unchanged. Logs are under `/tmp/curvi-esbuild-offline-6fqHFx/`. Root owns final candidate validation and matching CodeQL readback.

Official advisory references checked 2026-10-02: [Vitest fixed versions and scope](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), [esbuild development-server advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99). Neither audit presence alone proves an exposed production exploit; these dependency updates remove the affected versions and passed compatibility checks.
