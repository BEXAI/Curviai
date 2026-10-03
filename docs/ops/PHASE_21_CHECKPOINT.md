# Phase 21 implementation checkpoint

## Current policy and migration state (2026-10-03)

The user retired encrypted-backup planning and its release gates on 2026-10-03. No backup bucket, dump, age recipient, executor or restore drill is required for this rollout. Local disk/GitHub preserve code only; they do not restore live database rows, Auth state or stored objects. Existing backup data and unrelated security controls remain untouched.

Migrations **0045 and 0046 are applied and must not be replayed**. **0047, 0048 and 0049 remain UNAPPLIED**. The integrated release is reviewing an inert candidate handoff and a guarded atomic 0047–0049 transaction; neither a live writer fence nor SQL execution is established by that preparation. Required checks are the exact target/journal, compatible application and workers, isolation of every old writer, bounded transaction/postflight verification and explicit rollback or forward-repair limits. A momentary zero-job count is not writer isolation. Report irreversible data effects before executing them. See [MIGRATION_MAINTENANCE.md](MIGRATION_MAINTENANCE.md). Paid evaluation and dedicated reviewer identity/secure sign-in gates remain.

The checkpoint below is historical evidence from its stated 2026-10-02 times, including then-pending PR/security/access states. Use the current release evidence for those outcomes; do not treat these snapshots as new actions or repeat applied migrations.

Updated 2026-10-02 15:45 UTC. Resume this task after context recovery; inspect Git and active agents before duplicating work.

## Authority and current state

The latest delegated user request explicitly authorizes orchestrating implementation and deployment of all three proposals in `docs/phases/PHASE_21.md`, including optional owner budgets. The subsequent delegated request authorizes Phase 22 implementation, deployment and submission of the full Curvi ChatGPT plugin. Its earlier future proposals are preserved in Phase 23, which remains planning only. OpenAI approval remains an external decision. Credential creation, persistent OAuth access, disposable-account security probes, legal attestations and funded generation still need the specifically reserved approvals. Continue tested incremental publication, reviewed safe Supabase updates in `tmwvjmvzjvpeagatjmud`, exact-commit deployment proof and progress checks approximately every five minutes.

- Active checkout: `/tmp/curvi-phase-21`, branch `codex/phase21-seller-integrations`, based on PR #6 with privacy correction `1f855cc32ffd28213cb0505ec47c9ddeaeb2ac38`. Earlier head `fc44989f30e70d113873acb1dbca927d3b63fea0` passed hosted functional checks; the new head must repeat them.
- Original checkout: `/Users/nathaniel/Developer/Curviai`, clean main `b4893d19f6a715395f204d56a7e156a5001d8dd1` at the 15:04 UTC read-only check. Preserve user changes.
- PR #6: https://github.com/BEXAI/Curviai/pull/6. Its hosted CI https://github.com/BEXAI/Curviai/actions/runs/37017453942 passed, including PostgreSQL 17 races and 192 browser checks. A separate CodeQL PR gate remains blocked on seven reviewed alert dispositions.
- No alert has been dismissed. Automatic approval review rejected dismissal of alerts 4, 7, 11 and 18–21 because it persistently changes security monitoring without explicit permission. The user's approval question remains unanswered; Phase 21 authorization does not authorize dismissal or bypass. Dependent main merges stay gated.
- Last production proof: `https://curvi.ai/api/health`, healthy database/schema through 0044 and commit `dae0fb0a0e710b2afe3b6be01cddb40b5ad28bcc`. Recheck before claiming current deployment.
- Live Supabase is through 0044 with 45 journal entries. No Phase 21 migration has been applied.
- Node 22.23.3 at `/tmp/node-v22.23.3-darwin-arm64/bin`; pnpm 10.26.1. Frozen install with scripts disabled completed in `/tmp/curvi-phase21-install.log`.

## Active owners

| Agent | Scope |
|---|---|
| `p21_cases` | Customer and operator resolution case domain, routes, UI and focused tests. |
| `p21_budget` | Credit planning, optional owner limits, estimate/refusal integration and focused tests. |
| `p21_webhooks` | Private endpoint management, exact-byte signing, safe pinned transport, bounded worker and tests. |
| `p21_schema` | Exclusive schema, additive migrations, journal/snapshots, RLS and database concurrency tests. |
| `p21_review_docs` | Independent contract/security review, verified official references and planning-only Phase 22 proposals. |
| `p21_privacy_qa` | Explicit safe exports, bounded retention, privacy copy and focused browser acceptance. |
| Root | Policy decisions, shared integration, final review, Git/publication, live SQL and release evidence. |

All owners work in the same checkout. Coordinate shared-file edits before writing. No agent may read environment/secret files, create persistent credentials, trigger paid generation, send customer mail, transmit to arbitrary webhook endpoints, apply live SQL or bypass the PR #6 gate. Root alone publishes and applies frozen reviewed SQL.

## Next integration gate

Agree exact table/service contracts and accounting before integration. Separate logical pack run identity from rotating runner leases; cover terminal failure, cancellation, recovery and follow-up paths atomically. Validate budget accounting against existing raw charge/reserve/release ledger semantics and the workspace reservation lock. Then freeze migrations, run targeted RLS/concurrency and security checks, and integrate the three lanes. Record implementation evidence separately from live activation.

Lane handoffs belong in `docs/ops/handoffs/phase21-{cases,budget,webhooks,schema,review}.md`. Update this checkpoint as work freezes and release gates change; never claim implementation, migration, CI or deployment success without corresponding evidence.

## Integration progress at 15:17 UTC

All six agents are implementing or reviewing in the shared checkout. Additive migrations 0045 cases, 0046 credit budgets and 0047 completion webhooks are drafted and under test, not frozen or applied. Root added settings/operations discoverability, the abandoned-follow-up failure outcome, completion assertions in `db-follow-up-runs.test.ts`, and CI inclusion of `phase21-race.pg.test.ts`. CI check timeout increased from 20 to 30 minutes because the prerequisite took 18m41s before these added suites.

Independent review caught and owners corrected UTC month rollover under a non-UTC database session, Node 22 HTTPS lookup callback shape, client-written terminal metadata, and an ambiguous SQL trigger variable. Root follow-up integration passed 4 tests after the trigger fix (`/tmp/curvi-phase21-followup.log`), including cancellation, stale runner fencing and failed queue preparation. First integrated typecheck found only the HTTPS option type, which its owner has corrected; a clean full rerun remains required. Webhook owner reports 38 focused crypto/transport tests passing with no external requests. Treat lane counts as intermediate evidence until final root checks.

PR #6 remains open at the same exact head and security gate at the 15:13 UTC read-only check. Production remains healthy at `dae0fb0`, schema 0044. No Phase 21 commits have been published, no live migration has run, and no endpoint or secret has been created. Phase 22 now exists as three planning-only proposals. Next: finish database/route/browser fixtures, freeze and review SQL, run the full repository gates, then publish reviewable dependent batches while preserving the prerequisite block.


## Frozen integration and launch scope at 15:40 UTC

Phase 21 feature code and SQL are frozen. Full lint and types pass. The production build and all 195 browser tests pass. The first complete unit run exposed only a missing privacy field inventory and a retention fixture missing the frozen endpoint revision. Both are corrected; 56 focused tests pass. Full units/lint/types and rebuilt privacy/legal browser checks are running again, with logs `/tmp/curvi-phase21-{unit,lint,types}-final.log` and `/tmp/curvi-phase21-privacy-e2e-final.log`. No claim of the final all-green snapshot is made until these exit successfully.

The independent review has no unresolved high-severity finding. It also identified a prerequisite analytics privacy correction: disable automatic DOM capture and session recording, preserve explicitly consented events, and prevent late lazy initialization after consent withdrawal. Its six-file commit `1f855cc32ffd28213cb0505ec47c9ddeaeb2ac38` is published to PR #6. This neither dismisses alerts nor bypasses the separate CodeQL gate.

Frozen migrations and SHA-256 values:

- 0045 cases: `1906760bd9b890f72922bb3dc9a75ab58e82081a3637fc7384a922d953f45380`
- 0046 budgets: `7a90bfdeda33f6659d70f0b31ef89b7eb51ceab3d11276ac05a43091fb7d2983`
- 0047 webhooks: `04ee27e189d97771d98b091f35c8f6969dbcbd9a5fbae57274ff645c4533ccd8`

The exact read-only preflight, three transactional application wrappers, postflight and journal manifest are in `/tmp/curvi-phase21-migration-review`. Their local PGlite replay validation passed: all 48 journal records, eight new RLS tables, expected client grants/function denials, default-off budgets/endpoints and refused duplicate replay. PostgreSQL 17 concurrency remains required in hosted CI. Existing local PostgreSQL 14 cannot apply the pre-existing PostgreSQL 15+ migration and was stopped cleanly. Do not weaken that migration.

Live SQL remains unexecuted. No connected computer-use or Supabase tool is exposed; a read-only existing-browser attempt did not respond and was terminated. The browser/connector restoration question is pending. Do not infer permission to read credentials or use another account. Production at 15:36:37 UTC remains healthy at `dae0fb0`, schema 0044, idle runner. Original checkout is clean main `b4893d1`.

Phase 22 read-only owners: `p22_connection`, `p22_chat_assets`, `p22_submission`. Handoffs are `docs/ops/handoffs/phase22-*-readiness.md`; the submission owner fills `docs/phases/PHASE_22.md`. Existing Phase 19 code remains the base. Concrete UI and release-readiness gaps will be implemented in a separate checkout after the Phase 21 snapshot is saved. Actual OAuth, in-chat rendering/downloads, reviewer access and approval are not proven by local fixtures. Publishing identity, sample asset/test workspace, OAuth test-account permission and a funded-test ceiling have been requested together. The separate seven-alert approval remains unanswered.

## Recontextualization prompt

Continue the authorized Curvi release from `/tmp/curvi-phase-21` and its Git status, this checkpoint, Phase 21 handoffs and the latest Phase 22 plan. Preserve the original checkout. Poll active final test sessions/logs, publish reviewable Phase 21 commits, and require hosted PostgreSQL 17 races before live SQL. PR #6 now includes analytics correction `1f855cc`; recheck exact-head checks. Never dismiss alerts 4, 7, 11, 18, 19, 20 or 21 without the outstanding explicit approval, and never bypass the gate. Restore authorized browser access before Supabase operations. Continue Phase 22 with existing Phase 19 infrastructure, official OpenAI references, isolated UI/submission lanes and real ChatGPT acceptance. Phase 23 proposals remain planning only. Keep credentials out of chat/Git and report external approval honestly.


## Final local gate and publication at 15:45 UTC

Final full lint and typechecking exit zero. The complete unit suite passes **6,800 tests**, with 15 explicit skips: 14 real-PostgreSQL tests requiring the hosted test database, plus the unavailable-ffmpeg diagnostic (ffmpeg is available and its real tests run). The production build and all **195 browser tests** passed before the final privacy sentence; the rebuilt two affected suites then passed **all nine tests**. No source changed after this final correction. Gitleaks 8.30.1 scanned 1,758 source/doc files, excluding environment files, and found no leaks. Evidence: `/tmp/curvi-phase21-unit-final.log`, `-lint-final.log`, `-types-final.log`, `/tmp/curvi-phase21-e2e.log`, `/tmp/curvi-phase21-privacy-e2e-final.log`, `/tmp/curvi-phase21-gitleaks.log`.

Saved feature commits: `1004a93` database/contracts, then `72941b2` application/worker/privacy/browser implementation. The next commit records this final evidence. Root is publishing a dependent draft PR against `codex/phase18-20-release` so PostgreSQL 17 concurrency can run; publication is not a main merge, deployment or SQL execution. PR #6 head `1f855cc` has passing analysis/demo but its separate CodeQL gate still fails and full hosted CI remains running. No alert was dismissed. Public production at 15:44:36 UTC remains healthy at `dae0fb0`, schema0044.

Phase 22 implementation is isolated in `/tmp/curvi-phase-22`, branch `codex/phase22-chatgpt-launch`, starting at `72941b2`. Owners: viewer lifecycle (`p22_chat_assets`), authorized `show_pack` tool (`p22_connection`), strict submission package checks (`p22_submission`), browser fixtures (`p21_privacy_qa`), independent security/claims review (`p21_review_docs`). Its complete plan and three readiness handoffs exist there; Phase23 remains planning only. Parent has already surfaced the required identity/access/sample/spend questions. Do not duplicate them or treat general account approval as password/MFA mutation permission; those probes require exact action-time scope and secure credential entry.
