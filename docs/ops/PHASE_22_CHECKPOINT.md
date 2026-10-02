# Phase 22 launch checkpoint

Updated 2026-10-02 15:48 UTC. Continue work, inspect Git/agents and read the latest parent instructions before duplicating a lane.

## User-selected recovery prompt

> Please include a concise orchestration checkpoint with your next milestone update: active/completed subagent workstreams, batches merged/pushed so far with commit and CI links (or why none yet), applied migrations, and the next integration gate. User asked whether I am actively monitoring; I am reviewing your progress and ensuring incremental delivery stays on track. Keep executing rather than pausing for this report. Preserve piecemeal tested main merges/pushes and live Supabase sync.

## Current authority and workspaces

Phase 22 implementation, deployment, official submission and publication are authorized. OpenAI alone controls approval. Reuse Phase 19 infrastructure and preserve Phase 21. The preceding proposals are saved in `docs/phases/PHASE_23.md`, planning only. The complete launch plan is `docs/phases/PHASE_22.md`.

- Active implementation: `/tmp/curvi-phase-22`, branch `codex/phase22-chatgpt-launch`, based on Phase21 `9d1d594cc4e829aad29baf007fd660b42b8c79f2`. Phase22 source edits are in progress and not yet validated as an integrated snapshot.
- Phase21 frozen checkout: `/tmp/curvi-phase-21`, branch `codex/phase21-seller-integrations`, PR [#8](https://github.com/BEXAI/Curviai/pull/8), draft stacked on PR6. DB commit`1004a93`, application commit`72941b2`, final evidence commit`9d1d594`. Hosted [CI](https://github.com/BEXAI/Curviai/actions/runs/37029265253) and [demo smoke](https://github.com/BEXAI/Curviai/actions/runs/37029265330) are running.
- Phase18–20 prerequisite: `/tmp/curvi-feature-release`, PR [#6](https://github.com/BEXAI/Curviai/pull/6), head`1f855cc32ffd28213cb0505ec47c9ddeaeb2ac38`. [CI](https://github.com/BEXAI/Curviai/actions/runs/37028430633) is running; analysis and demo smoke passed. The separate CodeQL PR gate fails.
- Original `/Users/nathaniel/Developer/Curviai` remains clean main`b4893d1` at the last read. Preserve it.
- Node22.23.3 `/tmp/node-v22.23.3-darwin-arm64/bin`, pnpm10.26.1. Phase22 frozen install completed with lifecycle scripts disabled. Offline cache missed an archive; authorized network restore passed.

## Completed proof and database state

Phase21 passes full lint/types and6,800 unit tests. Fourteen real-PostgreSQL tests await hosted PostgreSQL17; the ffmpeg-unavailability diagnostic also skips because ffmpeg is installed. Full production build and195 browser tests passed, then all9 affected rebuilt legal/assistant browser tests passed after the privacy disclosure correction. Source-only Gitleaks reports zero leaks across1,758 files. Full logs and exact SQL hashes are in the Phase21 checkpoint.

Production at15:44:36UTC is healthy at`dae0fb0`, expected/applied0044. Live Supabase has45 journal entries. No Phase21 migration has run. Reviewed preflight, exact transactional0045–0047 wrappers and postflight are prepared in `/tmp/curvi-phase21-migration-review`, with PGlite replay/hash/RLS validation passed. Hosted PG17 concurrency and restored authorized browser/connector access remain required. No computer-use or Supabase tool is currently exposed; prior read-only browser attempt timed out and was stopped.

## Exclusive owners

| Agent | Files and scope |
| --- | --- |
| p22_chat_assets | `mcp-ui/pack-viewer/**`, `mcp-viewer.test.ts`: enable versioned viewer, refresh/restore, partial terminal assets, checks/fidelity and accessibility. |
| p22_connection | `api-v1/mcp-tools.ts`, relevant descriptor/OAuth/rate tests, one `rate-limit.ts` mapping: model-only read-only`show_pack`; `get_pack` remains app/model data-only. |
| p22_submission | `packages/openai-plugin/**`: strict final-submission mode, identity/recording/descriptor/screenshot checks while preserving draft builds. |
| p21_privacy_qa | New`e2e/phase22.spec.ts`: actual local MCP HTML in fixture sandbox host, bridge/actions/mobile/keyboard/refresh/partials. This is not live ChatGPT proof. |
| p21_review_docs | Read-only independent tenant/spend/links/CSP/async-race and submission-claim review; own handoff only. |
| Root | Shared integration, verification log/checkpoint, all Git/publication/live SQL, exclusive full builds/server and release evidence. |

Agents use fixture tests, never paid providers or arbitrary external receivers. No agent reads env/secret files or creates credentials. Root coordinates shared-file changes; all source lives in the Phase22 checkout, not the Phase21 frozen one.

## Pending approvals and live requirements

Parent already surfaced exact OpenAI organization/project, verified publishing identity and approved public legal details, dedicated test/reviewer account plus OAuth setup, owned sample assets/workspace and numeric spend/credit ceiling. Do not ask the bundle again. General test-account approval is not permission for password changes or MFA enrollment/removal: any such containment probe needs its exact action-time scope, disposable account, recovery and secure user-entry flow. Secrets never enter chat, Git or evidence. Legal attestations require their actual text at action time.

No security alert has been dismissed. Automatic approval review rejected persistent dismissal of alerts4,7,11,18,19,20,21 because it changes security-monitoring visibility without explicit permission. That unanswered approval is separate from implementation authority. Do not change scanners/protection or bypass a failed gate.

Actual OAuth, ChatGPT attachments/rendering/downloads, screening recipe evaluation/activation, reviewer access, submission and approval are not proved. The public OAuth discovery/support/sample-image404s reflect the undeployed prerequisite. Keep claims accurate, gather real host proof once access is authorized, and retain the documented external-IdP fallback if Supabase token containment fails.

## Next gates

1. Finish the isolated source lanes and independent review, then root runs full lint/types/unit/production-build/browser checks, source scan and reviewed strict package fixtures.
2. Monitor PR6/PR8 at roughly five-minute intervals while useful implementation continues. Require hosted PG17 before live SQL; do not merge around the failed prerequisite gate.
3. With real access/identity/spend answers, prepare precise settings and action-time sensitive steps, execute bounded live acceptance, record sanitized evidence, build/hash the actual reviewer ZIP, and submit through the official portal after required attestations.
4. Track actual portal status and feedback through approval/publication. No unattended monitoring is claimed without a successfully configured authorized task. Phase22 remains open through that external decision.
