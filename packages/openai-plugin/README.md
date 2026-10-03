# Curvi plugin package

This package builds the Curvi plugin folder and ZIP. It performs no upload, account setup, live tool call, credit grant or generation. The existing publisher placeholder intentionally blocks a build until the actual verified publisher name is supplied. Name matching is a metadata consistency check; the build cannot verify a legal identity.

## Draft and local installation

From the repository root, substitute the actual publisher name:

```sh
pnpm plugin:zip --developer-name "Actual verified publisher"
```

The default draft mode preserves the local packaging workflow. It warns when the recording URL is absent. Use the resulting folder for a local marketplace install; this does not submit or publish the plugin. The ZIP contains the root `plugin.json`, `mcp.json` and declared package assets.

## Local submission checks

First replace `review.demo_recording_url` in the source manifest with the accessible, sanitized recording of the actual client test. Capture a complete sanitized OAuth `tools/list` result from the intended deployment in an external JSON file. It must contain only the descriptor response, never authorization headers, requests, credentials or tool-call results. Preserve its source deployment SHA and capture time separately in the release evidence; the protocol descriptor alone does not prove provenance.

```sh
pnpm plugin:zip --submission --developer-name "Actual verified publisher" --tools-file /absolute/path/to/review/tools-list.json --out /absolute/path/to/review/artifacts
```

`--submission` requires the recording URL and descriptor file in addition to the existing package checks. The file must stay outside `package/`, end in `.json` and be at most 2 MiB. The reader limits the bytes read and never prints its contents or parser excerpts. Unknown/misspelled CLI options fail instead of silently producing a draft.

The snapshot may be the `tools/list` result (`{"tools":[...]}`) or its JSON-RPC response. It must be complete, without a pagination cursor. The local gate checks all seven expected tool names, duplicates, the three reviewed annotation values, object input/output schema structure, required pack identifiers, UI visibility and the current viewer resource. These are descriptor shape/consistency checks, not general JSON Schema validation or proof of functional behavior. An API-key snapshot omitting OAuth-only `get_profile` is insufficient for this ChatGPT submission.

The two render tools, `create_pack` and `show_pack`, must reference `ui://curvi/pack-viewer/v2.html`. Only data-only `get_pack` is app-visible for polling and refresh. Optional screenshots require a valid supplied UI snapshot, one distinct PNG/JPEG path per starter prompt, width 706 px and height 400–860 px. Curvi additionally bounds each screenshot to 5 MiB. Header/size checks do not replace visual inspection or the portal's image decoder. Screenshots may be omitted; never fabricate real-client screenshots.

The tools file and review rationales are validation inputs/documentation, not undocumented manifest fields and not automatically bundled. Keep reviewer credentials exclusively in the authorized private review dashboard. Do not place evidence files, logs or secrets under `package/`, whose regular files are archived.

A successful command says **local submission package checks passed**. Every success still lists the external gates: verified identity/project/permissions, live policies and real recording, OAuth containment and real supported-client acceptance, current production domain/tool/UI scan, approved reviewer access and actual policy attestations. It establishes no submission, approval or publication. Bind the final ZIP hash and package version to the reviewed source/deployment SHA in the release record before upload.

## Tool annotation review notes

These notes reflect the current Curvi contract and are maintained in `src/submission.ts`; they are preparation for the portal's justifications, not invented `plugin.json` fields. If a hint changes, review the actual behavior and update the rationale and local contract together.

Official pages conflict: the [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) now say annotation justifications are no longer required, while the submission-error reference still lists them as required. Keep the factual notes available and follow the actual portal requirements. This does not change the need for accurate explicit annotations.

| Tool | Read only | Destructive | Open world | Behavior and qualification |
| --- | --- | --- | --- | --- |
| `list_channels` | true | false | false | Reads channel options and selected-workspace entitlements; no generation or external destination. |
| `estimate_pack` | true | false | true | Reads supplied external photos and the current balance without reconciling jobs, storing photos or reserving credits. |
| `create_pack` | false | true | true | Receives photos, creates a job and reserves/consumes credits for delivered outputs. OAuth requires the signed estimate and disclosed ceiling. |
| `get_pack` | true | false | false | Explicit snapshot read of the authorized pack/assets with reconciliation disabled. No job settlement, credit-hold changes or completion events. |
| `show_pack` | true | false | false | Renders the same authorized snapshot with reconciliation disabled. No new generation, credit-hold changes or external publication. |
| `check_main_image` | true | false | true | Reads the supplied external image and returns deterministic checks without storing/editing it or spending credits. |
| `get_profile` | true | false | false | Returns the account/workspace selected by OAuth without changing either. |

OpenAI's read-only guidance is strict about state changes. MCP get/show and estimate explicitly opt out of the web service's usual orphan reconciliation; default web reads and scheduled recovery retain that responsibility. Routine authorization, rate counters and security bookkeeping remain middleware. Local equality to these hints does not certify live behavior or OpenAI's review outcome.

## Official references and launch ownership

Checked 2026-10-02: [packaging](https://developers.openai.com/plugins/build/plugins), [submission](https://developers.openai.com/plugins/deploy/submission), [final validation errors](https://developers.openai.com/plugins/deploy/submission-errors), [MCP review](https://developers.openai.com/plugins/deploy/app-review). Metadata limits and supported fields come from those references; the local byte bounds are implementation limits. Current portal findings remain authoritative at submission time.

The complete launch acceptance and external review ledger live in `docs/phases/PHASE_22.md` and `docs/ops/handoffs/phase22-submission-readiness.md`. Root owns credentials, activation, funded acceptance, portal submission and publication. Nothing in this tooling authorizes those actions.
