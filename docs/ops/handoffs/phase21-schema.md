# Phase 21 database handoff

Current rollout update, 2026-10-03: The user retired encrypted-backup planning and its release gates on 2026-10-03. No backup bucket, dump, age recipient, executor or restore drill is required for this rollout. Local disk/GitHub preserve code only; they do not restore live database rows, Auth state or stored objects. Existing backup data and unrelated security controls remain untouched.

Migrations **0045 and 0046 are applied and must not be replayed**. **0047, 0048 and 0049 remain UNAPPLIED**. The integrated release is reviewing an inert candidate handoff and a guarded atomic 0047–0049 transaction; neither a live writer fence nor SQL execution is established by that preparation. Required checks are the exact target/journal, compatible application and workers, isolation of every old writer, bounded transaction/postflight verification and explicit rollback or forward-repair limits. A momentary zero-job count is not writer isolation. Report irreversible data effects before executing them. See [MIGRATION_MAINTENANCE.md](../MIGRATION_MAINTENANCE.md). The original schema-owner status and local evidence below are historical; live 0045/0046 proof is in [the staging handoff](phase22-live-staging.md).

Status: SQL candidates frozen after implementation, local checks and independent security review (no additional high-severity issue). PostgreSQL 17 hosted concurrency proof remains a release gate. No SQL in this handoff has been applied to a live database by the schema owner. Existing migrations through 0044 are unchanged.

## Additive migration candidates

| Migration | Journal timestamp | SHA256 |
|---|---:|---|
| `0045_pack_resolution_cases` | 1790953680011 | `1906760bd9b890f72922bb3dc9a75ab58e82081a3637fc7384a922d953f45380` |
| `0046_workspace_credit_budgets` | 1790953746470 | `7a90bfdeda33f6659d70f0b31ef89b7eb51ceab3d11276ac05a43091fb7d2983` |
| `0047_pack_completion_webhooks` | 1790954316167 | `04ee27e189d97771d98b091f35c8f6969dbcbd9a5fbae57274ff645c4533ccd8` |

Drizzle generated snapshots 0045–0047 and journal entries match `schema.ts`. A subsequent generation with an explicit nonsecret temporary configuration reported no changes. The final snapshot contains 51 tables. No default Drizzle configuration or credential file was read.

## Contracts and ownership

`pack_cases` keeps immutable workspace/job/reporter/category/request and optional shot/output/feedback context. An output reference is `asset_variants.id`; its parent asset must match the job/workspace and selected `qc.shotId`. A shot must exist in job steps or asset QC. A deleted output/feedback clears only the reference. Case history is append-only; `(workspace, job, category)` has at most one nonresolved case. Request IDs are unique per workspace/reporter. Public events have their own case/request idempotency key. Notes are a separate server-only table. Reporting members and workspace owners/admins can select cases/events; other teammates cannot.

`workspace_credit_budgets` is disabled when absent or its limit is null. Zero pauses new reservations. `set_workspace_credit_budget(ws, actor, monthly_limit)` locks the workspace and owner membership, enforces finite nonnegative tenths up to the seeded maximum, and writes an audit only for a changed setting. Client roles cannot execute it. `workspace_credit_budget_snapshot(ws)` reports exact UTC calendar month start/end, current-month raw charges, all-period outstanding reserve/release holds, and nonnegative headroom. Refunds, grants and topups do not erase consumed budget. `reserve_credits` retains the existing workspace lock and credit balance check, validates tenant/job consistency, and refuses new work with SQLSTATE `CU429` when consumption plus holds plus the request exceeds the ceiling. Charge/release settlement remains permitted after a lower limit and across rollover. SQLSTATE `CU402` remains the distinct insufficient balance result.

`generation_jobs.logical_run_id` identifies a logical run independently from rotating runner fencing keys. Every terminal-to-active transition creates a new ID and clears the outcome; active recovery preserves it. Terminal outcomes default from job status but can explicitly be failed/canceled while an older delivered pack leaves `status=done`. Events include both `outcome` and `pack_status`. An invoker trigger protects job status, run key, logical identity/outcome and parent consistency from raw client writes. Queued client inserts remain compatible with existing policies.

An atomic terminal trigger inserts one immutable `pack_completion_events` row per job/logical run and deliveries for enabled, verified, nonrevoked endpoints. Historical terminal jobs are not backfilled. Endpoint fanout locks rows `FOR KEY SHARE` in ID order, compatible with sender/management `FOR NO KEY UPDATE`, so a slow receiver does not hold the terminal commit. Deletion takes an incompatible lock. Each delivery captures `endpoint_revision`; activation/verification/revocation/key-ID changes advance it. Ciphertext-only rewrapping preserves it. Worker claim/send/cleanup must reject stale revisions; explicit replay may adopt the current revision. Disabling/revoking immediately cancels currently visible pending/leased deliveries and clears their leases.

All eight new tables have RLS, restrictive `no_oauth_clients`, explicit anon/authenticated write revokes, and service-role grants. Cases/events and budget/audit permit scoped authenticated reads. Notes, endpoints, events and delivery internals have no client reads. No endpoint, persistent credential, owner limit, paid resource or outbound delivery is created by these migrations.

## Retention and rollout

- Resolved cases expire after 180 days; events and private notes cascade. Deleting a workspace/job cascades the case. Source media lifetime is never extended. Customer exports exclude operator notes.
- Budget audit expires after 365 days. Current preferences remain until workspace deletion. Workspace deletion cascades both tables.
- Completion events and dependent deliveries expire after 30 days. Delivery attempts expire after 72 hours. Endpoint deletion cancels/removes dependent deliveries; workspace deletion cascades all endpoint/event/delivery records. Customer exports exclude signing ciphertext and private destination internals.
- 0045 and 0046 are already applied; preserve their journal entries and never replay them. Review unapplied 0047–0049 in journal order using the coordinated maintenance sequence and exact preflight/postflight evidence. Budgets remain disabled; no receiver activation is implied.
- `logical_run_id DEFAULT gen_random_uuid() NOT NULL` can rewrite `generation_jobs` under an exclusive table lock. Preflight row count/table size and use bounded lock and statement timeouts. Do not label this change lock-free.
- Before commit, transaction rollback restores the prior schema. After commit, prefer app rollback with additive tables/columns retained, budgets disabled, and webhook worker/endpoint activation off. Do not drop customer case/audit/outbox data or rewrite an applied migration. Any urgent SQL correction should be an additional reviewed migration.

## Evidence

- `pnpm --filter @curvi/db exec vitest run`: **335 passed, 9 skipped**, 41 passing files. Skips are 2 existing ledger race tests and 7 new PostgreSQL race tests when `TEST_DATABASE_URL` is absent. Log `/tmp/curvi-phase21-db-all.log`.
- New `phase21-database.test.ts`: **15 passed**. Tests cover tenant/reporter/manager/OAuth isolation, private-note withholding, case uniqueness and parent immutability, output deletion, raw client mutation denial, ledger reconciliation, prior-period holds, repeated releases/charges, lowered limits, finite amounts, UTC session independence, atomic rollback, stable logical runs, retained pack versus run outcome, forged terminal events, endpoint disable and cascades. A separate pre-blanket-grant fixture checks actual SQL privileges on all eight tables.
- `pnpm --filter @curvi/db typecheck`: passed. Changed DB-file ESLint with `--fix`: passed. `git diff --check`: passed.
- `phase21-race.pg.test.ts` adds 7 true PostgreSQL tests: concurrent ceiling admission; lower-limit/settlement/repeated release; open-case uniqueness; terminal/outbox uniqueness and concurrent claim; nonblocking sender lock; concurrent endpoint delete; disable/re-enable stale revision. Root added the file to CI and serializes file setup so cluster-role creation cannot race across suites.
- Local PostgreSQL 14.18 binaries were already available. A scratch localhost-only server was started and stopped; its run failed before reaching Phase 21 because existing migration 0027 requires PostgreSQL 15+ `security_invoker` views. No migration was weakened to make it pass. Docker daemon was unavailable. **No local true-concurrency pass is claimed. Hosted PostgreSQL 17 proof remains required.** Log `/tmp/curvi-phase21-db-race-pg14.log`.

Official PostgreSQL 17 documentation checked 2026-10-02: [row lock compatibility](https://www.postgresql.org/docs/17/explicit-locking.html), [function snapshot behavior](https://www.postgresql.org/docs/17/xfunc-volatility.html), [ALTER TABLE defaults and locks](https://www.postgresql.org/docs/17/sql-altertable.html). The independent review lane owns the shared verification log.
