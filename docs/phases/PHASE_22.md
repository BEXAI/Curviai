# Phase 22: launch the Curvi ChatGPT plugin

Status: **authorized for implementation, deployment, submission and publication, 2026-10-02**. The user's goal is a fully functional Curvi plugin that delivers assets inside ChatGPT and earns OpenAI approval. Approval belongs to OpenAI; this phase is not approved, submitted or publicly available until the corresponding external evidence is recorded. The earlier three proposals are preserved in [Phase 23](PHASE_23.md), which remains planning only.

This plan supersedes Phase 19's launch sequencing where stated below. Its implemented OAuth, tools, pipeline, signed links, viewer and package are the starting point. Phase 21 continues in parallel; its budgets must apply to assistant generation, while its resolution cases and private completion webhooks do not require additional ChatGPT tools or MCP Events.

## Authority and current state

The current instruction authorizes tested implementation, normal main merges/pushes, Render deployment, safe reviewed Supabase synchronization, official submission and publication after approval. It does not authorize creating credentials or persistent OAuth access, accepting legal agreements, funded evaluations/generation, customer-data sharing, or arbitrary webhook delivery. Prepare each concrete action before requesting the specific missing approval. Do not read `.env*` or secret values, put credentials in evidence, or treat an old proposed reviewer grant as permission to spend.

PR 6's seven CodeQL dispositions remain a separate gate. Automatic approval review rejected changing those alert states without explicit authorization. Phase 22 does not override that rejection or permit a failing-check merge. Build/test independent work on the reviewed prerequisite and publish dependent main changes only after its gate clears.

| Evidence at 2026-10-02, approximately 15:35 UTC | Observed state | Launch consequence |
| --- | --- | --- |
| Implementation checkout | `codex/phase21-seller-integrations`, based on PR 6 commit `fc44989f30e70d113873acb1dbca927d3b63fea0`; Phase 21 changes under full checks | Working-tree files are not a deployed release. |
| Production | Connection lane read healthy `dae0fb0`, schema `0044`; public OAuth protected-resource metadata returns 404 | Real ChatGPT OAuth acceptance cannot be claimed. |
| Public submission links | `/`, `/privacy`, `/terms` return 200; `/support` and `/review/sample-product.jpg` return 404 | Deploy the existing prerequisite and recheck every listing URL and attachment. |
| Publisher identity | `package/plugin.json` has two verified-name placeholders; legal entity name/address/governing law are null | Exact OpenAI owner organization/project and legal publisher are unresolved. Do not infer them from GitHub or a local username. |
| Reviewer materials | Five positive and three negative cases, icons, sample-photo source and deterministic ZIP builder exist; recording URL absent | Local package preparation is not a completed application. |
| Authentication | Source checks token signature/audience/client/session/role, workspace consent and revocation; Supabase public discovery is reachable | Discovery does not establish configured OAuth, a safe authorization boundary, or a working ChatGPT connection. |
| Assets | Signed image/ZIP/report links and delivered-file fidelity results exist; viewer disabled | Validate the complete chat experience before first submission. |
| Screening | Production intake version 7 remains active; version 8 live evaluation/activation is unproved | Assistant generation remains fail closed until approved evaluation and targeted activation pass. |

See [submission evidence](../ops/handoffs/phase22-submission-readiness.md) and [asset readiness](../ops/handoffs/phase22-chat-assets-readiness.md). Root owns Git, live database/dashboard writes, release proof and the user's verbatim checkpoint prompt. Every acceptance record must identify a commit, time, environment and actual outcome.

Subsequent root checkpoint: Phase 21 was saved as commits `1004a93` and `72941b2`, with final checks rerunning and a separate Phase 22 clone being prepared. These local commits do not change the production observations above.

## Official route, rechecked 2026-10-02

Retain `packages/openai-plugin/package`: the root `plugin.json`, `mcp.json` and assets use the current portable Agent Plugins format. UI/authentication belong to the MCP integration. Local installation tests the package but does not publish it. A legacy `ai-plugin.json` manifest is not this route. [Package guide](https://developers.openai.com/plugins/build/plugins)

Select the owning organization/project and verified developer identity, upload the ZIP at [Plugins](https://platform.openai.com/plugins), resolve required checks, connect/verify the production MCP server, complete review details, submit the draft, then publish the approved version. Keep reviewer credentials in the private dashboard. Track status there and feedback by email; only one review may be active. Package changes require a new ZIP; eligible hosted-tool changes use rescanning. [Submission flow](https://developers.openai.com/plugins/deploy/submission)

MCP submissions require a verified individual/business identity, submission permission and currently a global-data-residency project. Use `https://curvi.ai/api/mcp`; preserve its entire URL because official submission and maintenance pages still differ on path changes. Review duration is not promised. [MCP review requirements](https://developers.openai.com/plugins/deploy/app-review)

Final submission requires more than ZIP upload: a current production tool scan, domain proof, annotation justifications, accessible recording, exactly five positive and three negative cases, release notes and usable OAuth reviewer access. Optional screenshots require a scanned UI template; if supplied, provide one per starter prompt at 706 pixels wide and 400–860 pixels tall. [Submission errors](https://developers.openai.com/plugins/deploy/submission-errors)

Describe actual functionality and data practices accurately. Keep payment/upgrade flows out of the plugin; users may use existing entitlements. Published privacy disclosures must match returned personal data and retention. Real desktop/mobile behavior and a sample-data reviewer login are review requirements. [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)

Use Inspector and source tests to diagnose contracts, then test the actual connected and installed plugin. Record tool selection, confirmation and results. Refresh developer-mode metadata after deployment and start a fresh conversation before retesting. Browser fixtures are not ChatGPT client evidence. [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Product decisions

1. **Include the pack viewer in the first submitted experience.** This replaces Phase 19 decision 6's post-publication rollout. Existing and newly completed packs must show previews and useful downloads in ChatGPT. The assets lane proposes a dedicated `show_pack` rendering tool while retaining data-only `get_pack` for polling; root reviews the final contract. Accessible text links remain a fallback.
2. **Reuse the pipeline and ledger.** Composite the real product upload and describe stored fidelity/channel measurements precisely. Do not claim marketplace certification or perfect pixel equality. Enforce the same entitlements and optional Phase 21 budget as the web application.
3. **Estimate, then obtain explicit authorization.** Disclose requested outputs, credit hold and ceiling before `create_pack`. Require the matching signed quote and maximum credits. Read/estimate calls must not silently generate; replay must not create another hold or pack.
4. **Preserve token containment.** Prove database and Auth isolation using an approved disposable account. If Supabase cannot contain the token, keep the integration disabled and present an established-provider alternative with exact access/cost implications before provisioning it. Do not weaken authorization for a demo.
5. **Use durable, bounded progress retrieval.** Reuse jobs/scheduler and permit reopening a pack. Phase 21 outbound webhooks do not prove ChatGPT event subscription. Native MCP Events are not required for this release.
6. **Keep secrets and customer data out of the package and recording.** Use owned sample assets and a dedicated reviewer workspace. Maintain reviewer access during active review and rotate it deliberately afterward with private dashboard details updated.
7. **Public claims follow observed publication.** Leave coming-soon copy and the listing URL unchanged until actual approval, publication and directory-link verification.

## Owners

| Owner | Work | Boundary |
| --- | --- | --- |
| Root | Release integration, required tests, live SQL/dashboard actions, exact-commit proof, checkpoints | Sole live writer; coordinates outstanding action-specific approvals. |
| Connection lane | OAuth/consent/session/roles/revocation, attachment authorization, activation and containment proof | Reuse Phase 19; no secret reads, credential creation or activation during source audit. |
| Chat assets lane | Viewer lifecycle, existing packs, partial results, renewal, host fallbacks, downloads | Preserve signed-link authorization and fidelity filtering; coordinate shared files. |
| Submission lane | This plan and its handoff, official requirements, metadata/reviewer/identity readiness | Root coordinates package, legal-facts, policy and verification-log changes. |
| Independent review | Tenant/spend/link/privacy/annotation review and meaningful regression checks | No alert-state changes or failed-check bypass. |

## Acceptance matrix

No row becomes complete because code exists. Keep local, deployed, actual-client and external-decision evidence separate.

| ID | Passing behavior | Existing work / gap | Required proof |
| --- | --- | --- | --- |
| P22-01 | Coherent release and schema prerequisites | PR 6 gate pending; Phase 21 full checks ongoing | Exact SHA, CI/check URLs, migration/hash read-back, Render live SHA and healthy smoke. |
| P22-02 | Verified publisher/account | Identity placeholders and null legal facts | Nonsecret organization/project/role/residency evidence and founder-confirmed public entity details. |
| P22-03 | Secure workspace OAuth | Audience/client/session checks, consent and roles exist | Actual ChatGPT connect/refresh, workspace selection, role isolation, client-seat refusal, disconnect/reconnect. |
| P22-04 | Token containment | RLS/OAuth deny policies and hook function exist; settings/Auth probe unproved | Authorized disposable-account proof that forbidden Data API/storage/Auth operations fail and web sign-in still works. |
| P22-05 | Authorized chat attachments | Four-field file schema and SSRF-safe fetch exist | Real JPEG/PNG/WebP, size bounds, expired/missing/unsupported files, forged URL refusal and redacted logs. |
| P22-06 | Confirmed, screened generation | Quote/credit ceiling/shared reservations exist; live screening gate remains | No-spend estimate; authorized positive generation; restricted-product refusal; stale/tampered quote, replay and budget refusal without extra debit. |
| P22-07 | Durable progress/recovery | Existing queued/running/terminal jobs | Real delayed pack, bounded retrieval, new conversation, failure/cancel/partial results and no false completion or repeated generation. |
| P22-08 | Visible previews | Viewer disabled; existing-pack display/renewal/state need work | First-submission UI enabled/reviewed; desktop/mobile preview, existing-pack render, restored state and escaped content. |
| P22-09 | Image, ZIP and report delivery | Signed downloads and fidelity filtering exist | Actual ChatGPT-originated downloads; bytes/MIME/names, ZIP contents and report match delivered files. Record normal-browser fallback where the client uses it. |
| P22-10 | Expiry/revocation | Connection-bound signed links exist | Authorized refresh after expiry; disconnected/deleted-member/wrong-workspace links fail; withheld/raw assets remain inaccessible. |
| P22-11 | Accurate listing and policies | URLs/icons/cases in source; live support/photo 404; legal identity null | Final package checks, live URLs/attachments 200, approved entity/retention copy and no unsupported claims. |
| P22-12 | Complete reviewer package | Five/three cases and builder exist; account/recording absent | ZIP/version/hash, private reviewer readiness, actual case results, accessible sanitized recording and release notes. |
| P22-13 | Official draft/scan | No Phase 22 dashboard evidence | Correct account, verified domain, current tool/UI/auth scan, resolved blockers and annotation justifications. |
| P22-14 | Submitted review | Acceptance and action-time attestations pending | Plugin ID, draft/version/hash, submission timestamp and real portal status. |
| P22-15 | Review outcome/publication | External decision required | Feedback, tested corrections, approval record, Publish result, listing URL and fresh installed-user smoke. |
| P22-16 | Operational ownership | Existing scheduler/telemetry/support | Five-minute release checks, redacted incident evidence, bounded post-publication checks and rollback route. |

Source tests cannot close an actual-client row. Document missing access instead of substituting demo mode.

## Reviewer package

Keep the manifest's five positive cases: main-image check, channel/options discovery, quote-only estimate, confirmed Amazon/Shopify white pack, and Etsy/eBay pack retaining the source background. Preserve its three negative cases: listing copy, an invented cartoon without a product photo, and changing a store price. These existing prompts have not been demonstrated in the live ChatGPT client.

Augment the walkthrough/internal acceptance without increasing the manifest case count: profile/workspace consent, existing completed pack, image/ZIP/report downloads, partial completion, expired-link renewal, budget refusal and revocation. Record actual confirmations and client rendering. Never splice fixture output into a claimed production run.

Record case ID, surface/version, source/deployment SHA, UTC time, sample hash, workspace alias, tools, disclosed/approved/charged credits, fidelity/report results and redacted screenshot/clip location. Keep passwords, tokens, full signed links, customer photos and private account identifiers out of Git, public recordings and progress reports.

Retain package name `curvi`, display name `Curvi`, proposed version `1.0.0`, category `Creativity`, subtitle `Listing images from one photo`, and contact `hello@curvi.ai`. Reconcile any existing dashboard draft before selecting the final version. Both developer names come from the verified identity. Listing URLs are `https://curvi.ai`, `/privacy`, `/terms`, `/support`; channel claims remain tied to registry-backed package checks. Do not fabricate a listing, recording, reviewer account or certification.

`pnpm plugin:zip --developer-name "<actual verified publisher>"` builds locally and uploads nothing. Missing `review.demo_recording_url` currently only warns, so add or maintain an explicit final-readiness gate before calling an artifact submission-ready. Save its SHA-256, version, source SHA, entry list, validation results and live-link proof. Reviewer credentials go only into authorized private dashboard fields.

Phase 19's reviewer proposal remains one noncustomer workspace `Curvi Review`, Starter-equivalent capabilities, a bounded 300-credit grant, password login without MFA, and two sample packs. It still requires explicit account/access/credit approval. First confirm those entitlements exercise the actual listed features; propose the smallest sufficient change if not. A credit grant is not authorization for provider spending.

## Required data and action-specific approvals

Continue independent code, fixture testing and artifact preparation while root resolves this concise bundle:

- Exact OpenAI organization/project and verified publisher, individual or business; confirm submission access/global residency. Supply actual public legal name/address/governing law and approve the resulting rendered copy. Do not request credentials or identity documents in chat.
- Concrete persistent OAuth setup: selected provider/project, exact callback shown by ChatGPT, named clients, scopes, test workspace, activation switches and disposable-account containment probe. Explain persistent access; the founder may enter secrets directly in authorized dashboards.
- Dedicated reviewer account/workspace, precise entitlements and bounded grant, permission to provide its credentials privately to OpenAI, owned sample photos and reviewer-access maintenance owner.
- Numeric provider-spend ceiling and approved fixtures for screening evaluation and real generation. Root prepares estimated calls/costs and a stop condition before requesting execution.
- At final submission, the exact legal/policy attestations requiring acceptance. The submission/publication goal is already authorized and does not need another broad confirmation.

Resolve available details from authorized dashboards before asking. These gates come from the user's retained access/spend/legal constraints, not an inferred need to reconfirm routine implementation.

The parent conversation already contains the bundled identity, test/reviewer-account, OAuth, sample/workspace and spend questions; answers remain pending. Do not duplicate them. A general account approval does not authorize password changes, MFA enrollment/removal or other Auth containment mutations: prepare and obtain exact action-time scope for each such probe, with secure credential entry.

## Execution order

1. Finish Phase 21 checks and Phase 22 gaps; run required lint, types, unit, database concurrency/security, production build and browser checks on one coherent SHA. Independently review tenant access, spending, screening, delivered assets and log redaction.
2. Resolve PR 6 through its authorized security process, then merge tested dependent batches normally. Apply only reviewed additive migrations with expected-state/hash checks and read-back; do not replay/renumber existing MCP migrations.
3. Verify Render's exact merge SHA, current schema, live support/privacy/terms/sample assets, normal login and downloads. Keep assistant generation guarded and public approval claims off until their gates pass.
4. After specific access approval, configure and prove OAuth containment, exact callbacks and domain ownership. Reuse the challenge route; do not overwrite another plugin's token. Record configuration names/outcomes, never values of secrets.
5. After bounded-spend approval, evaluate screening, review results, perform only approved targeted activation, and run actual ChatGPT acceptance with the reviewer account. Record unavailable surfaces honestly and resolve through the official testing route.
6. Freeze the coherent candidate, verify current metadata/URLs, record the walkthrough, build/hash the final ZIP and prepare private review details. Submit only after actual required attestations are accepted.
7. Record status and continue through review. After actual approval, publish under existing authority, verify the listing link, update public help/features and deploy. Retest a fresh directory-installed session and supported mobile/Codex surfaces.

## Review follow-through

Keep one ledger in the handoff: plugin ID, package/version/hash, submission time, portal status, latest feedback, owner, next action and next check. During active release work, root checks CI/deployments/agents at least every five minutes, checkpoints before compaction and preserves the user's saved checkpoint prompt verbatim in its canonical location.

Record `in review`, `changes requested/rejected`, `approved` and `published` only from portal evidence. Recheck the authorized dashboard at each continuation and at an agreed cadence if a suitable authorized automation exists. Do not claim background monitoring without successful setup; until then state the next concrete dashboard check and retained owner.

For feedback, save the redacted issue reference, reproduce against the submitted SHA, assign a bounded fix, rerun affected/required release checks and deploy/rescan/repackage as applicable. Keep the approved server contract working while metadata changes wait. Root may draft a factual appeal, but sending reviewer/support email needs applicable explicit messaging authority; do not automatically appeal or cancel a review.

After publication, verify directory installation, monitor auth/queue/credit/asset failures with existing telemetry, and use the existing kill switch/rollback if access or safety regresses. Preserve data and record user impact. No new paid monitoring vendor or customer campaign is included.

## Milestone record

| Milestone | Current state | Evidence required next |
| --- | --- | --- |
| Requirements/implementation reconciled | Plan complete; lane gaps actionable | Official links and dated handoffs. |
| Source gaps and final checks | In progress | Final SHA, CI and local checks. |
| Exact release/schema deployed | Pending prerequisite gate | Deploy SHA, health and migration proof. |
| Actual ChatGPT asset journey | Pending access/screening/spend approvals | Client case record and walkthrough. |
| Final package/reviewer readiness | Pending identity and live proof | Version/ZIP/hash and private setup proof. |
| Submitted | No | Plugin ID and portal receipt. |
| OpenAI approved | No evidence | Actual decision. |
| Published and operated | No evidence | Listing, installed-session proof and next check. |

Phase 22 remains open through external review. If execution pauses, report completed artifacts, exact blocked milestone, outstanding data/approvals, last portal status and next action. Submission is not approval; approval is not publication.
