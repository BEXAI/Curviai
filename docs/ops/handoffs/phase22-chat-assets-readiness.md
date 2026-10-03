# Phase 22 ChatGPT asset readiness audit

Read-only source audit, 2026-10-02, in `/tmp/curvi-phase-21` on the Phase 21 integration branch. Source changes were intentionally excluded while the parent ran Phase 21 gates. This handoff is the only file written by this lane. No live ChatGPT conversation, OAuth connection, paid generation, credential configuration, submission, or publication was performed. Existing test names below describe coverage inspected in source, not a new test run.

## Finding

Reuse the Phase 19 MCP, attachment, quote, link, and viewer implementation. The principal code gap is that the viewer is deliberately disabled and was designed to launch after publication. Phase 22's explicit in-chat asset requirement should supersede that ordering. A few small viewer changes and real client acceptance are needed before claiming the launch works.

The current official route still uses a plugin package ZIP with a remote MCP server. The existing package is not the obsolete 2023 OpenAPI plugin format. The ZIP has root `plugin.json` and `mcp.json`, with the MCP server permanently at `https://curvi.ai/api/mcp`. Do not rebuild this as a legacy `ai-plugin.json` integration. [OpenAI submission flow](https://developers.openai.com/plugins/deploy/submission)

## Current official contracts checked

The following facts were checked against official OpenAI documentation on 2026-10-02.

- File inputs use top-level `_meta["openai/fileParams"]`. Each file schema declares required `download_url` and `file_id`, plus optional `mime_type` and `file_name`. The current Curvi schemas match. The optional `getFileDownloadUrl({ fileId })` helper refreshes host file URLs; it is not a documented API for importing arbitrary Curvi assets into the host. [Plugin reference](https://developers.openai.com/plugins/reference)
- The standard UI association is `_meta.ui.resourceUri`; component calls use the MCP Apps bridge. OpenAI-specific helpers are capability-detected fallbacks. Authoritative job state stays on the server; optional widget state is presentation state. [Build a ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- Approval-gated input may initially be absent. The host delivers it after approval. `structuredContent` and `content` reach both model and component, while `_meta` is component-only. Link opening is available through `openExternal`, with `redirectUrl: false` supported. [Plugin reference](https://developers.openai.com/plugins/reference)
- Verify the MCP endpoint independently, then developer-mode behavior, then the complete installed package. Retain evaluation prompts and results. A development connection is separate from public listing. [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- Public review requires successful developer-mode behavior and public HTTPS. Submit only the fully functioning integration intended for public availability. [MCP review requirements](https://developers.openai.com/plugins/deploy/app-review)

No consulted page established that merely returning an MCP `image` or `resource_link` guarantees a ChatGPT image card, downloadable host attachment, or a Library import. The safe implementation target is the documented MCP Apps viewer displaying Curvi previews with controlled download handoff. Native attachment behavior remains an empirical client acceptance item. Do not invent host file IDs, `sandbox:` links, or an undocumented `downloadFile` API.

## Existing implementation to preserve

| Capability | Source evidence | Readiness and limits |
| --- | --- | --- |
| Tools and schemas | `apps/web/src/lib/api-v1/mcp-tools.ts`, `mcp.ts`, `chat-views.ts` | Discovery, annotations, OAuth schemes, generated output schemas, neutral copy and compact results exist. `list_channels`, `estimate_pack`, `create_pack`, `get_pack`, `check_main_image`, and OAuth `get_profile` cover the core flow. |
| Chat attachments | `api-v1/schemas.ts:OpenAIFileObject`, `photos.ts:readPhoto`, `actions.ts:estimatePack/createPack` | `images` array and single `image` file parameter are wired. Only the temporary URL is fetched; MIME is sniffed from bytes. Limits, SSRF-safe importer, deduplication, deadlines, and neutral HEIC/missing-attachment errors exist. Actual ChatGPT file binding has not been observed. |
| Explicit credit ceiling | `mcp-tools.ts:PACK_GUARD_FIELDS`, `actions.ts:createPack`, `pack-quote.ts` | OAuth create requires signed quote plus `max_credits`. Quote binds workspace, photo bytes and choices, lasts 15 minutes, and derived replay keys prevent duplicate holds. The initial pack estimate deliberately rounds its total up in `pack-estimate.ts:474`; integer `max_credits` is consequently compatible despite 0.5-credit shot costs. No fractional-input defect is claimed. |
| Phase 21 budget | `api-v1/chat-views.ts:EstimateChat/estimateChatOf`, `actions.ts`, shared reservation function | Estimate now reports optional owner budget and refusal is shared. Test actual client wording without buying credits or changing the limit. |
| Screening | `actions.ts:createPack` sends `audience: assistant`; worker screening tests and Phase 19 handoff | Assistant runs fail closed unless the effective database intake recipe supports screening. The prior live observation was intake version 7 with version 8 absent. Safe refusal is implemented; real generation remains gated on funded screening evaluation and approved activation. |
| Durable progress | `get_pack`, `services/db.ts`, `mcp-ui/pack-viewer/runtime.ts` | Jobs live in Postgres independently of a chat turn. Viewer polls only `get_pack`, every five seconds with a 30-minute cap and bounded error retries. No model-driven infinite polling or completion notification is promised. Phase 21 webhooks are not ChatGPT MCP Events. |
| Delivered assets | `chat-views.ts:packImagesOf`, `services/db.ts:listJobFiles` | Result includes image, ZIP and report entries. Picked stored variants and delivered-file fidelity measurements are used. Channel checks and measured fidelity are distinct. No blanket exact-pixel claim. |
| Signed links | `mcp-links.ts`, `mcp-links-backend.ts`, `/api/mcp/preview/[token]`, `/api/mcp/files/[token]` | Sealed 24-hour Curvi bearer links bind connection/key, workspace, job, file and purpose. Server rechecks subject and ownership. Preview is a metadata-free JPEG up to 1024 pixels; download redirects to a named storage URL valid 15 minutes. Quotes/links require configured signing keys in production. |
| Viewer security | `mcp-ui/pack-viewer/{resource,state,render,runtime,html}.ts` | One bounded HTML resource, same-origin preview CSP, no arbitrary frames/fetches, parent-only messages, textContent rendering, validated Curvi paths, bounded carousel/fullscreen. No new framework or provider is needed. |

Links are bearer capabilities, not an interactive browser login. Source caches connection liveness for 60 seconds, and already served previews can remain in private browser cache for five minutes. An already issued storage redirect can remain usable for its 15-minute lifetime; downloaded bytes cannot be revoked. Live evidence and policy language must reflect these bounds rather than promise instantaneous erasure.

## Smallest implementation gaps

1. **Serve the viewer before submission.** `resource.ts` sets `PACK_VIEWER_LIVE=false`; `mcp-viewer.test.ts` expressly asserts no resource capability. Enable the tested resource and update those assertions plus the Phase 19 delayed-launch wording. Preserve rollback and auth boundaries. Real CSP and Scan Tools evidence must accompany publication.
2. **Render an existing pack.** Only `create_pack` carries `resourceUri`. A user opening a previous finished pack via `get_pack` currently receives structured/text links without a viewer. Add a model-visible render entry point for an existing authorized `pack_id`, or attach the resource to model `get_pack` if actual client testing confirms widget polling does not repeatedly mount cards. A separate small `show_pack` tool that reuses `packView` while leaving `get_pack` as the polling tool follows the documented separation of data and render actions and avoids that ambiguity. Never accept model-supplied signed assets as authority.
3. **Recover expired links and old conversations.** `state.ts` marks the whole viewer expired after a preview error or elapsed TTL; its expired view only displays text. Add an explicit, bounded refresh action that calls authenticated `get_pack`. On restore, preserve only a valid pack handle and presentation state, then obtain current server data; do not extend stale URL expiry by setting `linksAt=Date.now()` on an old result. Refresh must not recreate a pack or consume credits.
4. **Keep valid partial outputs visible.** Failed/canceled terminal results can carry legitimate delivered files, but `withPack` routes every non-done terminal job to the error-only view. Render the neutral terminal explanation with the server-provided delivered files and report when present, without making withheld files available or treating them as successful. A replay of a failed/canceled pack with no file list should be able to fetch its current authorized files once.
5. **Make per-file state understandable.** The viewer currently displays only a pack-level failure note; it drops `fidelity` and does not label each image's pass/fail check even though the tool result contains both. Add concise per-file channel-check wording and an honest measurement/null state or report link. ZIP and report should be clear actions, including narrow/mobile layouts. Avoid exposing raw diagnostic IDs or overstating marketplace approval.

Optional file-library selection is not required for this launch: attaching a photo in the conversation is already implemented. Add a picker only if actual attachment testing establishes a need. It would require feature detection and a separate explicit user selection; no automatic persistent Library copy is authorized.

## Acceptance matrix

All live rows remain **not performed** in this audit. Local fixtures are necessary but cannot change that status.

| Case | Existing fixture basis or smallest added test | Required real-client evidence |
| --- | --- | --- |
| Connect and select workspace | `mcp-oauth.test.ts`, `openai-interop.test.ts`, consent/connected-app tests | Correct account/workspace displayed, advertised scopes understood, no API-key prompt, authorized connection recorded, disconnect works. Auth lane owns Supabase token-isolation probe. |
| One/multiple attachments | Interop tests for two required fields, optional fields, placeholders; photo importer tests | Upload authorized sample image in ChatGPT; actual tool receives file object, multi-image order retained, expired/unsupported file yields actionable no-spend response. |
| Estimate only | `mcp-credits.test.ts` no job/storage/hold assertion | User sees exact hold/balance/budget; no generation starts. Do not equate read-only estimates with screening readiness. |
| Confirm/reject generation | Quote expiry, mismatch, foreign workspace, ceiling and replay tests | Visible credit amount before permitted create; cancel starts nothing; approved create has one job and hold; retry returns same job. Requires separately approved bounded paid run. |
| Screening and fidelity | Worker screening readiness tests, MCP screening tests, delivered-file fidelity tests | Approved screening eval and recipe activation recorded before generation. Unsafe samples are controlled test inputs; withheld assets are never downloadable and charges reconcile. |
| Running/finished viewer | Resource, state and runtime fixtures | Actual ChatGPT renders progress, then thumbnails without repeated UI creation. Model text remains useful if UI fails. Close/reopen conversation and resume status without another create. |
| Previous finished pack | New render-tool/descriptor and authorization tests | In a new turn/conversation, authorized pack handle renders previews and fresh links. Foreign pack ID yields no metadata. |
| Image download | Existing link route tests, exact bytes/disposition checks | Click from actual ChatGPT; save file with intended name, MIME and dimensions. Compare delivered bytes to the stored-file report, not recompressed preview bytes. Record whether client uses external browser or native handoff. |
| ZIP and report | Existing link and pack-file tests; UI action test | Download both through the viewer, verify expected ZIP names/count and parse report. No signed URL or token in durable evidence. |
| Expiry/refresh/revocation | New refresh/runtime recovery test plus existing signature/expiry/revocation tests | Old/invalid link gives clear state; explicit refresh yields fresh links while authorized. Revocation stops new server access within documented bounds. Retained local copies are not described as revocable. |
| Partial failure/cancellation | New state/render tests with delivered image and report | Terminal explanation remains visible beside valid delivered outputs; missing/withheld variants stay absent. No refund, regeneration or successful-delivery claim is invented. |
| Mobile/accessibility | Existing semantic buttons/status/progress; add keyboard and narrow-layout checks | Actual supported target clients: preview visibility, readable labels, keyboard focus, screenreader statuses, fullscreen fallback and download handoff. Record unavailable surfaces as unverified. |

For each live case retain date, client/surface/version, exact deployed SHA, sanitized steps, expected/observed behavior, evidence location and pass/fail. Screenshots or walkthroughs must show only authorized sample data and omit credentials and signed-link tokens. Run the package's five positive and three negative review cases through the dedicated reviewer account before submission.

## Early prerequisites for the parent to bundle

- Verified publishing identity/account and dedicated reviewer workspace are not established by source. Manifest developer names remain placeholders. The sample photo exists at `apps/web/public/review/sample-product.jpg`; its actual production reachability and authorized public review use still need evidence.
- A real signed-in ChatGPT client with developer-mode permissions and explicit authorization for any new persistent connection or OAuth registration. Do not create reviewer credentials or persistent access merely to unblock tests.
- Nonsecret confirmation that OAuth, resource audience/client setup, link signing and R2 are ready; never read or print secret values. The prior safety-isolation decision must be satisfied.
- A concrete spend ceiling, approved test images and permission for the screening eval plus bounded representative generations. Current scope excludes paid calls.
- Accessible sanitized walkthrough recording, exact submission attestations approved at action time, and deployment of the tested implementation through the parent's gated release chain. OpenAI alone controls approval.

The PR 6 CodeQL disposition gate is unchanged. No finding above justifies bypassing that gate or activating live external features without their separate prerequisites.
