# Phase 21 cases handoff

P21-01 implementation is ready for aggregate release checks. It is based on the shared `codex/phase21-seller-integrations` checkout. This lane made no Git, database, deployment, email or external provider mutations.

## Behavior

- `/app/jobs/[id]/cases` provides reporting, a seller-visible timeline, replies and explicit reopening. The pack page links to it. Optional shot references and delivered output file references stay within the pack; a file selection also attaches its shot reference.
- The reporting member and current workspace owners/admins can read and reply. Other editors and client seats cannot see that reporter's messages. Each member can still open their own case in a category without an existing open case.
- One open case exists per workspace, pack and category. Job-row locks and unique indexes serialize concurrent creates and reopens. Request IDs deduplicate creation and replies. Reusing a creation request ID for a different payload is refused.
- Authenticated pack submissions to `/api/support` create or find that same case before any email path. The form returns a case link. Other support requests preserve their existing email handling. Existing feedback by the reporter is linked automatically. This lane adds no notification stream.
- `/app/ops/cases` is the operator queue; its detail page separates public explanations from private notes. Every page/action calls the existing verified-operator/MFA gate. The operator service also checks the operator email allowlist. Public updates and private notes each receive a metadata-only audit row in the same transaction.
- Resolving a case performs no credit grant, refund, generation or asset release. Operator access includes a link to existing pack diagnostics. There is no compensation action or new compensation idempotency namespace.
- A seller or workspace manager explicitly reopens a resolved case within 30 days. Later issues require a new case. Reopening preserves history and cannot create a second open case in that category.
- Source availability uses the pack's stored shot source references and the existing source retention eligibility rules, including recent/running product work and published before-photo protection. An unrelated new upload does not make an expired original available. Cases never copy photos or extend retention.
- Customer case text and the whole operator case detail subtree carry `ph-no-capture ph-mask`, protecting messages from PostHog autocapture/session replay. Text is rendered as escaped React children.

## Ownership and integration

- Customer domain/store: `apps/web/src/lib/cases/`.
- Operator-only functions: `apps/web/src/lib/ops/cases.ts`. These were deliberately split out to preserve the repository's existing operator import boundary.
- Routes/components: customer `/api/jobs/[id]/cases`, reply route, pack help page, `pack-cases.tsx`, support route/form, operator case pages/actions.
- Policy: `packCasesPolicy` in `packages/pipeline/src/seed/cases.ts`; exported by seed index. Reopen 30 days, resolved retention 180 days, recent case page 50, timeline 100, operator queue 100, message cap 2,000 characters.
- Schema owner supplied migration `0045_pack_resolution_cases.sql` and the three corresponding Drizzle tables. That owner holds migration freeze, RLS, direct client privilege and SQL concurrency evidence.
- Privacy QA owns resolved-case retention, workspace export and browser acceptance. Exports must contain public case/event history only, never private notes. Workspace/job deletion cascades cases, events and notes; source/feedback removal can clear optional references.

## Verification

Latest focused run: **26 passed, 3 skipped** across eight files. The three skipped tests require `TEST_DATABASE_URL` and are explicitly covered by the real PostgreSQL CI job; they are not counted as passing.

```sh
pnpm --filter @curvi/web test \
  src/lib/ops/cases.test.ts \
  src/lib/ops/cases-race.pg.test.ts \
  'src/app/api/jobs/[id]/cases/route.test.ts' \
  src/app/api/support/route.test.ts \
  src/components/app/pack-cases.test.ts \
  src/lib/support.test.ts \
  src/lib/ops/boundary.test.ts \
  src/app/app/ops/cases/cases-access.test.ts
```

Evidence log: `/tmp/curvi-p21-cases-test.log`. Focused ESLint passed: `/tmp/curvi-p21-cases-lint.log`.

Tests cover app and raw authenticated-role isolation for another editor, reporter/owner visibility, client exclusion, cross-tenant references, duplicate intake/replies/resolution, no ledger changes, private-note exclusion, operator authorization before reads, analytics masking, escaping, timely explicit reopening, expired original sources despite newer uploads, pending source purge, exact variant/shot references, input caps, same-origin checks, sign-in, rate limits and support email preservation.

`src/lib/ops/cases-race.pg.test.ts` uses the actual application stores with separate PostgreSQL connections. It covers 20 parallel creates, repeated resolution with one audit/event and no ledger writes, and reopen-versus-create contention. Root added it to the hosted race command. The available local PostgreSQL 14 server cannot apply historical migration 0027's PostgreSQL 15+ `security_invoker` option; no migration was weakened to run it.

The latest web typecheck reported no case-lane errors, but was blocked by in-progress fixture errors in `trust/export.test.ts` (required webhook endpoint revision) and `webhooks/db-store.test.ts` (nonexistent workspace owner field). Their owners were informed. Root must run the final repository-wide typecheck, lint, test, production build/browser and hosted PostgreSQL 17 checks after all lanes freeze.

## Remaining boundaries

- The UI explicitly labels the latest 100 timeline entries and up to 50 recent cases; owners/admins can export full public history. The operator queue shows up to 100 open cases. General history pagination is not included in this slice.
- Browser and screen-reader/keyboard acceptance are owned by the shared Phase 21 browser suite. Actual operator login/MFA and pilot triage ownership are production acceptance, not proven by fixtures.
- No sender activation or customer email was performed. No live cases were created.
- PR 6's pre-existing CodeQL approval gate and dependent merge/deployment sequencing remain root-owned blockers. This lane did not change any alert disposition or bypass checks.
