# Pipeline, recovery and release handoff

Updated 2026-10-03: the user retired encrypted-backup planning and its release gates. Local disk and GitHub preserve source code, not live database rows, Auth state or stored objects. No database recovery capability is claimed. Existing backup data and security controls remain untouched; no backup service, key or credential is to be provisioned under this plan. Historical implementation and test evidence below remains dated evidence, not an active backup requirement.

Local implementation in `/tmp/curvi-phases-18-20`, verified on Node 22.23.3. No provider generation, production migration, release command, configuration write or paid call was made by this lane.

## Delivered

- **P20-18:** removed Trigger.dev task/SDK entrypoints. Pack and followup enqueue always use the inline runner. Shared email transport types/constants have their own module; the old digest sender is gone.
- **P20-32/33:** stable process owner, separate 60-second running heartbeat, heartbeat/run-key/owner fences, persisted first-run payload in the job/hold transaction, one-owner restart pickup, one restart within the seeded 60-minute window. Crash recovery restores never-started original runs and prepared waiting followups; running crashes settle and release. Followup payload preparation happens under an existing hold: a crash before its payload is persisted safely settles/releases instead of retrying. Boot recovery starts after 15 seconds and repeats every 120 seconds. Stale local settle and queued heartbeat cannot touch a replacement run key. Failed runs retain payload for the audited operator requeue action.
- **P20-33 COGS:** durable per-run cumulative counters turn reports into additive positive deltas. Repeated/out-of-order reports cannot double count. Late reports from fenced runs count spend without altering new run status. Followup base cost is excluded from its delta. A hard kill before a cost report can still leave job COGS behind provider reservations; the persistent spend counters remain the spending guard.
- **P20-34:** admission pauses additional packs at the seeded RSS ratio while allowing one to make progress. Offline memory harness exercises the planner, runner, image buffers, QC, encoders and packager using independent local provider fixtures and the production Sharp memory policy.
- **P20-35 P1:** tenant-checked job views expose global queue position and median duration ETA (last 50 complete jobs, seeded 240-second fallback), never another workspace's identity. Priority/fairness remains untriggered P2.
- **P20-37:** production caps live in the seed and are injected into SpendCaps. Operator USD stop overrides the environment then seed; zero is valid. Workspace daily reservations cover LLM, preflight, palette, generated image and cutout calls. Every tier has a seeded daily expectation. createJob refuses capped work before any product/job/hold write. Anonymous preview retains its own pre-signup budget and does not query a UUID workspace for `preview`.
- **P20-41:** eligible delivered lifestyle scenes regenerate through the same composite/fidelity pipeline, using an available source and cutout cache. The next `.vN` is unpicked, keeps the prior version, gets a fresh hold and charges delivered output only. Missing sources and version cap refuse before a hold. Followup pricing is seeded (free regenerations default zero).
- **P20-42a/d:** empty paid plans and isolated carousel retries refuse. P42b/c pack ZIP/report changes and per-file QC persistence were completed by the billing lane; file fidelity reads the exact stored variant report, with no shot-level metric fallback.
- **P20-59 P1:** tenant-scoped member email join and deterministic oldest-owned/oldest-member default workspace. Shared library limits now read the seed.
- **P20-12/19:** guarded migration/release pure libraries, founder CLIs and offline failure-path tests. Root owns aliases/env documentation and the protected fresh health details endpoint.

## Commands and target contract

`pnpm ops:migrate --env prod [--seed]` requires `OPS_SITE_URL`, `DATABASE_URL`, `CRON_SECRET`. The encrypted-backup prerequisite and trigger were retired on 2026-10-03. Review migration-specific data effects, compatible app/workers, writer isolation and reversibility. It runs the existing Drizzle migrator, verifies exact database bookkeeping, and requires current health. Seed mode prints recipe hashes/model drift and primitive switch drift before seeding; no operator email or prompt bodies are printed.

`pnpm release --env prod [--staging-smoke] [--disable-auto-deploy]` requires `OPS_SITE_URL`, `CRON_SECRET`, `OPS_RELEASE_TOKEN`, `OPS_RELEASE_EMAIL`, `RENDER_API_KEY`, `RENDER_SERVICE_ID`. It requires a clean pushed SHA with a successful latest push CI run, a matching fresh applied migration timestamp, optional same-SHA staging smoke, a 30-second pause cache wait and a global idle count. It preserves the existing auto-deploy policy by default (the latest user instruction supersedes the old P20-19 default); the explicit `--disable-auto-deploy` option leaves it off. It deploys the exact commit, validates Render's full SHA and application's SHA, schema, providers and public pages, then creates a local release tag. No tag push. Failure offers rollback to the captured prior live deploy only after explicit confirmation. Every pause-write attempt has a clear in finally; SIGINT/SIGTERM abort waits and clear. Long builds refresh the expiring pause. If a clear request itself cannot reach the app, the server's seeded 30-minute expiry remains the backstop.

Both require explicit `--env prod|staging`. Staging uses `STAGING_` counterparts for every target variable, with no production fallback. CLI scripts read shell values only, never env files. Operator API calls refuse redirects and never print credentials or child-command output. Public smoke visits only `/`, `/pricing`, `/help`, `/api/health`.

The release guard requires authenticated `health.details.release = { appliedWhen, runningPacks, checkedAt }`, with a fresh timestamp (at most 60 seconds old). The public cached migration tag and per-process pack count cannot establish migration/drain safety across deployments. First installation of that endpoint requires the separately authorized root deployment. No live CLI acceptance has been run. With auto deploy enabled, a main push can already start a deployment before this manual drain begins; the manual command cannot protect a deployment that Render already started.

Migration policy lint checks every SQL migration after immutable baseline **0044**, without rewriting frozen hashes. DROP, RENAME, ALTER TYPE and platform_settings UPDATE/DELETE require a statement-specific `-- contract:` comment. Dynamic DDL is checked conservatively as part of its DO statement. Historical 0043/0044 restrictive policy replacements remain unchanged.

Historical 2026-10-02 API research: Render's backup trigger cancels active runs. That trigger is retired from the current migration flow; this record is not a setup instruction. Official API shapes checked 2026-10-02: [service update](https://api-docs.render.com/reference/update-service), [create deploy](https://api-docs.render.com/reference/create-deploy), [rollback](https://api-docs.render.com/reference/rollback-deploy), [cron trigger](https://api-docs.render.com/reference/run-cron-job), [events](https://api-docs.render.com/reference/list-events), [OpenAPI schema](https://api-docs.render.com/openapi/render-public-api-1.json).

## Evidence

All commands use `PATH=/tmp/node-v22.23.3-darwin-arm64/bin:$PATH` locally.

| Check | Result |
| --- | --- |
| AI caps/router/async jobs | 94 tests passed |
| Trigger spend/followup/free-preview batch | 44 tests passed |
| Initial service/restart/enqueue/inline/recovery/file-fidelity batch | 107 tests passed |
| Initial trigger DB store/followup/run-key/digest batch | 41 tests passed |
| Latest recovery/enqueue/DB shot operations | 40 tests passed (4/17/19) |
| Guarded release/migrate/queue estimate | 24 tests passed (16/7/1) |
| Migration policy | 8 tests passed |
| Billing lane runtime regenerate/report test | 17 followup + 15 DB store tests passed (lane-reported) |
| Full workspace TypeScript and scoped ESLint | passed; integration TypeScript log below |

Real offline Everything bundles with ads and four variations, shot concurrency 2, sampling every 200ms:

| Pack concurrency | Finished | Peak RSS MiB | Heap MiB | External MiB | Time | Budget result |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | 2 | 1012.20 | 44.17 | 345.67 | 9s | 2048 MiB passed |
| 1 | 1 | 724.66 | 46.36 | 239.11 | 6s | 512 MiB failed |

Commands: `pnpm ops:memory-test --concurrency 2 --budget-mb 2048` and `pnpm ops:memory-test --concurrency 1 --budget-mb 512`. Logs: `/tmp/curvi-memory-final-2.log`, `/tmp/curvi-memory-final-1.log`. These are local macOS fixture measurements, not container production acceptance. **512 MiB is unsuitable for this measured workload even at concurrency 1.** The intended 2 GiB/concurrency 2 profile still needs staging observation with Next.js, real provider latency and deployment overlap.

## Remaining gates

- Root integration validation: full lint/typecheck/test/e2e, actual authorized deployment and fresh protected health.
- Staging crash/drain and migration/release acceptance; no destructive drill in production.
- P20-36 shared Postgres breaker, P35 priority/fairness, P64 intermediate checkpoints and P65 target-product, encoded-white and scene-count fixes remain gated P2 (golden photos and funded provider evaluation required). No flags enabled for them.
- P20-47 workspace-cap signal query is owned by the cron lane; use `spend_cap_counters` key `caps:workspace:<uuid>:<UTC YYYY-MM-DD>` and compare total_micros with `costCaps.workspaceExpectedDailyMicrosByTier[tier] * costCaps.workspaceDailyMultiplier`.

## Integration followup

`pnpm typecheck` exited 0 (`/tmp/curvi-integration-types.log`). The first recursive test run passed all pre-worker packages, including AI 284, DB 320 (+2 skipped), pipeline 982; Trigger had 667 passing tests and two stale expectations. Both were fixed: the tmp carousel key (5 focused tests pass), and inactive shot-planner v4/v5 coverage (12 focused tests pass, recipe lane). The independent first web run had 3965 passing, 21 failing, 2 skipped; failures were routed to their owning lanes.

This lane fixed the worker tmp assertion, preflight tmp assertions, the obsolete Trigger-key pickup expectation, and Sentry runtime mocks for the new database owner claim. Its 28-test backend integration batch passes, including a regression proving a real claim failure is reported without calling a provider. No real database error was swallowed. The recursive rerun at `/tmp/curvi-integration-tests.log` passed all non-web packages: **2,564 tests**, including all **669 Trigger tests**. It reached four new documentation/route web failures, all corrected by their owners. The final independent full web suite (`/tmp/curvi-integration-web-tests-final.log`) exited **0**, with **388 passing files, 4,033 passing tests and 2 skipped tests**. Across the verified package suites this is **6,597 passing tests and 5 skipped tests**. The final full `pnpm typecheck` also exited **0** after the latest shared changes. Scoped backend ESLint and diff whitespace checks pass. The first-run log remains at `/tmp/curvi-integration-tests-first.log`; `/tmp/curvi-integration-web-tests.log` preserves the initial web failures. No claim is made that the earlier recursive command itself exited zero; its remaining package was verified by the final full web rerun.

## Security dependency upgrade verification

After installing Drizzle 0.45.3, Sharp 0.35.5, ExifTool 35.19.0 and the PostCSS 8.5.28 override, the full recursive `pnpm test` exited **0**: **6,598 passed and 5 skipped**, including pipeline 985, worker 669 and web 4,033 passing tests. Full `pnpm typecheck` exited **0**. The upgrade required replacing nine Sharp namespace type references with named type imports across six pipeline files; runtime image operations are unchanged. Scoped ESLint and `git diff --check` passed.

The first upgraded run's isolated 80 MP memory subprocess measured 388.20 MiB added RSS against the unchanged 384 MiB budget and failed. An isolated retry measured 346.95 MiB, and the final full suite measured 342.52 MiB; both passed. No test threshold, image behavior or memory policy was loosened. This variance remains relevant when interpreting local RSS measurements. The separately recorded post-upgrade two-pack synthetic run measured 1004.11 MiB against 2048 MiB; see the [Phase 18 handoff](phase-18.md). The earlier 512 MiB failure and staging memory gate remain valid.

Final logs: `/tmp/curvi-security-upgrade-types-fixed.log`, `/tmp/curvi-security-upgrade-tests-fixed.log`, `/tmp/curvi-security-upgrade-compat-lint.log`. Initial failures remain at `/tmp/curvi-security-upgrade-types.log` and `/tmp/curvi-security-upgrade-tests.log`; isolated memory retry evidence is `/tmp/curvi-security-upgrade-memory-isolated.log`. The earlier 6,597-pass evidence above is preserved separately.
