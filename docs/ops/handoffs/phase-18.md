# Phase 18 handoff, 2026-10-02

Target: `/tmp/curvi-phases-18-20`, branch `codex/complete-phases-18-20`. Original checkout untouched. Work is local implementation; no provider calls, real email, activation, migrations, commits or deployment were performed by this agent. Parent owns publication and combined gates.

## Implemented

- P18-07 signed feedback links from the same workspace owner's ID and email; signing failure suppresses the request. The individual feedback template is enabled; the global lifecycle default remains off.
- P18-24 referral reward receipt from the actual positive ledger grant, deduplicated per referral. No credit grant or referral activation added.
- P18-12 unticked marketing consent, original `File` handoff from checker/fixer, explicit upload action, and closed-gate fallback.
- P20-29 Turnstile preview/store audit server enforcement, action/hostname checks, token reset, partial-configuration refusal, and seeded stricter production fallback caps using existing counters. Shared Turnstile helper/widget belongs to customer agent.
- P18-17 offline heatmap and local benchmark manifest validation. Measures decoded shipped artifacts in aligned eroded masks; records file hashes and missing evidence. Always unpublished, no synthetic performance claims. No `/proof` page or real product benchmark fabricated.
- P20-16 pinned one-provider cutout trial through router caps/metering, durable probe/pass/reset/quota state, six-hour primary/daily backup/15-minute recovery cadence, free key probes, R2 put/get/delete round trip, all-family quota alerts, BFL numeric balance/low-credit alert, paused-stage timer. Cron and operator wrapper are disabled by default; existing tick integration and operator actions are owned by Phase 19/20 agents.
- P18-09/P20-42e jewelry deterministic scale reference and planner v4/v5 drafts. Original v1–3 system prompt hashes pinned; v4 changes only the jewelry phrase; v5 adds five marketplace names and channel IDs. Both drafts `active:false`, `trafficPct:0`; v3 remains seeded at 100. Version-specific semantic evaluation fixtures exercise source integrity, no hand scene, channel coverage, deterministic mains and Pinterest format.

## Owned paths

- Email: `packages/email/src/{due,facts,run}.ts`, tests for due/run/templates and template snapshots, `templates/{account,index}.ts`. Customer agent owns send/store helpers and verified email change.
- Preview: `apps/web/src/components/marketing/{free-preview-box,main-image-checker,white-background-fixer,store-image-audit,marketing-consent}.tsx`, `free-preview-box.test.ts`; `apps/web/src/lib/anonymous-spend{,.test}.ts`; preview full route/service, preview route/gate and store audit route/daily-cap plus focused tests; lifecycle cron route/test and web lifecycle-template test.
- Seed: growth email/deploy restart/benchmark policy in `packages/pipeline/src/seed/growth.ts` and growth-email test; canary/alert policy in `monitoring.ts`, barrel exports. Shared seed barrel has other agent edits.
- Benchmark: `packages/pipeline/src/qc/heatmap{,.test}.ts`, `packages/pipeline/eval/benchmark{,.test}.ts`, benchmark stage in `eval/run.ts`.
- Provider: `packages/ai/src/{router,breaker,probe}.ts`, router/probe tests and `adapters/bflFlux.ts`; `trigger/src/provider-canary{,.test}.ts`, `provider-quota.ts`, `provider-probes.ts`, provider-balance test and only the unified quota callback in shared `runtime.ts`; provider-canary package export. `apps/web/src/lib/provider-{canary,preflight}{,.test}.ts`, provider-canary cron route/test, health providers route/test.
- Planner: `packages/pipeline/src/seed/{recipes,seed.test}.ts`, `src/planner/deterministic{,.test}.ts`, `eval/live/{cases,harness}.ts`, `eval/live/planner-drafts.test.ts`.
- Documentation: current continuation in `docs/phases/PHASE_18.md`, this handoff. Phase 20 agent owns its acceptance matrix. Root owns verification source log.

## Validation observed

All used Node 22.23.3 from `/tmp/node-v22.23.3-darwin-arm64/bin`.

- Email package: 86 tests across 8 files; growth schedule: 7; focused web lifecycle/consent: 30; initial component: 2. Email typecheck passed.
- Turnstile/fallback cap/preview/audit: 51 tests across 6 files; focused lint passed.
- Benchmark/heatmap: 7 tests; with growth: 14 across 3 files; focused lint passed.
- Provider: AI router/probe/breaker 80 tests across 3 files; trigger canary/balance/probes/LLM/chaos 67 across 5 files, then expanded canary test file 11 tests passed; web preflight/health/cron/wrapper 29 across 4 files. Trigger typecheck and focused lint passed.
- Planner seed/deterministic/live harness/draft gates: 183 tests across 4 files. Pipeline typecheck and focused lint passed. Offline deterministic main eval passes 10/10 synthetic cases, mean CIEDE2000 0.3817; generated ignored report is `eval/output/report.json`. This is not live model evidence or the real benchmark. Invoked `node --import tsx eval/run.ts --stage main` because the `tsx` command's IPC pipe is sandbox-restricted.
- Combined web typecheck/full lint/unit/e2e and production checks remain parent-owned.

## Outstanding acceptance

Real permissioned product photos and measured two-shot benchmark artifacts, founder general-model comparisons, reviewed public `/proof`/search pages; jewelry live prompt-eval review and people visual inspection; production recipe comparison and approved 10/50/100 traffic canary; funded-key exhaustion/top-up recovery, real R2 permissions, actual founder alert delivery and deployed scheduler checks. No paid calls or live activation are authorized for this subtask. Global lifecycle, acquisition and canary gates were preserved. Verify the provider canary env only after approving its bounded spend.

## P20-22 completed locally

`monitoring.ts` now seeds `llmModelRetirements` with model ID, earliest date, date kind, official source, and checked date. The [official Anthropic deprecations table](https://platform.claude.com/docs/en/about-claude/model-deprecations), checked 2026-10-02, confirms Haiku 4.5's bound 2026-10-15, Sonnet 5's 2027-06-30 and Opus 5.5's 2027-09-22. Each is a not-sooner-than bound, not an announced shutdown. No production model is changed.

Active primary, fallback and escalation models, including active zero-weight rollback rows, receive `llm_model_retiring:<model>` warnings at 30 days and degraded severity at 14 days. The DB's actual active recipes are checked when available; the compiled seed is the fallback. Health's classification context carries only the explicitly informational retirement codes, preserving all other severity rules. The warning says to recheck the notice and evaluate, never asserts that a tentative bound means the provider is down.

`recipe-drift.ts` now reads `traffic_pct` and compares traffic and active state per present version, including inactive/rollback rows. Details carry key/version and both percentages or active states, with no prompt text. Missing inactive drafts do not warn because they cannot receive traffic. The fixed-date seed test verifies no active chain is already at its recorded bound, and retains the existing OpenAI 100-percent serving assertions.

Owned P22 additions: `packages/pipeline/src/seed/monitoring-retirements.test.ts`, metadata/helpers in `monitoring.ts` and barrel exports; `apps/web/src/lib/recipe-drift{,.test}.ts`; retirement-only hunks in `config-health.ts`, `health-status{,.test}.ts`, and the health route's classification context; new `config-health-retirements.test.ts`. Root owns the remaining shared health route tests, `docs/verification.md` and `docs/ops/ALERTS.md`.

Validation: pipeline seed 70 tests/2 files passed; web retirement/drift/severity/health route 58 tests/4 files passed; web and pipeline typechecks passed; focused lint passed. The expanded run's existing `config-health.test.ts` has one unrelated expected-list mismatch for three intentionally disabled cron entries (`r2-legacy-sweep`, `upstash-keepalive`, `provider-canary`); root is updating that registry expectation. No live DB write was made. Production drift acceptance and refreshing the dated source before future changes remain operations gates.

## Integration correction, 2026-10-02

Updated `trigger/src/claude-fallback.test.ts`'s explicit coverage list for `shot_planner` v4/v5. Its existing per-row adapter tests still exercise every OpenAI primary/fallback returning quota and the final Claude structured-tool response, including the inactive drafts. All 12 tests pass with mocked network. Re-ran seed and planner draft checks: 72 tests/2 files pass, including unchanged v1–3 prompt hashes, inactive zero-traffic v4/v5 and default v3 selection. Focused lint passes. No recipe or runtime change was needed. Integration marketing help/dashboard render failures belong to the customer agent and were routed there; the visitor-IP expectation belongs to the shared client-IP owner.

## Lifecycle retry correction, 2026-10-02

`apps/web/src/app/api/cron/lifecycle/route.ts` now sums failed/invalid counts from the actual per-template report, returns HTTP 503 with `ok:false` after partial failure, and leaves `cron_success:lifecycle` unchanged. Dry runs, switches, missing configuration, waiting templates and capped/rate-limited runs return an explicit `skipped` value without recording success. A completed run may contain deduplicated or suppressed recipients and still records success. The existing tick adapter already interprets failed/skipped responses correctly.

Route regressions cover partial failure followed by a completed retry, skip categories, and completed suppressed/deduplicated work: 15 tests pass. The real PGlite email-run regression delivers one of two recipients, fails the second, then retries only that recipient; the durable send log contains two sent rows with attempt counts one and two. Email run tests: 11 pass. Focused ESLint passes for both route files, email regression and store-audit e2e fixture; web typecheck passes before the dependency installation. No emails were sent outside mocked transports.

`e2e/store-audit.spec.ts` now asserts the current canonical demo request `{store, channel, captchaToken:""}`. The old build sent `turnstileToken:null`; customer code now uses `captchaToken`. Root's fresh build and full browser run will cover this fixture; this agent has not claimed a browser pass.

## Dependency advisory triage, 2026-10-02

Research only: root owns all manifests, lockfile changes and installation. `/tmp/curvi-prod-audit.json` reports six high and two moderate advisories; multiple advisories refer to the same packages. Narrow candidate pins are Drizzle 0.45.3, Sharp 0.35.5, ExifTool-vendored 35.19.0 and a PostCSS 8.5.28 override. The minimum patched versions below also cover the reported advisories. These are recommendations pending installation and regression checks, not a claim that this checkout is patched.

| Package | Current affected version | Security floor | Verified latest stable | Compatibility and exposure |
| --- | --- | --- | --- | --- |
| drizzle-orm | 0.44.7 | 0.45.2 | 0.45.3 | Identifier escaping fix. Reviewed dynamic identifier in `lib/ops/retention.ts` comes from fixed retention table rules; no untrusted identifier input found in the inspected calls. 0.45.3 adds a Netlify driver; the checked 0.45.2 package declares no Node engine constraint. |
| sharp | 0.34.5 | 0.35.4 | 0.35.5 | Highest direct exposure because Curvi decodes untrusted images. Node >=20.9.0, so Node 22.23.3 qualifies. 0.35 changes AVIF lossy tuning and default input channel limit, removes deprecated API options and install script. No removed options were found in app/pipeline calls. Ensure prebuilt platform dependencies are installed; rerun fidelity/image tests rather than relaxing limits. |
| exiftool-vendored | 28.8.0 | 35.19.0 | 38.3.0 | 35.19 requires Node >=20; latest 38.3 requires >=22. Use the smaller security jump first. Curvi uses fixed tag keys/options and UUID temp filenames, reducing the described newline argument-injection exposure; arbitrary tag values alone are not the reported vector. Major-version changes include unref streams by default, MWG metadata read default, task timeout and tag type changes. Curvi's `read`/`write`/`end` calls remain available but require metadata round-trip checks. |
| postcss | 8.4.31 through Next | 8.5.23 | 8.5.28 | Latest supports Node >=14 (also older alternatives). Reviewed use is trusted build CSS, with no request path accepting CSS found. Source-map file-read fixes require >=8.5.23. Other lock paths already use 8.5.28; an override to that patch avoids downgrading those. |

Primary evidence: [Drizzle security advisory](https://github.com/drizzle-team/drizzle-orm/security/advisories/GHSA-gpj5-g38j-94v9) and [0.45.3 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.3); [Sharp security advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c), [0.35 breaking changes](https://sharp.pixelplumbing.com/changelog/v0.35.0/) and [0.35.5 release](https://sharp.pixelplumbing.com/changelog/v0.35.5/); [ExifTool advisory](https://github.com/photostructure/exiftool-vendored.js/security/advisories/GHSA-cw26-7653-2rp5), [35.19 changelog](https://github.com/photostructure/exiftool-vendored.js/blob/35.19.0/CHANGELOG.md), [38.3 release](https://github.com/photostructure/exiftool-vendored.js/releases/tag/38.3.0); [PostCSS final source-map advisory](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp) and [8.5.28 release](https://github.com/postcss/postcss/releases/tag/8.5.28).

Upgrade gates: fresh production audit; DB transaction/query tests and typecheck; image ingest, composite, QC/fidelity, metadata round-trip and packager tests; offline main eval against the recorded 10/10 and mean CIEDE2000 0.3817 baseline; build and browser suite. The stricter image byte/colour assertions must remain intact. Node compatibility alone does not establish application compatibility. No dependency or package file was changed by this agent.

### Post-upgrade local checks

After root installed the exact recommended versions, this agent verified native runtime versions Node 22.23.3, Sharp 0.35.5, libvips 8.18.7, libheif 1.23.5 and ExifTool-vendored 35.19.0. Sharp reports JPEG, PNG, WebP, GIF and TIFF buffer decoders available. This check does not change Curvi's explicit HEIC/AVIF ingest refusal.

`pnpm --filter @curvi/pipeline exec vitest run src/metadata/iptc.test.ts`: 15/15 passed for JPEG/PNG/WebP metadata write/read/remove and preserved format/dimensions. `node --import tsx eval/run.ts --stage main` from `packages/pipeline`: 10/10 passed, mean CIEDE2000 0.3817, matching the reported pre-upgrade mean; all existing thresholds remain unchanged. The ignored local report is `eval/output/report.json`. These are synthetic deterministic checks, not permissioned real-product evidence or live prompt evaluation. Root/pipeline agent own the broad unit/type/browser checks.

After root confirmed the timing, ran `node --import tsx scripts/memory-test.ts --concurrency 2 --budget-mb 2048` from `apps/web` on the patched dependencies. Both packs completed with no failures and exit 0, within the explicit 2 GiB test budget. Observed peak RSS 1004.11 MiB, heap 46.73 MiB, external 383.53 MiB, 18 samples over 4 seconds. The fixture creates fresh provider buffers and exercises the real planner, worker, encoders, QC and packager. This is one local synthetic workload, not a claim about production p95 memory or real-provider latency. The earlier 512 MiB budget remains insufficient; no repeated test or threshold change obscures that result.
