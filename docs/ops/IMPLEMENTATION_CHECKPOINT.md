# Phase 18–20 implementation checkpoint

Updated 2026-10-03: the user retired encrypted-backup planning and its release gates. Local disk and GitHub preserve source code, not live database rows, Auth state or stored objects. No database recovery capability is claimed. Existing backup data and security controls remain untouched; no backup service, key or credential is to be provisioned under this plan. Historical implementation and test evidence below remains dated evidence, not an active backup requirement.

Updated 2026-10-02 13:50 UTC. Preserve the shared implementation and continue execution after context recovery. This records evidence, not acceptance of unperformed live checks.

## Context recovery prompt

The user selected this exact prompt after each context reset:

> Please include a concise orchestration checkpoint with your next milestone update: active/completed subagent workstreams, batches merged/pushed so far with commit and CI links (or why none yet), applied migrations, and the next integration gate. User asked whether I am actively monitoring; I am reviewing your progress and ensuring incremental delivery stays on track. Keep executing rather than pausing for this report. Preserve piecemeal tested main merges/pushes and live Supabase sync.

Read this checkpoint, inspect Git and active agents, refresh scope/dependencies/latest instructions, and avoid duplicate work. Check project/agent status approximately every five minutes while continuing useful work. Parent task owns personal Memory persistence.

## Authority and workspaces

User authorized all three plans, orchestrated subagents, tested main merges to BEXAI/Curviai, automatic Render deployments and Supabase SQL in project tmwvjmvzjvpeagatjmud. No new credentials, paid generation/provisioning, actual customer mail/campaigns, destructive data loss or public plugin submission is implied. Do not read secrets or environment files. Phase21 is planning only.

- Original `/Users/nathaniel/Developer/Curviai`: clean main `31992a9f04faae5b4f095fb8743a7ea35d157906` verified 13:41 UTC. Safely fast-forward only after final release and after rechecking for user changes.
- Shared `/tmp/curvi-phases-18-20`, branch `codex/complete-phases-18-20`: full implementation saved in928908d; current security corrections and evidence are uncommitted after131a8aa. Do not reset.
- Final publication `/tmp/curvi-feature-release`, branch `codex/phase18-20-release`: PR6 head c9799aa plus 25 copied security/tooling files. Root exclusively owns candidate/Git/release. Final checks are running here.
- Old security publication `/tmp/curvi-publication`: PR5 head5460eb6, clean and no longer active.
- Node22.23.3 `/tmp/node-v22.23.3-darwin-arm64/bin`, pnpm10.26.1, store `/Users/nathaniel/Library/pnpm/store/v10`. Local test subprocesses and browser servers need sandbox escalation for IPC/network sockets.

## Ownership and current gate

All feature implementation is frozen. Phase18 completed two final screening corrections and now appends only the CodeQL/settings evidence to `docs/ops/handoffs/phase-20.md`. Phase19 completed linear JSON parsing and Vitest4 mock-type fixes; its pipeline child completed linear ICC parsing. Phase20 is validating the scoped esbuild override offline using temporary transforms/schema copies and local PGlite; no live DB calls. Root owns integration and publication.

Do NOT merge PR6 c9799aa. Although its checks and PostgreSQL17 race job passed, the new security changes must be pushed and checked first:

- AI fence parser uses linear delimiter searches; adversarial worker regressions. 109 focused tests passed.
- ICC description padding uses a backward scan; million-NUL subprocess regression. 52 tests and 10/10 offline image eval passed, mean CIEDE2000 unchanged0.3817.
- CLI trailing slashes use a backward scan; preserves internal slashes.
- Assistant jobs require a registered model chain before media/provider work, and cached preflight answers require the actual matching DB recipe identity/version/provider. Missing or older provenance rescreens. 18 worker and38 preflight tests passed, including full hold release. No live recipe activation.
- Vitest upgraded to4.1.11 in all10 workspaces for GHSA-82fw-gwwq-j7x9. Three mock helper annotations updated with precise callable types;20 focused tests and worker/web types pass.
- Exact pnpm override `@esbuild-kit/core-utils>esbuild:0.25.12` removes the remaining development advisory. Its installed consumer uses transform/transformSync/version, not serve. Offline compatibility validation pending final report.

Candidate lint and full typecheck PASS. Full audit reports zero advisories across788 dependencies (`/tmp/curvi-final-all-audit.json`). Final unit run is active (session38505, `/tmp/curvi-final-security-unit.log`); first sandbox-only attempt failed because tsx IPC was blocked, not because of an assertion. Final browser/build and source scan follow. Earlier proof of6,633 unit/5 skips and192 browser tests predates these corrections and cannot stand in for the new gate.

## Publication and production

| Batch | Merge | Verified CI |
|---|---|---|
| [PR2](https://github.com/BEXAI/Curviai/pull/2), foundation |2677f714aff4c086a1167e686961772f8388582d|[PR](https://github.com/BEXAI/Curviai/actions/runs/37001212113), [main](https://github.com/BEXAI/Curviai/actions/runs/37003319437) passed; live verified|
| [PR3](https://github.com/BEXAI/Curviai/pull/3), fidelity copy |f05cdbe5431ef9890a798ecc2c3929054a9396f0|[PR](https://github.com/BEXAI/Curviai/actions/runs/37004543872), [main](https://github.com/BEXAI/Curviai/actions/runs/37006282363) passed; live verified|
| [PR4](https://github.com/BEXAI/Curviai/pull/4), DB contracts |dae0fb0a0e710b2afe3b6be01cddb40b5ad28bcc|[PR](https://github.com/BEXAI/Curviai/actions/runs/37006894439), [main](https://github.com/BEXAI/Curviai/actions/runs/37009124896) passed; live verified|
| [PR5](https://github.com/BEXAI/Curviai/pull/5), dependency security |b4893d19f6a715395f204d56a7e156a5001d8dd1|[PR](https://github.com/BEXAI/Curviai/actions/runs/37009715490) passed; deployment not yet observed|
| [PR6](https://github.com/BEXAI/Curviai/pull/6), dependent features |OPEN, c9799aad5f614e0e48b38c868609728db3d46eb3|[CI](https://github.com/BEXAI/Curviai/actions/runs/37011888997): checks and PostgreSQL17 passed, browser in progress at13:41; [demo smoke](https://github.com/BEXAI/Curviai/actions/runs/37011888966) passed. Superseding security patch pending.|

PR6 is based on main; its earlier merge tree exactly equaled the tested tree. Recheck after the final patch. All PRs attached to this task. Preserve meaningful implementation commits; no force push needed.

Production public health at13:41:27 UTC serves dae0fb0, ok:true, DB/schema current through0044, runner idle. Several auxiliary Dependabot update jobs failed on old mainb4893 (legacy Trigger/Jaeger chain, workspace directory mismatch, old test tooling). Candidate removes Trigger, has root workspace Dependabot config and fixes all current advisories. Do not disable Render checksPass or claim old failed checks fixed. Verify the final new main SHA and every relevant check before claiming deployment.

## Hosted security evidence

CodeQL default setup (default queries, standard hosted runners, weekly), Dependabot alerts and security updates, and private vulnerability reporting are enabled/read back. Auto-merge remains off. Existing secret scanning and push protection preserved.

Initial [CodeQL run37012185268](https://github.com/BEXAI/Curviai/actions/runs/37012185268) succeeded on mainb4893: Actions0 findings, JS/TS11. Triaged: material quadratic JSON/ICC parsers fixed; local CLI trim hardened; other findings have concrete benign/test-only evidence in phase20 handoff. No alert dismissals. Do not call CodeQL clean; final corrected feature head must be analyzed after push.

## Live Supabase complete

Migrations0028–0044 applied; all45 journal rows exactly match local timestamps/hashes and22 postflight metadata/security checks passed. Latest0044 timestamp1790938535212, SHA256 `229894fcc8c89c1fa382e1289a7c03366f1e3dddaca6a7022c54d9fd63bc3270`; manifestMD5 `366a929191018fe22b54aac2d3936aa0`. Applied SQL files frozen.

Targeted9,199-domain seed committed12:43UTC, snapshotSHA256 `eec4f833fcac629a2da00bcaad7f431630b28bfee7daee3a676ea6a57a6a815b`, CC0 source0c4fd3aaac31f826cd5d2e698385c6cc53f76336. Count/hash/metadata verified; RLS and OAuth deny intact, client grants0, client signup EXECUTEfalse. [Read-only postflight](https://supabase.com/dashboard/project/tmwvjmvzjvpeagatjmud/sql/ae44f657-8b31-45dd-af2f-05e3f2d7aa02), local evidence `/tmp/curvi-migration-review/0044-domain-seed-production-evidence.json`.

Live recipe metadata: intake7 active100, intake8 absent; planner3 active100,4/5 absent. Prepared `/tmp/curvi-migration-review/intake-v8-rollout-PREPARED-NOT-EXECUTED.sql` is NOT executed or approved absent funded eval evidence. Do not broad-seed, activate auth hooks/OAuth, or change live recipe traffic. Browser ownership released.

## Next steps

1. Finish final candidate unit/build/browser, scoped esbuild validation and Gitleaks; record exact evidence and triage docs. Copy final docs consistently, commit shared implementation, commit/push one combined PR6 correction.
2. Wait corrected-head CI including PostgreSQL17, browser, demo and CodeQL. Resolve actual failures without weakening thresholds or disabling protections. Merge only that exact verified head.
3. Verify main CI and Render health match merged SHA, then run no-spend public production smoke. Do not use generation as smoke.
4. Recheck original checkout, safely fast-forward main and install frozen dependencies as needed. Preserve any user changes.
5. Deliver concise PR/live DB/testing evidence and explicit remaining live gates. Phase21 proposals only: resolution cases, workspace credit planning/optional budgets, private completion webhooks (`docs/phases/PHASE_21.md`).

Remaining live acceptance: funded model/recipe evaluation and controlled activation; OAuth/public plugin setup; real Stripe/mail/auth/MFA; paid staging and Blueprint/cron/monitor adoption;7-day CSP evidence; conditional P2 triggers. These are not silently accepted by local tests. Detailed matrices and founder steps are in docs/PENDING.md and the phase documents.


## Final local gate completed13:50UTC

All agents completed and froze their work. Final candidate lint/types,6,657 unit tests (four optional PG skips plus one unavailable-ffmpeg diagnostic skip), production build/192browser tests pass. Full audit0/788 dependencies, Gitleaks0/1,689files. Scoped esbuild validation complete:6transform cases, no schema drift,19localDBtests,88unchangedmigration/snapshotfiles. Source and candidate evidence docs are synchronized before one correction push toPR6. No local server remains. Next: observe new exact-headCI/CodeQL, merge, observe mainCI/Renderhealth, publicsmoke, safelyfastforwardoriginalcheckout.


## Corrected head published13:52UTC

Shared implementation committed ascbb7c4e. PR6 corrected head is`f530cc1995e07b007d1c238c89c415564c35c43c`. [CI](https://github.com/BEXAI/Curviai/actions/runs/37015905921), [CodeQL](https://github.com/BEXAI/Curviai/actions/runs/37015901850), [Smoke](https://github.com/BEXAI/Curviai/actions/runs/37015905508). All are freshly triggered; wait exact-head results before merging. CIwatchsession74137 uses300-second cadence, log `/tmp/curvi-final-pr6-ci-watch.log`. `/tmp/curvi-release-final-evidence.json` collects final links/status. Allsubagents completed; no need to reactivate absent an actual failure.

Independent read-only parity confirmed1,689trackednon-envfiles have identicalbytes/modes acrosssharedcbb7c4e andcandidatef530cc199;45SQL+43metadatafiles identical through0044. Both clean at audit;originalmainstillclean31992a9. No environment file contents read. The candidate's pushed docs are a truthful pre-hosted-check snapshot; keep further live release evidence local/shared untilfinalreport toavoid restartingCIwithdocumentation-only pushes.


## Additional feature-head CodeQL findings13:58UTC

DoNOTmergef530cc199 yet. MatchingCodeQLanalysis1881226028 onrefs/pull/6/head completed with18findings: old1–3fixed/absent, old4–11remainbenignastriaged, new12–21. Phase18 nowownsONLYemailregex12–17 inpackages/email. MaterialremoteResenderror-redactionboundary hasquadraticregexbefore300-charactertruncation; remainingconfig/formathelpersalsouseequivalentlinearhardening. Childownsrender.ts/tests;parentownsconfig/keys/resend/tests. Phase19read-onlytriageswebtest/quotehashalerts18–21. No broadrevieworalertdismissal. Candidatef530stillclean; sourcewillcontainemailcorrections. Prior6657/192localproofisforf530. Afterfocusedemailtests/types/lint andreview,copycorrectionwithtriageevidenceandpushonce;fullnewheadCI/CodeQLandbrowsermustpassbeforemerge. Oldwatch74137willendcanceledwhennewheadsupersedesit; updatewatchaccordingly.


## Email correction frozen14:04UTC

Phase18 completed8email source/test files (includes newconfig.test.ts);116emailtests/types/lint pass;20,000differentialinputs matcholdbehavior,snapshotsunchanged. Phase19 confirmednewweb18–21test-only/nonpasswordhash/noURLauthorization. Allagentscompleteagain. Rootcopying8files+triageevidencetocandidateandpublishingonefollow-up. DoNOTmergef530untilthenewheadfullCI/CodeQL/browserpass. Precedinglocal6657/192proofandnew116focusedemailproofareseparate; subsequenthostedfullgateauthoritative.
