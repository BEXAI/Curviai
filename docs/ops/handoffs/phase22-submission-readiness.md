# Phase 22 submission readiness

Owner: submission lane; root coordinates execution. Updated 2026-10-02, approximately 15:40 UTC. This records preparation, not an OpenAI submission or approval.

Subsequent business-details update on 2026-10-02: the founder supplied and authorized public use of **AIManagement Inc.**, **131 Continental Drive, Suite 305, Newark New Castle, DE 19713**, and described the business as a Delaware corporation established in 2025. This is user-provided business provenance, not independent or OpenAI verification, and does not establish Curvi's founding date. The source terms/privacy now render the name/address; deployment and live read-back remain separate. Governing law, counsel review, verified platform publisher and account/project evidence remain unresolved. The timestamped audit below remains historical; both verified-name manifest placeholders remain unchanged.

## Deliverables and scope

The lane owns [PHASE_22.md](../../phases/PHASE_22.md) and this handoff only. The plan now covers implementation, actual ChatGPT assets, submission, review follow-through and publication. Earlier proposals remain in Phase 23. No runtime/source implementation, live configuration, credentials, funded calls, upload, submission or third-party messaging was performed by this lane.

Read repository instructions and the existing Phase 19 plan/runbook. Current portable `plugin.json`/`mcp.json` packaging remains supported. Local installation is not a public listing.

## Official sources checked on 2026-10-02

Root owns adding these checks to shared `docs/verification.md`.

| Source | Use |
| --- | --- |
| [Package guide](https://developers.openai.com/plugins/build/plugins) | Portable root manifest and MCP configuration. |
| [Submission flow](https://developers.openai.com/plugins/deploy/submission) | Current portal route, checks, private review details and publication. |
| [MCP review](https://developers.openai.com/plugins/deploy/app-review) | Identity, permissions, global residency, real supported-surface tests and status. |
| [Submission errors](https://developers.openai.com/plugins/deploy/submission-errors) | Final-readiness, annotations, recording/cases and screenshot requirements. |
| [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) | Accurate function/privacy claims, existing entitlements and reviewer access. |
| [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt) | Actual connected/installed plugin testing and metadata refresh. |

The old Apps SDK submission/guidelines paths redirect to `/plugins/`. The current submission page says endpoint URL changes require support; the MCP maintenance page permits a path change via a new version. Keep the entire Curvi URL unchanged.

## Source inventory

| Path | Finding |
| --- | --- |
| `packages/openai-plugin/package/plugin.json` | `curvi`/`1.0.0`, Curvi/Creativity, three prompts, five positive/three negative cases, four URLs and actual brand assets. Author/developer names are placeholders. Recording absent. |
| `packages/openai-plugin/package/mcp.json` | One credential-free `streamable-http` endpoint, `https://curvi.ai/api/mcp`. |
| `packages/openai-plugin/src/build.ts` | Deterministic local build, developer-name option and archive read-back; no upload. |
| `packages/openai-plugin/src/manifest.ts` | Rejects identity placeholders; missing recording only warns. Root notified of strict final-readiness gap. |
| `packages/openai-plugin/src/limits.ts` | Metadata, assets, archive and five/three case checks exist. |
| `e2e/openai-plugin.spec.ts` | Demo-build URL/photo/preflight/dark-OAuth tests; no real ChatGPT proof. |
| `apps/web/src/lib/legal/facts.ts` | Legal name/address/governing law null; contact `hello@curvi.ai`. Do not guess publisher. |
| `apps/web/src/app/(marketing)/privacy/privacy-copy.ts` | Assistant data/retention/OpenAI recipient disclosure in source; deployed copy needs read-back. |
| `apps/web/src/lib/mcp-ui/pack-viewer/resource.ts` | Viewer off at audit time. Assets lane owns implementation; Phase 22 requires it before initial review. |

The placeholder is intentional protection against invented identity. Build only after receiving the actual verified name. Reconcile source version with any existing portal draft/listing before upload.

## Public checks

Read with system `curl` and normal TLS verification at 2026-10-02 15:35:01–15:35:03 UTC. Python's CA store initially failed validation; no insecure override was used. Browser fetch failed; curl produced this evidence.

| URL | Response |
| --- | --- |
| `https://curvi.ai/` | 200 HTML. |
| `https://curvi.ai/privacy` | 200 HTML; older deployed policy names `hello@curvi.ai`. |
| `https://curvi.ai/terms` | 200 HTML; older deployed terms name `hello@curvi.ai`. |
| `https://curvi.ai/support` | 404. |
| `https://curvi.ai/review/sample-product.jpg` | 404. |

The 404s match undeployed prerequisite features. Deploy/test the coherent release and repeat these reads. Do not invent replacement links to satisfy validation. Public content did not establish a legal publisher or OpenAI owning account.

The connection lane separately reported healthy production `dae0fb0`/schema `0044` and protected-resource metadata 404 at 15:33–15:34 UTC. Public Supabase discovery supports S256/OIDC but proves neither configured containment nor a ChatGPT roundtrip. Its lane documents that remaining proof.

## Outstanding prerequisites

1. **Identity:** a new publishing setup named **Curvi** is authorized. Exact OpenAI organization/project, verified publisher and role/global residency evidence remain missing. Public legal name/address and their publication are authorized; governing law and counsel review remain pending. Supplied company details and the setup name do not establish verified platform identity.
2. **Test access:** dedicated test/reviewer account setup and test OAuth are authorized. Exact dashboard callback, provider/project/client details, scopes/workspace, secure account details and configuration/read-back remain required. Any password/MFA containment mutation needs its exact action-time scope. Secrets stay in authorized dashboards. Authorization does not establish that accounts or OAuth have been created, configured or live-tested.
3. **Reviewer:** precise entitlements, numeric credit limit, secure reviewer-access details and maintenance owner remain missing. The earlier 300-credit proposal is not an approved grant. A grant is not provider-spend authority.
4. **Funded proof:** the two supplied model-car photos and existing candle gallery are authorized sample assets. Numeric provider-spend and credit limits, estimated calls/costs and a stop condition remain required before funded screening or real generation.
5. **Client proof:** actual connection, attachments, confirmation, preview, image/ZIP/report bytes, existing pack, renewal and revocation. Fixtures do not complete this gate.
6. **Final materials:** sanitized accessible recording, validated/hash-recorded package, current production scan/domain proof, usable private reviewer access and accepted attestations.
7. **Release:** PR 6's exact-seven CodeQL disposition approval remains pending. No alert-state change or bypass here.

Root received identity/reviewer/recording gaps as soon as established and live 404s immediately after checking. Submission/publication goals are already authorized; only unresolved action-specific legal/access/spend constraints need approval.

Root confirms authorization for the new Curvi publishing setup, dedicated test/reviewer accounts, test OAuth, the two supplied model-car photos, the existing candle gallery and public business name/address. Do not repeat those answered questions. Numeric spend/credit limits, exact dashboard and secure account details, verified identity/role/residency, governing law/counsel and action-time attestations remain unresolved. Password/MFA mutations for containment testing need exact action-time scope and secure credential entry; general account approval does not authorize them. No account creation, platform verification or live test completion is established by these approvals.

Phase 21 was subsequently saved as local commits `1004a93` and `72941b2`; final checks are rerunning before root creates the Phase 22 implementation clone. This does not imply a new deployment.

## Recommended next implementation ownership

After root creates the Phase 22 clone, assign this lane `packages/openai-plugin/src/manifest.ts`, `src/build.ts`, their package tests and any new focused readiness module/tests under `packages/openai-plugin/src/`. Add an explicit final-submission mode that fails on missing required recording/reviewer-material evidence while preserving today's useful draft/local ZIP flow. Keep secret reviewer credentials out of every artifact. Distinguish static package checks from live portal/identity/domain/tool-scan assertions that require supplied verified evidence rather than a fabricated boolean.

Coordinate package manifest content with root and the assets lane because new UI tools and confirmed behavior affect review cases/descriptions. Annotation rationale auditing can be read-only here; the connection/assets lane should own any `apps/web/src/lib/api-v1/mcp-tools.ts` changes to avoid shared-file collisions. Root owns policy/legal facts, public deployment, portal actions, the shared verification log and final readiness sign-off. Do not begin code before the new checkout and assignment are confirmed.

## Reviewer case evidence

Record each case's surface/version, source/deployment SHA, UTC time, sample hash, workspace alias, tool calls/confirmation, disclosed/approved/charged credits, actual result and redacted artifact. No credentials, complete signed links, tokens, customer content or private account screenshots in Git.

| Case | Actual client outcome |
| --- | --- |
| P1 main-image check | Not run. |
| P2 channels/options | Not run. |
| P3 quote without generation | Not run. |
| P4 confirmed Amazon/Shopify pack | Not run. |
| P5 keep-background Etsy/eBay pack | Not run. |
| N1 listing copy | Not run. |
| N2 invented cartoon/no product photo | Not run. |
| N3 store price mutation | Not run. |
| Additional download/partial/expiry/budget/revoke cases | Not run; use the Phase 22 acceptance matrix. |

Validate actual downloaded bytes/contents, not only an HTTP status or displayed filename. The completed reviewer recording must show real confirmation and rendering, without fixture substitutions.

## External review ledger

| Field | Current value |
| --- | --- |
| Organization/project and verified publisher | Not established. |
| Plugin ID / portal draft | Not established. |
| Final version/ZIP hash | Not built with verified identity. |
| Submission | Not submitted. |
| Reviewer feedback | None observed. |
| Approval / publication / directory URL | No evidence. |
| Owner | Root for execution and review follow-through. |
| Next action | Complete independent code/tests and resolve identity/access/spend; then actual client acceptance and final package. |
| Next external check | Next authorized dashboard continuation; after submission record a specific check time or successfully configured authorized monitor. None created by this lane. |

Append later issue references, affected version, reproduction, owner, tested correction and new portal status. Keep approval distinct from publication. An external wait remains an open phase with a concrete next action.
