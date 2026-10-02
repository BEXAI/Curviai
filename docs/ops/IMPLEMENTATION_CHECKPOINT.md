# Phase 18–20 implementation checkpoint

Updated 2026-10-02 12:59 UTC. This records implemented and verified work, not acceptance of unperformed live checks. Never reset the shared implementation tree.

## Context recovery prompt

The user selected this exact prompt after each context reset:

> Please include a concise orchestration checkpoint with your next milestone update: active/completed subagent workstreams, batches merged/pushed so far with commit and CI links (or why none yet), applied migrations, and the next integration gate. User asked whether I am actively monitoring; I am reviewing your progress and ensuring incremental delivery stays on track. Keep executing rather than pausing for this report. Preserve piecemeal tested main merges/pushes and live Supabase sync.

After recovery: read this checkpoint, inspect Git and active agents, refresh each active owner with scope/dependencies/current instructions, verify before duplicating work, and briefly report recovery. Check project/agent status approximately every five minutes while active (latest user preference). Continue work between checks. Parent task owns personal Memory persistence.

## Authorization and environments

User authorized implementation of all three plans, orchestrated agents, frequent tested main merges to BEXAI/Curviai and automatic Render deployments, and Supabase updates in project `tmwvjmvzjvpeagatjmud`. No new credentials, paid provisioning/generation, real email campaigns, public plugin submission, destructive data loss or new Phase21 features are implied.

- Original `/Users/nathaniel/Developer/Curviai`: preserved clean main `31992a9` at last check; verify again before final fast-forward.
- Shared `/tmp/curvi-phases-18-20`, branch `codex/complete-phases-18-20`, release baseline `02a0ae0`, DB commit `7082ec4`, checkpoint HEAD `0dbf1e1`. Many reviewed changes still uncommitted. Root owns Git/publication.
- Publication `/tmp/curvi-publication`, branch `codex/security-dependency-refresh`, based on PR4 head `26ac003`. Eleven changed files are dependency-only candidate; phase18 owns local checks/build. Do not mutate during checks. Rebase onto merged main after checks.
- Node22: `/tmp/node-v22.23.3-darwin-arm64/bin`; pnpm10.26.1. pnpm store `/Users/nathaniel/Library/pnpm/store/v10`. No environment/secret files read.

## Active ownership

| Agent | Scope |
|---|---|
| phase18 | Security-only publication candidate: lint/types/unit/build/e2e. Main implementation frozen. |
| phase19 | Implementing fail-closed assistant screening readiness for old/unverified intake recipes; pipeline child owns worker guard, parent owns copy/docs. |
| phase19/p19_branch_reuse | Completed full post-upgrade tests/types and Sharp type fixes. |
| phase20 | Renewal correction frozen,49focused tests/types/lint pass; independent review approved. Includes early phase transition guard against incorrect billing date. |
| phase20/schema_contracts | Domain seed complete. Live recipe metadata proves intake@7 active100/@8absent; preparing a not-executed targeted proposal. Browser released; activation requires real eval proof. |
| plugin_docs | Customer/Blueprint/Phase21 and independent renewal review complete. |
| Root | Integration, remaining release review, commits/PRs/CI/deployment verification. |

Individual evidence: `docs/ops/handoffs/`. No shared implementation server active. Publication agent owns port3100/browser build.

## Published batches

| PR | Result | Validation |
|---|---|---|
| [PR2](https://github.com/BEXAI/Curviai/pull/2) | merged `2677f714aff4c086a1167e686961772f8388582d` | Local4,110 tests/116browser; [PRCI](https://github.com/BEXAI/Curviai/actions/runs/37001212113), [mainCI](https://github.com/BEXAI/Curviai/actions/runs/37003319437) green; live verified. |
| [PR3](https://github.com/BEXAI/Curviai/pull/3) | merged `f05cdbe5431ef9890a798ecc2c3929054a9396f0` | Local4,161 tests/116browser; [PRCI](https://github.com/BEXAI/Curviai/actions/runs/37004543872), [mainCI](https://github.com/BEXAI/Curviai/actions/runs/37006282363) green; live health servingf05cdbe healthy12:50UTC. |
| [PR4](https://github.com/BEXAI/Curviai/pull/4) | merged `dae0fb0a0e710b2afe3b6be01cddb40b5ad28bcc`12:50UTC | Local4,318 tests/116browser; [PRCI](https://github.com/BEXAI/Curviai/actions/runs/37006894439) green. MainCI/deployment pending. |

Security [PR5](https://github.com/BEXAI/Curviai/pull/5) head `5460eb6d9d5cfa9654eff04bd5ba173586fa3906` is open; [CI](https://github.com/BEXAI/Curviai/actions/runs/37009715490) pending. Its exact tested tree remained unchanged after rebase onto PR4 merge. Full local lint/types4,318unit/3skips and116browser pass.

Dependency-only batch: exact Drizzle0.45.3, Sharp0.35.5, exiftool-vendored35.19.0, PostCSS8.5.28, direct native/external web dependencies, six named Sharp type imports. No seeds/worker/public API changes. Large feature package/worker slice is not independently compatible with old web (TopUp.expiresMonths removal, SPEND_CAPS removal, Trigger retirement, COGS follow-up coupling); keep dependent features together afterward.

## Live Supabase

All migrations0028–0044 applied.45 journal rows exactly match local hashes;22metadata/security checks passed. Latest0044 timestamp1790938535212, SHA256`229894fcc8c89c1fa382e1289a7c03366f1e3dddaca6a7022c54d9fd63bc3270`; manifestMD5`366a929191018fe22b54aac2d3936aa0`. Applied migration files frozen.

Targeted domain seed applied12:43UTC.9,199 domains; snapshotSHA256`eec4f833fcac629a2da00bcaad7f431630b28bfee7daee3a676ea6a57a6a815b`; CC0 sourcecommit`0c4fd3aaac31f826cd5d2e698385c6cc53f76336`. Exact reviewed transactionSHA`81a00d2719f22a04fbb14e7c01e16d1fa8152e6519d6f5fdc9cfe75c80d5ba0e`. Independent postflight: count/hash/metadata correct, both tables RLS and restrictive OAuth deny intact, client grants0, client signup EXECUTEfalse, latest migration unchanged. [Saved read-only query](https://supabase.com/dashboard/project/tmwvjmvzjvpeagatjmud/sql/ae44f657-8b31-45dd-af2f-05e3f2d7aa02). Evidence `/tmp/curvi-migration-review/0044-domain-seed-production-evidence.json` and handoff.

No broad seed/auth-hook activation. Missing settings mostly use safe defaults; broad seed can change existing recipe traffic and settle historic grants. Schema owner reviewing whether active intake recipe@8 requires targeted rollout; do not promote unevaluated recipes.

## Integration evidence

- Full lint/types,6,598 tests(5optionalPGskips), production build and192browser tests passed before latest renewal correction. Logs `/tmp/curvi-security-upgrade-tests-fixed.log`, `/tmp/curvi-security-upgrade-types-fixed.log`, `/tmp/curvi-integration-lint-final2.log`, `/tmp/curvi-integration-e2e-final.log`.
- Full production dependency audit0advisories/433deps after pins. Sharp named type fixes only.80MP unchanged384MiB budget: initial388.20 failed, isolated346.95 and full342.52 passed; variance recorded.
- Synthetic two-pack pipeline memory1004.11MiB, metadata15/15, offlineimageeval10/10 meanCIEDE2000.3817. No paidcalls;2GiBproductionbudget passes,512MiB unsuitable.
- Final Gitleaks8.30.1 source snapshot1,689files/17.59MB scanned0findings. Exact path+full-line fixture exceptions, defaults retained; earlier4/4negativecanaries caught. Finalauthfixture repeatedtokencleanup6tests pass.
- actionlint1.7.12 workflow validation passes. Render officialJSONschema and envinventory tests pass. Blueprint adoption remains separate reviewed dashboard operation.
- Known full-build warning: externalpostgres prevents Sentry DB spans; basicerrorcapture tested. No buildfailure.

## Phase21 planning

`docs/phases/PHASE_21.md`: seller-visible resolution cases, workspacecreditplanning/optionalbudgets, privatecompletionwebhooks. Three grounded proposals,14local links validated and independent review complete. Planningonly, no featureimplementation. Existing18–20defects andlivegates retaincurrentowners.

## Next gates

1. Finish isolated security candidate verification; commit/push/attachPR, verifyCI, merge to main after exact-head checks.
2. Finish renewal notice correction and assistant recipe readiness review with focused tests; review live recipe metadata before any proposed SQL.
3. Commit reviewed fullimplementation, prepare coherent dependentfeaturePR onpublishedmain, verifyfullCI including realPostgres17 ledger races, merge andconfirm livehealth.
4. Update acceptance/evidence/docs andpreserve originalcheckoutchanges before finalfastforward.
5. Report live acceptance gaps honestly: fundedproviderquality/canary, OAuth/clientpublication, realbilling/mail/auth/MFA, stagingpaidchecks, restore drill, Blueprintadoption/cronmonitors,7dayCSP andconditionalP2. No localtest claims these livechecks passed.

At12:54UTC: security candidate lint/types and4,318unit tests(3skips) pass; productionbuild/browser running. Candidate audit still shows4high/3moderate advisories from the retained legacy Trigger stack; do not claim this intermediate batch has a zero audit. Full feature implementation removes Trigger and audits0. Separate prepared release checkout `/tmp/curvi-feature-release` is based on PR4 and not yet overlaid with feature code.

Feature candidate `/tmp/curvi-feature-release` now has initial source overlay and frozen dependencies installed. It is based on PR5 head; resync from final shared implementation after all active corrections finish, including renewal notice guard and assistant recipe readiness, before testing or committing. Root handles candidate exclusively; no final feature tests run there yet. Live recipe proposal `/tmp/curvi-migration-review/intake-v8-rollout-PREPARED-NOT-EXECUTED.sql` is NOT approved for execution absent funded live eval evidence. Never activate based only on localmocktests.
