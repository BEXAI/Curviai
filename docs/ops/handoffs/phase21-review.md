# Phase 21 review handoff

Status: independent implementation/security review completed for the current candidate, 2026-10-02; integration and release gates below remain open. Workspace: `/tmp/curvi-phase-21`, branch `codex/phase21-seller-integrations`, prerequisite `fc44989f30e70d113873acb1dbca927d3b63fea0`.

## Review boundaries

The review lane owns this handoff and `docs/phases/PHASE_22.md`. Feature, migration, Git, live SQL and release actions stay with their assigned owners. No secrets, environment files, live provider calls, endpoint transmissions or alert dispositions were used for this review. Phase 22 is planning only and is separate from all findings below. The prerequisite PR 6 security disposition approval remains unresolved; this review does not change that gate.

## Design findings sent to owners

| Severity | Reference | Risk and required verification | Owner |
|---|---|---|---|
| High | `packages/db/migrations/0007_numeric_ledger_and_pack_files.sql:84` | A settled charge writes a positive release and negative charge together. Summing releases as returned credits overstates returns. Budget use must combine delivered charges with outstanding all-history holds once, including holds crossing the month boundary. Verify fractional units, failed/canceled runs, partial delivery, release replay and concurrent reservations. | Budget/schema |
| High | `packages/db/migrations/0007_numeric_ledger_and_pack_files.sql:22` | The replacement reservation function must retain client EXECUTE denial, workspace row locking and existing error semantics. Validate job ownership before changing job counters. Owner budget checks in a route alone cannot protect raw database writes. | Budget/schema |
| High | `packages/db/migrations/0001_rls_and_functions.sql:79` | Existing member policies permit generation-job mutations. A server-privileged terminal outbox trigger must not let authenticated PostgREST callers forge trusted terminal events or logical run IDs. Add explicit privilege and mutation tests. | Webhooks/schema |
| High | `apps/web/src/lib/jobs/recovery.ts:62` | Runner fencing keys can change during recovery of one logical run. They cannot alone be the stable delivery event identity. Use a separate immutable logical run identity and test recovery, restart, follow-up and terminal tombstoning. | Webhooks/schema |
| High | `trigger/src/follow-up.ts:227` | A failed follow-up can leave the aggregate pack status `done` because previous files remain usable. Terminal event outcome needs an explicit contract for follow-up failure, cancellation and abandonment. | Webhooks/schema |
| High | `apps/web/src/lib/support.ts:1` | Case creation and duplicate suppression must precede any notification. Customer projections must select public fields explicitly; private notes require separate client-denied storage. Test reporter/owner/admin versus another editor, another tenant and OAuth/PostgREST paths. | Cases/schema |
| High | New webhook transport, pending implementation | Verify every DNS answer and pin the vetted connection address, retain TLS hostname validation, block private/special addresses and redirects, and cap both connection and total duration plus headers/body. Revalidate endpoint revision before send so disable/rotation cannot use stale delivery claims. | Webhooks |

## Evidence and remaining review

Reviewed repository instructions, Phase 21 proposal requirements, existing ledger functions, support/grant interfaces, library/preflight/compliance contracts and terminal-path scout findings. Sent accounting and access-control risks directly to feature/schema owners. The cases owner confirmed case intake will persist before email and will not add compensation writes. The budget owner confirmed settled-release exclusion, all-history holds, UTC-month charges and owner-only writes under the workspace lock.

Two implementation issues were reproduced locally and sent to their owners:

- **High, migration 0046, `workspace_credit_budget_snapshot`:** adding `interval '1 month'` to a UTC-start `timestamptz` uses the session's calendar. In isolated PGlite with `TimeZone='America/New_York'`, March 1 at 00:00 UTC plus one month returned March 28 at 23:00 UTC. The month endpoint and consumption predicate must both use UTC calendar arithmetic. A non-UTC-session regression fixture is required.
- **High, `apps/web/src/lib/webhooks/transport.ts`, custom `lookup`:** Node 22.23.3 defaults `autoSelectFamily` to true. An isolated `https.request` fixture confirmed the lookup receives `{ hints: 1024, all: true }`; its callback needs an address array unless the pinned single-family transport explicitly opts out. The fixture stopped through a synthetic DNS error before any network connection. Pin `family` and disable `autoSelectFamily`, then cover the actual option contract.

The Phase 22 draft's 12 relative links were checked against the repository; all targets exist. No runtime tests are claimed for a planning document.

## Findings resolved in the reviewed candidate

| Severity | Final reference | Resolution reviewed |
|---|---|---|
| High | `packages/db/migrations/0046_workspace_credit_budgets.sql:40` | Month start and end are independently computed in the UTC calendar. Holds use all ledger history; monthly consumption uses charge rows; the app excludes charge-transfer releases from true returns. The owner setter shares the workspace lock with reservations and locks the current owner membership. |
| High | `packages/db/migrations/0047_pack_completion_webhooks.sql:79` | An invoker-context guard refuses raw client terminal/runner/logical-run mutation. Logical run IDs survive recovery fencing and change only when a completed job starts another accepted run. Terminal outcomes distinguish a failed follow-up from an available older pack. |
| High | `packages/db/migrations/0047_pack_completion_webhooks.sql:144` | A terminal transaction atomically persists the event and delivery fanout. Endpoint key-share locks protect deletion; a stored endpoint revision fences concurrent disable/reactivation. Sender no-key-update locks are compatible with pack completion. Real PostgreSQL race execution remains required below. |
| High | `apps/web/src/lib/webhooks/transport.ts:61` | The connection pins the vetted address family with automatic family selection disabled, retains original TLS hostname validation, checks all DNS answers, blocks private/special addresses and redirects, and bounds DNS/connect/response/total duration. Actual Node lookup shape is covered without opening a network socket. |
| High | `apps/web/src/lib/webhooks/worker.ts:33` | Statement/lock timeouts bound database waits. Claims, endpoint state/revision, fresh time, lease and batch deadline are checked before sending; a second deadline check follows optional master-key rewrapping. Stale revision deliveries are canceled, and explicit replay binds the current endpoint revision while retaining event identity. |
| High | `apps/web/src/components/app/pack-cases.tsx:62`, `apps/web/src/app/app/ops/cases/[id]/page.tsx:15`, `apps/web/src/components/app/webhooks-panel.tsx:19` | Private message and credential DOM is blocked/masked for analytics. Customer projections select public columns and never read notes; private reads/writes live in `lib/ops/cases.ts` behind operator/MFA entrypoints. |
| High | `apps/web/src/lib/analytics-init.ts:7`, `apps/web/src/components/analytics.tsx:34` | Global DOM autocapture and session recording are explicitly disabled on new and already-loaded SDK instances. Consented pageviews and explicit events remain. Deferred imports recheck the latest consent and effect lifetime, so a prior grant cannot initialize analytics after withdrawal or unmount. Existing API credential DOM also gains a privacy boundary. |

No unresolved high-severity implementation finding remains in these reviewed paths. This is a bounded source review and fixture result, not a claim that the phase is deployed or that every release gate has passed.

## Independently executed checks

| Check | Result |
|---|---|
| `credit-planning.test.ts`, `credit-budget-route.test.ts` | 2 files, 11 tests passed. |
| Case store, customer render, case route and support route before the operator module split | 4 files, 15 tests passed. The later operator checks below cover the split. |
| `phase21-database.test.ts` | 1 file, 15 tests passed, including roles/OAuth, ancestry, finite fractional budget validation, UTC bounds, atomic outbox and logical-run identity. |
| Webhook crypto, transport and store suites | 3 files, 45 tests passed. Receiver behavior uses fixtures; no actual endpoint was activated or contacted. |
| Analytics initialization/component and operator case store/MFA rendering | 4 files, 18 tests passed, including the deferred consent race and private-note masking. |
| `git diff --check` | Passed. |
| Full `pnpm typecheck` | Found one integration fixture error: `apps/web/src/lib/trust/export.test.ts:73` omitted required `endpointRevision`. Root corrected it to the fixture endpoint's revision; the source correction was reviewed. Root is running the full frozen-candidate typecheck with its other release checks. The earlier reviewer log is `/tmp/curvi-phase21-review-types.log` and is not a passing final result. |

The webhook owner additionally reported focused terminal/follow-up checks and is extending fresh-clock/revision tests. Those reports are not counted as independently executed checks above. Official transport/locking/privacy references and fetch methods are recorded in `docs/verification.md`.

## Remaining gates and operational limits

- Complete the root's full lint/typecheck/unit/build/browser checks on the final source. The export fixture correction is present. Browser accessibility and all hosted exact-commit checks remain separate from these focused tests.
- Run the new PostgreSQL 17 concurrency suites. The schema owner reports that local PostgreSQL 14 cannot apply historical migration 0027's security-invoker view and that Docker is unavailable; PGlite does not replace real concurrent-connection evidence. Keep the hosted PostgreSQL 17 gate enforced.
- Before live migration 0047, inspect `generation_jobs` size and allow a bounded lock/statement window: the random default for logical run IDs may rewrite the table. No destructive rollback or data deletion is proposed.
- The prerequisite PR 6 security dispositions are still pending explicit approval. Automatic approval review previously rejected dismissing seven CodeQL alerts because doing so changes persistent security-monitoring state without explicit authorization. No dismissal or bypass was performed here.
- Main merge/deployment proof, healthy live schema, monitoring, and actual receiver consent/activation remain root-owned. A signed local fixture is not a live receiver pilot. Phase 22 remains planning only.

Final source pass also checked cron ordering, bounded retention, owner/admin export projections, terminal outcome writes and the receiver runbook. The webhook task is the optional cron tail; case notes disappear with their case; customer exports omit notes, operator identity, signing material, URL paths and lease internals. No additional material finding was identified. This lane edited only this handoff, `docs/phases/PHASE_22.md` and `docs/verification.md`.
