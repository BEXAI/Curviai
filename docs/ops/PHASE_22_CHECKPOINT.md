# Phase 22 launch checkpoint

Updated 2026-10-02 16:16 UTC. Continue work, inspect Git/agents and read the latest parent instructions before duplicating a lane.

## User-selected recovery prompt

> Please include a concise orchestration checkpoint with your next milestone update: active/completed subagent workstreams, batches merged/pushed so far with commit and CI links (or why none yet), applied migrations, and the next integration gate. User asked whether I am actively monitoring; I am reviewing your progress and ensuring incremental delivery stays on track. Keep executing rather than pausing for this report. Preserve piecemeal tested main merges/pushes and live Supabase sync.

## Current authority and workspaces

Phase 22 implementation, deployment, official submission and publication are authorized. OpenAI alone controls approval. Reuse Phase 19 infrastructure and preserve Phase 21. The preceding proposals are saved in `docs/phases/PHASE_23.md`, planning only. The complete launch plan is `docs/phases/PHASE_22.md`.

- Active implementation: `/tmp/curvi-phase-22`, branch `codex/phase22-chatgpt-launch`, based on Phase21 `9d1d594cc4e829aad29baf007fd660b42b8c79f2`. Plan commit `d507bac`; reviewed source commit `55bbce4b7987eb145ae0ab62b98e852be49456b8` passes full local integration. Root is publishing the final evidence and dependent draft PR.
- Phase21 frozen checkout: `/tmp/curvi-phase-21`, branch `codex/phase21-seller-integrations`, PR [#8](https://github.com/BEXAI/Curviai/pull/8), draft stacked on PR6. DB commit `1004a93`, application commit `72941b2`, final evidence commit `9d1d594`. Hosted [CI](https://github.com/BEXAI/Curviai/actions/runs/37029265253) and [demo smoke](https://github.com/BEXAI/Curviai/actions/runs/37029265330) passed; browser job finished at16:14:03UTC.
- Phase18–20 prerequisite: `/tmp/curvi-feature-release`, PR [#6](https://github.com/BEXAI/Curviai/pull/6), head `1f855cc32ffd28213cb0505ec47c9ddeaeb2ac38`. [CI](https://github.com/BEXAI/Curviai/actions/runs/37028430633), analysis and demo smoke passed. The separate CodeQL PR gate fails.
- Original `/Users/nathaniel/Developer/Curviai` remains clean main `b4893d1`, rechecked at16:15UTC. Preserve it.
- Node22.23.3 `/tmp/node-v22.23.3-darwin-arm64/bin`, pnpm10.26.1. Phase22 frozen install completed with lifecycle scripts disabled. Offline cache missed an archive; authorized network restore passed.

## Completed proof and database state

Phase21 passes full lint/types and6,800 local unit tests. All14 real-PostgreSQL tests subsequently passed against hosted PostgreSQL17 with zero skips; the local ffmpeg-unavailability diagnostic skips because ffmpeg is installed. Full production build and195 local browser tests passed, then all9 affected rebuilt legal/assistant browser tests passed after the privacy disclosure correction. Hosted browser CI also passed. Source-only Gitleaks reports zero leaks across1,758 files. Full logs and exact SQL hashes are in the Phase21 checkpoint.

Production at16:15:52UTC is healthy at `dae0fb0`, expected/applied0044. Live Supabase last verified45 journal entries. No Phase21 migration has run. Reviewed preflight, exact transactional0045–0047 wrappers and postflight are prepared in `/tmp/curvi-phase21-migration-review`, with PGlite replay/hash/RLS validation passed. Hosted PG17 concurrency is now proved; authorized browser/connector access remains required. No computer-use or Supabase tool is currently exposed; prior read-only browser attempt timed out and was stopped.

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

1. Publish the frozen, fully checked Phase22 source and evidence as a dependent draft PR based on Phase21, then monitor its exact hosted SHA. All five implementation/review lanes are complete.
2. Monitor release CI while useful authorized work continues. Hosted Phase21 PG17 is green; live SQL still needs restored access. Do not merge around the failed prerequisite gate.
3. With real access/identity/spend answers, prepare precise settings and action-time sensitive steps, execute bounded live acceptance, record sanitized evidence, build/hash the actual reviewer ZIP, and submit through the official portal after required attestations.
4. Track actual portal status and feedback through approval/publication. No unattended monitoring is claimed without a successfully configured authorized task. Phase22 remains open through that external decision.


## 15:57 UTC integration checkpoint

Viewer source is frozen and independently reviewed after fixes for poll-generation, teardown and removed-image error races. Its61 focused tests, scoped lint and web types pass. Four browser journeys are prepared with passing static checks. Strict package tests pass92 cases; its real negative CLI check exits1 on missing tool snapshot, identity placeholders and recording and writes no ZIP. Current final rerun is owned by submission lane.

The independent review found an inherited annotation defect: MCP get/show/estimate could trigger stale-job settlement through DbService reads, including delivered-work charges and completion events. Connection owner is implementing explicit internal snapshot reads and DB-backed no-state-change tests, preserving scheduled/default recovery. This remains a blocking source finding until review and tests pass. Do not weaken read-only annotations or defer this as a future feature.

Release watcher`release_watch` now monitors CI37028430633 and37029265253 read-only and writes`/tmp/curvi-release-watch.md`. Both checks jobs were still running at15:56UTC. Production health at15:56:09UTC remains healthy on`dae0fb0`, schema0044. No live SQL, alert disposition, credential or generation occurred.


## 16:09 UTC frozen code and hosted database proof

All source lanes are frozen and independent review closes every code finding. MCP get/show/estimate now use explicit internal snapshot reads;150 focused checks prove no job/ledger/outbox mutation and preserve normal/scheduled recovery. Viewer61 and package93 focused checks pass (counts overlap). Whole-repository lint and types now pass; full units and production-build/browser run remain active in `/tmp/curvi-phase22-{unit,e2e}-final.log`. Sessions31714 (units) and20552 (e2e) belong to root. Gitleaks8.30.1 scanned1,770 source files (18.77MB), excluding environment files, and found no leaks. No source edits are authorized during these checks except necessary fixes owned through root.

PR6 functional [CI37028430633](https://github.com/BEXAI/Curviai/actions/runs/37028430633) is SUCCESS at exact1f855cc: checks,4 PostgreSQL17 races and192 browser tests. Its separate CodeQL gate still fails. PR8 checks passed and its [PG17 job110919173551](https://github.com/BEXAI/Curviai/actions/runs/37029265253/job/110919173551) ran all14 tests with zero skips. The watcher continues until PR8 browser completion. Reviewed SQL can proceed only once authorized browser/connector access is restored; tool discovery still exposes neither. No live0045–0047 SQL has run.

The seven security dispositions, publishing/legal identity, OAuth/test/reviewer scope, owned assets/workspace and funded-test ceiling remain unanswered. Do not repeat questions or treat silence as approval. The actual ChatGPT journey and submission remain unproved.

## 16:16 UTC final local proof

Source commit `55bbce4b7987eb145ae0ab62b98e852be49456b8` passes full lint and types, **6,842 unit tests**, the production build and **199 browser tests**, including all four new viewer journeys. Local unit skips are14 real-PostgreSQL tests and one ffmpeg-unavailability diagnostic because ffmpeg is installed. Phase22's hosted rerun is the next integration gate; Phase21's exact parent already passes all14 PG17 tests. Logs: `/tmp/curvi-phase22-{lint,types,unit,e2e}-final.log`. The source scan reports zero leaks in1,770 files; `git diff --check` passes. Independent review closes all five findings, including the inherited MCP read-only settlement bug.

The real strict CLI refuses absent publishing identity, recording and current tools snapshot, exits1 and creates no output directory. Fixture packages are not reviewer deliverables. No actual ChatGPT evidence, final submission ZIP, portal submission, approval, publication or live database update is claimed.
