# Phase 22 existing-pack viewer entry point

Implemented in `/private/tmp/curvi-phase-22` on `codex/phase22-chatgpt-launch`, based on frozen Phase 21 commit `72941b2`. Owner: `p22_connection`. No Git publication, live calls, configuration, credentials or OAuth grants changed.

## Behavior

`show_pack` opens an existing authorized pack using the same `getPack` and `packView` path as `get_pack`. It accepts only `pack_id`, requires `packs:read`, returns `PackChat` and requests the already-delivered file list. The server derives the workspace from the authenticated caller. Missing or foreign packs return the existing neutral refusal without file metadata.

The tool is model-visible and names `PACK_VIEWER_TEMPLATE`, the same resource as `create_pack`. The viewer lane enables that resource and moves it to v2. `get_pack` stays model/app-visible and carries no UI template, so progress polling and file refresh do not create another viewer. The existing resource switch still removes the render association when disabled; text and structured results remain available.

The tool does not start or retry generation, reserve or settle credits, cancel or settle jobs, or alter files. Initial generation's integer `max_credits` contract is unchanged. Existing authenticated file-link signing, expiry, tenant checks, role handling and revocation are reused.

An explicit `show_pack: mcp.read` policy shares the existing per-caller/workspace read bucket with `get_pack`. This avoids a new read alias bypassing the current throttle.

## Annotation rationale

| Annotation | Value | Reason |
| --- | --- | --- |
| `readOnlyHint` | `true` | Retrieves the current authorized pack and delivered-file snapshot with reconciliation explicitly disabled. It does not mutate jobs, ledger entries, files or completion outbox state. |
| `destructiveHint` | `false` | No deletion, overwrite, purchase, credit spending or irreversible pack action. |
| `openWorldHint` | `false` | Reads the connected workspace's Curvi state and signs links for its stored files. It neither accepts nor fetches arbitrary external destinations. |
| `idempotentHint` | `true` | Repeating the read has no business-state side effects. Worker progress and expiring signed-link values may change the returned snapshot. |

The per-tool OAuth security scheme, output schema and strict input validation remain consistent with existing descriptors. Current official guidance checked in the companion readiness audit: [tool and UI metadata](https://developers.openai.com/plugins/reference), [MCP UI](https://developers.openai.com/plugins/build/chatgpt-ui). Actual host rendering is still a separate acceptance step.

## Read-only correction

The audit found an existing defect: `DbService.getJob` could settle an orphaned run, charging already-delivered outputs, releasing holds and producing completion events and webhook deliveries. `estimateJob` could do the same through its balance read. This conflicted with their read-only tool annotations under the current [app review definition](https://developers.openai.com/plugins/deploy/app-review) and [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines), checked 2026-10-02.

`ServiceReadOptions` now provides an internal `reconcile` policy for `getJob` and `estimateJob`, forwarded to the private balance reader. Shared MCP `packView` explicitly passes `{ reconcile: false }` for both `get_pack` and `show_pack`; `estimatePack` selects the same snapshot policy. This option is never accepted from tool arguments or a public request schema. Estimates report the current ledger balance, including holds pending worker recovery. Default web/REST service reads retain reconciliation. Demo snapshot reads also stop advancing simulated work; tests advance the fixture explicitly outside the tool.

Scheduled recovery is unchanged: Node instrumentation starts `jobs/recovery.ts`, and cron retains both the stale-job sweep and orphan recovery. No new scheduler is needed. The internal policy does not extend `workspaceBalance`, which these MCP actions do not call.

The remaining read-only tools were audited: `list_channels` reads registry and output-option switches, `get_profile` projects the authenticated account/workspace, and `check_main_image` decodes the supplied photo and computes checks without storing it. Authentication, security logging and rate-limit bookkeeping remain active; the guarantee concerns tool business-state effects, not disabling security controls.

## Validation

Initial viewer-entrypoint run passed: **6 suites, 121 tests**. Files covered:

- `mcp-descriptors.test.ts`: deterministic tool inventory, annotations, output schema, model/app visibility, render association, instructions within 512 characters and response shape.
- `mcp-oauth.test.ts`: no unauthenticated pack/file read; client-seat reads; repeated image/ZIP/report retrieval without another job or changed balance; member removal and explicit reconnect; foreign-pack refusal and rejected workspace override.
- `mcp.test.ts`: API-key read scope and transport/tool inventory.
- `openai-interop.test.ts`: updated inventory for modern and prior protocol generations.
- `caller-rate-limits.test.ts`: shared read mapping and refusal after `get_pack` exhausts the bucket.
- `mcp-pack-links.test.ts`: existing signed-link and fallback compatibility.

The final read-only correction run passed: **8 suites, 150 tests**, including `mcp-readonly`, `mcp-descriptors`, `mcp`, `mcp-oauth`, `mcp-copy-reach`, `mcp-credits`, `db` and `db-estimate`.

- New PGlite tests exercise the actual MCP tools against stale delivered and undelivered jobs, comparing complete job, ledger, completion-event, webhook-delivery, product, media, asset and file rows after repeated reads.
- Recovery comparison tests show default `getJob`, default `estimateJob` and the scheduled sweep still charge delivered work, release holds and enqueue the two completion deliveries, once only.
- Alternating demo `get_pack`/`show_pack` calls leave simulation and balance unchanged; default fixture ticks still finish the pack.
- Actual generated OAuth `toolList()` passes the submission package's `checkToolSnapshot`, including the seven tools, annotations, schemas, visibility and v2 render association.

Changed-file ESLint and `pnpm --filter @curvi/web run typecheck` passed. Root owns full repository checks.

Logs: `/tmp/curvi-phase22-show-pack-tests.log`, `/tmp/curvi-phase22-show-pack-lint.log`, `/tmp/curvi-phase22-show-pack-typecheck.log`.

Correction logs: `/tmp/curvi-phase22-readonly-focused.log`, `/tmp/curvi-phase22-readonly-lint.log`, `/tmp/curvi-phase22-readonly-typecheck.log`.

The source fixtures do not prove actual ChatGPT rendering, downloads, OAuth containment or publication. Root owns complete integration gates and live acceptance. Any password/MFA security probe requires explicit approval for those precise disposable-account actions; general account setup approval is insufficient.
