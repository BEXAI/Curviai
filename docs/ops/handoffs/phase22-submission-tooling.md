# Phase 22 submission tooling

Owner: submission lane. Implementation checkout: `/tmp/curvi-phase-22`, branch `codex/phase22-chatgpt-launch`. Updated 2026-10-02. Root owns final release, verification log, live accounts/configuration, actual client testing and portal actions.

## Changes

- `packages/openai-plugin/src/build.ts`: explicit `--submission` mode, external `--tools-file`, strict argument parsing and success output that retains external approval/readiness checks. Default draft ZIP behavior is preserved. A typo cannot silently select draft mode. No command uploads anything.
- `src/manifest.ts`: submission mode requires the real recording URL field and a sanitized descriptor file. Identity placeholders still fail. Optional screenshots are now allowed when the supplied valid snapshot has UI resources, with one distinct image per starter prompt, PNG/JPEG header/extension/dimension checks and contained paths. A tools snapshot inside the package is rejected.
- `src/submission.ts`: bounded external JSON reader, seven-tool inventory/annotation rationale, required input/output object schema structure, `pack_id`, current viewer URI and expected UI visibility. Duplicate/missing/unreviewed tools and paginated snapshots fail. Only `get_pack` is app-visible and data-only; `create_pack`/`show_pack` share `ui://curvi/pack-viewer/v2.html`. Reads stop at 2 MiB plus one byte and special files cannot block on open. Errors do not echo input/parser excerpts.
- `src/limits.ts`: screenshot dimensions and clearly labeled local 5 MiB bound.
- Manifest review cases/golden prompts now include `show_pack` and visible delivered image/ZIP/report handoff. They describe expected acceptance, not actual completed runs. The seven tools remain covered by golden prompts.
- `README.md`: draft/submission commands, snapshot capture/provenance boundary, annotation notes, current official documentation conflict and external gates.
- Focused tests cover blocked/passing submission paths, unchanged draft behavior, malformed CLI/snapshots, annotations/schema/UI drift, screenshot bounds/traversal/symlink escape, no artifacts after a failed gate, and the explicit external-check list after local success.

## Meaning of a pass

The local gate checks metadata consistency and descriptor structure. It does not verify legal identity, recording existence/accessibility, deployment SHA, full JSON Schema validity, real ChatGPT behavior, the current OpenAI scan, submission or approval. The supplied `tools/list` JSON has no invented provenance fields. Root must retain its capture time/deployed SHA separately, then bind the final ZIP version/hash and source SHA to actual release/portal evidence.

Reviewer credentials, account data and raw request logs never belong under `package/` or in the snapshot. Only descriptors belong in `--tools-file`; the file is not copied to the ZIP. No identity, reviewer credential, recording or approval was fabricated. The source identity placeholder and missing recording remain honest final-build blockers.

## Validation

| Check | Result / evidence |
| --- | --- |
| `pnpm --filter @curvi/openai-plugin test` | 4 files, 93 tests passed. `/tmp/curvi-phase22-submission-tests.log`. |
| Package TypeScript | Passed. `/tmp/curvi-phase22-submission-types.log`. |
| ESLint on all modified/new package TS files | Passed. `/tmp/curvi-phase22-submission-lint.log`. |
| `git diff --check` for package | Passed. |
| Real local CLI negative acceptance | `pnpm plugin:zip --submission --out /tmp/curvi-phase22-unready-zip` exited 1 on missing descriptor, both identity placeholders and missing recording. Output directory was not created. `/tmp/curvi-phase22-submission-cli.log`. |
| Real generated MCP descriptor compatibility | Connection lane reports the actual generated OAuth `toolList` passes `checkToolSnapshot` in `apps/web/src/app/api/mcp/mcp-descriptors.test.ts`. This is source-level proof; no live snapshot was captured. |

Root still runs the coherent whole-repository gates. Fixture test identities/URLs/images are clearly local test data and were never used for an actual submission.

## Coordinated annotation correction

Review found that the old shared pack/estimate read paths could perform orphan reconciliation. The connection lane implemented the internal `reconcile: false` option for MCP `get_pack`, `show_pack` and `estimate_pack`; web/default reads and scheduled recovery retain existing behavior. PGlite coverage proves repeated get/show leave stale jobs, ledger and events unchanged, and the actual generated descriptor check passes. Root confirmed the final eight-suite run: 150 tests passed in `/tmp/curvi-phase22-readonly-focused.log`. After that report and a source read of the explicit options/guards, this lane updated all three rationales to the implemented snapshot contract. Routine authorization/security bookkeeping is distinct from pack generation, ledger settlement and completion-event creation. Package source is frozen for root integration checks.

## Official sources

Checked 2026-10-02: [package format](https://developers.openai.com/plugins/build/plugins), [submission flow](https://developers.openai.com/plugins/deploy/submission), [final submission errors](https://developers.openai.com/plugins/deploy/submission-errors), [MCP review](https://developers.openai.com/plugins/deploy/app-review), [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines).

The guideline's annotation section says justifications are no longer required; the error reference still reports `justification_required`. Keep accurate rationales prepared, use actual portal requirements and do not invent a manifest field. The screenshot dimensions/conditional UI rule are documented; 2 MiB descriptor and 5 MiB screenshot bounds are Curvi's local limits. Root records this dated verification centrally.

## Remaining external blockers

Exact publisher/organization/project, legal facts, approved persistent OAuth/reviewer access and exact action-time containment-probe scope, approved owned assets/workspace and provider-spend ceiling, live screening/ChatGPT evidence, accessible recording, current production scan/domain verification and actual attestations remain separate from these local checks. The parent's bundled questions are already pending; do not duplicate them.

PR 6's CodeQL disposition gate remains unchanged. Automatic approval review previously rejected dismissing seven alerts without explicit authorization; no alert-state change or bypass was attempted by this lane. No deployment, portal submission, approval or publication is claimed here.
