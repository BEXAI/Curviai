# Phase 19: Curvi as a ChatGPT and Codex plugin

Date: 2026-10-01. Source: a founder request to list Curvi in ChatGPT, with guidance pasted from another AI assistant. Four research passes checked that guidance against OpenAI's official docs on 2026-10-01. Their notes, with a source URL and fetch time on every fact, are in `research_notes/Curvi ChatGPT app listing/` (`openai_plugin_route.md`, `plugin_auth.md`, `curvi_mcp_audit.md`, `comparables_and_directories.md`).

This file is written for the AI developer who will build it and for the founder, who owns every account step. Read it in full before the first change (CLAUDE.md rule 1). Every external fact below was read on 2026-10-01. Re-check each one and date it in docs/verification.md before relying on it (rule 7). OpenAI renamed these docs twice this year, and some pages disagree with each other; the conflicts are called out where they matter.

## Goal

A seller using ChatGPT (or Codex) attaches a product photo, says where they sell and what background they want, and gets finished Curvi images back in the chat: previews, download links and the compliance result. Curvi never redraws the product (rule 3). The plugin is tested privately in ChatGPT developer mode, then submitted, approved and published in the plugin directory that ChatGPT and Codex share. It must work on every ChatGPT and Codex surface where it is listed, because review runs the test cases there (O5).

## The verified official route

1. **Build:** a public HTTPS MCP server (Curvi already has one at `https://curvi.ai/api/mcp`) with OAuth 2.1 sign in, explicit tool annotations, output schemas and file inputs for chat attachments.
2. **Test privately:** ChatGPT Settings, Security and login, Developer mode (documented for the web only, O9); then chatgpt.com/plugins, the plus button, the MCP URL and OAuth details. Only the founder's account sees it. Connecting an MCP URL never creates a public listing. Then install the packaged plugin from a local marketplace in the ChatGPT desktop app to confirm sign in works after installation, in ChatGPT and in Codex (O8, O18).
3. **Package:** a plugin ZIP with a root `plugin.json` (listing and review fields) and `mcp.json` (one `streamable-http` server).
4. **Submit:** at https://platform.openai.com/plugins, under a verified identity, from a project without EU data residency. Upload the ZIP, fix the automated findings, connect the MCP server with OAuth credentials, prove the domain with a token at `/.well-known/openai-apps-challenge`, pass the tool scan, enter reviewer credentials in the dashboard, submit and accept the attestations.
5. **Review, then publish:** OpenAI reviews with no stated timeline. Approval is followed by a separate **Publish plugin** step. After publishing, users find Curvi by direct link or by searching its exact name; placement on the main pages is OpenAI's choice and cannot be requested.
6. **Updates:** tool changes are rescanned daily and go live after automated checks with no new version. A UI added later also ships by deploy, through the same continuous review (O5). Listing changes need a new ZIP, a new review and a new publish. The MCP origin (scheme, host, port) can never change, and this plan treats the whole URL as fixed because O3 and O5 disagree about changing the path.

### What the pasted guidance got right

Every claim held up: plugins are the current name, ChatGPT and Codex share one directory, private testing comes first, public listing needs review and approval, sign in should be OAuth rather than pasted keys, credit selling and upselling are not allowed while existing paid accounts are, and the ZIP, links, reviewer access, test cases, walkthrough, identity and domain verification and the separate publish step are all real.

### Corrections and additions (sources in the matrix below)

1. **Stricter than "typically OAuth 2.1".** ChatGPT cannot send API keys or custom headers at all, not even in developer mode. Its only auth modes are OAuth, no auth, and mixed (O1, O9). Curvi's key only server cannot be connected from ChatGPT today, even privately.
2. **"Interoperability tests" is not an OpenAI term.** The docs ask for MCP Inspector runs, a golden prompt set, testing on desktop and mobile, and exactly 5 positive and 3 negative review test cases (O1, O3, O4, O6).
3. **"Show when an operation consumes credits" is not a named rule.** The rules are "side effects should never be hidden or implicit" and annotations that match behavior (O6). This plan adopts credit disclosure as the way to meet them.
4. **The plan gate is a second problem, not only the copy.** Besides "no upselling", the guidelines say a plugin "must not provide a worse version" than the website and must not apply ChatGPT specific pricing (O6). Every Curvi plan can make packs on the web, but the MCP server is gated to Growth and up (`apiAccess`). That gate is likely a breach for the plugin (an interpretation, see founder decision 3).
5. **Missing from the guidance:** explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` on every tool; `outputSchema` for structured results; no internal ids or timestamps in results unless the privacy policy covers them; EU data residency projects cannot submit; the MCP origin is permanent; trial or demo plugins are rejected; the reviewer login must work without MFA, email codes or magic links; screenshots are no longer shown in the directory (O6) and are refused unless the tool scan reports a UI template (O4), so the first ZIP carries none; no fee is mentioned anywhere (not stated as free either).
6. **"Receive the finished assets in chat" needs a UI or links.** OpenAI documents download links in results and an MCP Apps UI (carousel). How ChatGPT renders MCP `image` or `resource_link` blocks in a plain tool result is not documented, and developers report image blocks showing only a caption (O2, O11, community reports in the research notes).
7. **Codex is looser for self configured servers.** A Codex user who adds Curvi in `config.toml` can send a bearer token from an env var, so existing `cv_live_` keys work in Codex today with no listing (O16). The directory plugin still needs OAuth.
8. **Codex is part of review.** The directory is shared, and review asks that every test case pass on the ChatGPT and Codex surfaces where the plugin is available (O5, O17). The pasted guidance names Codex only as part of the directory.
9. **Sign in must show every permission.** Users must be told every permission requested, and requests must be limited to what is needed (O6). ChatGPT asks for every OIDC scope the provider advertises (O1), which on Curvi's Supabase project includes `profile` and `phone` (live discovery, 2026-10-01), so the consent page lists what ChatGPT will receive.
10. **Private testing is web only.** Developer mode is documented for the web (O9), while the guidelines require desktop and mobile (O6). Mobile can be checked only once the plugin is installable there.
11. **Prohibited goods.** Plugins may not promote or meaningfully enable listed goods such as vapes, pepper spray or fireworks (O6). Making listing images of them is a review risk the pasted guidance does not mention (decision 16, P19-29).
12. **A token from Supabase's OAuth server is a full session token.** Supabase's own Auth API accepts it as it accepts a web session (SB1, SB4). The pasted guidance does not cover this; decision 15 and P19-12 do.

## Scope

- OAuth 2.1 sign in for the MCP endpoint, beside the existing API keys.
- Tool changes for ChatGPT: annotations, security schemes, output schemas, file inputs, credit disclosure, neutral entitlement copy, trimmed results, status text.
- Lasting previews and download links. A small MCP Apps pack viewer, built now and shipped by deploy right after the first publication (decision 6).
- Consent page, sign up inside the connect flow, Connected apps settings.
- Closing Supabase's Data API to OAuth tokens (P19-05).
- Screening for OpenAI's prohibited goods on assistant requests (P19-29).
- Privacy, terms, support and help copy; feature flags; llms.txt.
- The plugin ZIP, the submission runbook and the developer mode checklist.
- A short follow on: the official MCP Registry.

Ownership with PHASE_18, which is written in parallel: this plan owns the ChatGPT and Codex plugin, the MCP Registry listing, the `FEATURES.agentApi` flip and the agent copy in llms.txt and help. Any PHASE_18 item on these (a registry `server.json`, a ChatGPT app, a keyless MCP tool, the agentApi flip) defers to this plan; decision 2 keeps every MCP tool behind OAuth.

## Non goals

- No change to how images are made. create_pack keeps calling `Services.createJob` with `mode: "listing"`, so rule 3 holds by construction and its tests stand. The one recipe change is the intake screening in P19-29, which runs `pnpm eval` (rule 2).
- No new prices, plans or top ups, and nothing sold in ChatGPT.
- No change to the public REST API v1 or to the API key product (still Growth and up).
- No anonymous tools in the first release (founder decision 2).
- No MCP Events, no MCP tasks extension, no Sign in with ChatGPT (a limited trial for selected partners, O13).
- No dynamic client registration or Client ID Metadata Documents, so no Claude, Cursor, Smithery or Glama connectors in this phase.
- No skills in the plugin ZIP (the existing skill asks for API keys).
- No HEIC decoding; HEIC gets a clear message.

## Founder decisions

Recommended defaults, recorded 2026-10-01. The builder implements the default unless the founder changes it before the work starts. A change to an entitlement lands in the seed (rule 2).

1. **Authorization server: Supabase's OAuth 2.1 server (beta), with pre-registered ChatGPT clients.** Curvi's users already live in Supabase, it has no extra charge (users count toward MAU), and it supports PKCE S256, OIDC and static clients. Known gaps that shape the design: no CIMD, no RFC 9207 `iss` (so ChatGPT uses the per connection redirect URI), only OIDC scopes, and `aud` is `"authenticated"` unless a hook changes it. **Fallback: WorkOS AuthKit with Standalone Connect** (keeps Supabase login, supports CIMD, copies `resource` into `aud`) if the developer mode proof (P19-12) fails, or if review demands CIMD or the stable redirect. Building our own authorization server is not advised (OpenAI "strongly" recommends an established provider, O1). **Fallback triggers:** P19-12 fails; a ChatGPT style token can change the password or add an MFA factor through Supabase's Auth API (decision 15); or Codex cannot sign in with the static client (checklist step 5). WorkOS tokens are not Supabase session tokens, so Supabase's APIs refuse them.
2. **Sign in mode: OAuth for every tool.** The user signs in when they connect Curvi. `initialize`, `tools/list` and `tools/call` without a token answer HTTP 401 with the challenge; `server/discover` and `ping` stay open. This works with every MCP client and scanner, is confirmed both in developer mode and in the submission dashboard (mixed mode is confirmed only for developer mode), and leaves no anonymous surface to rate limit behind OpenAI's shared IPs. Alternative: mixed mode with an anonymous `list_channels`.
3. **Who can use the plugin: every Curvi plan, Free included, on the same credit rules as the web app.** A new seed entitlement `assistantAccess` is on for every tier. Free users get the 15 signup credits and the main image check, which uses no credits. API keys stay Growth and up, unchanged. Reason: the web form is open to every plan, and the guidelines forbid a worse version in the plugin. This reading is ours, not confirmed by OpenAI.
4. **Entitlement and credit messages: plain facts, no links in tool results.** The guidelines allow linking an informational plans page; we choose not to, which is the lowest review risk. Copy is in "Neutral messages" below.
5. **Credits are shown and confirmed before they are spent.** create_pack has `readOnlyHint: false`, so ChatGPT asks before it runs, subject to the user's own permission setting (O9 treats any tool without the read only hint as a write action). It also sets `destructiveHint: true` by choice: credits charged for images that pass their checks are spent and cannot be undone, and O5 counts "transactions you can't undo" ("being able to undo an action does not, by itself, justify setting destructiveHint to false", O6). O2 and O12 define destructive more narrowly (deleting or overwriting data); P19-01 logs the conflict. A new read only `estimate_pack` takes the same photos and choices and returns the credits and a signed quote. create_pack requires the quote and `max_credits`, and refuses any pack whose hold is above them. What is guaranteed: a pack never holds more than estimate_pack returned for the same workspace, photos and choices within 15 minutes. Whether the user saw the number depends on the model relaying it and on the confirmation prompt, which a user can set to always allow.
6. **Previews: text and links first, then the MCP Apps pack viewer right after publication.** Every result carries preview and download links, so the plugin is complete without a UI. The viewer (P19-19) is built in parallel and shipped by deploy after the first publication. UI resource references and their CSP are reviewed through continuous review, with no new ZIP (O5, "Other changes"). This takes an L item, the CSP and `ui.domain` checks, the screenshots and the mobile UI risk off the path to submission. Alternative: the viewer in the first submission.
7. **Download links last 24 hours.** Links in the chat point at curvi.ai, are signed, and mint a fresh 15 minute storage link on each click, so a link copied into a long chat still works the next day. Each link is tied to the connection or key that made it, and stops working when that connection is disconnected or the member leaves the workspace. Alternative: links that require signing in to curvi.ai in the browser.
8. **Listing: name "Curvi", subtitle "Listing images from one photo", category Creativity, every country.** Adobe, Canva, Figma and Higgsfield sit in Creativity; Business & Operations (Shopify) is the alternative. The developer identity is a business verification under the company's legal name if the company is registered, otherwise an individual verification under the founder's name; use the verified name as `author.name` for consistency. It is not enforced: the listing's developer name comes from the verified identity whatever the ZIP says (O4 `developer_name_defaulted`), and only the presence of `author.name` is checked (`plugin_developer_missing`).
9. **MCP URL: `https://curvi.ai/api/mcp`, permanently, path included.** No `mcp.curvi.ai`. O5 says the path can change in a new version, but O3 says URL changes need support and the update flow does not support them, so this plan treats the whole URL as fixed (logged in P19-01).
10. **Support and policy: a new `https://curvi.ai/support` page and hello@curvi.ai.** The founder confirms the real retention numbers for request logs and connection records before the privacy update ships (defaults in P19-23).
11. **No skills in the first ZIP.** The existing `skills/curvi/SKILL.md` asks for an API key and an unpublished CLI. An MCP based skill can come later, but an MCP server cannot be added later to a skills only plugin, so the first ZIP must carry the server.
12. **Secondary listings: the official MCP Registry only, in this phase.** Claude's directory waits for a pre-check email to mcp-review@anthropic.com (its policy 4B excludes AI image generation unless it is part of a design workflow) and for a decision on dynamic client registration. Smithery, Glama, mcp.so and Cursor are skipped for now.
13. **Capacity before publishing:** confirm `CURVI_INLINE_PACK_CONCURRENCY=2` in the Render dashboard on the 1c-2g plan (the hand made service ignores render.yaml), and watch queue time after listing.
14. **Reviewer account: one workspace on Starter, comped, with a 300 credit grant and two finished sample packs,** password login, no MFA. Starter has no API access (seed/credits.ts), so the shared login cannot make API keys, and decision 3 opens the plugin to every plan, so no test case needs Growth. The founder creates it, watches its activity, and changes the password after each review closes.
15. **Supabase's Auth API and ChatGPT tokens.** A token from Supabase's OAuth server works on Supabase's Auth API like a web session: `PUT /auth/v1/user` (password, email, metadata), `/logout`, `/factors` and `/user/oauth/grants`, with no client check (SB4 `internal/api/api.go`, `user.go`). Password reauthentication applies only to sessions older than 24 hours. P19-05 closes the Data API, and A3 turns on Secure password change and Secure email change, plus the newer "require current password" check (`update_password_require_current_password`, SB4) if the hosted dashboard offers it and /reset-password still works with it. P19-12 then probes the Auth API with a token of the same kind. **Default: if that token can change the password or add an MFA factor (the source suggests factor enrollment stays open), take the WorkOS fallback (decision 1) before building further.** Alternative: accept it in writing, with a date, keep the consent copy accurate, and record the probe results.
16. **Prohibited goods.** Default: build P19-29, so assistant requests for products in OpenAI's prohibited categories stop at intake with nothing charged. Alternative: record a dated decision accepting the review risk.
17. **Rule 2 and the MCP contract text.** Default: tool descriptions, server instructions and listing text stay in code as API documentation for outside models, pinned by tests. Every enumerated value inside them is generated from the registry and the seed, and the ZIP build checks every channel name against the live `CHANNEL_FAMILIES`. This is a recorded exception to rule 2's "prompts" wording. Alternative: move the text into a seeded table.
18. **One workspace per person per ChatGPT client.** Default: one live connection per (user, client). It covers every ChatGPT account and Codex install of that person, because Supabase creates the session only after the consent page, so the page cannot bind a workspace per session. To change workspace, the user disconnects in Connected apps and connects again. Alternative: none that Supabase supports today.

## Requirements matrix

Sources, all fetched 2026-10-01 by the research passes (exact fetch times are in the notes):

| Key | Source |
| --- | --- |
| O1 | https://developers.openai.com/plugins/build/auth |
| O2 | https://developers.openai.com/plugins/reference |
| O3 | https://developers.openai.com/plugins/deploy/submission |
| O4 | https://developers.openai.com/plugins/deploy/submission-errors |
| O5 | https://developers.openai.com/plugins/deploy/app-review |
| O6 | https://developers.openai.com/plugins/plugin-guidelines |
| O7 | https://developers.openai.com/plugins/build/mcp-server |
| O8 | https://developers.openai.com/plugins/deploy/connect-chatgpt |
| O9 | https://developers.openai.com/api/docs/guides/developer-mode |
| O10 | https://developers.openai.com/plugins/build/plugins and /plugins/concepts/plugins |
| O11 | https://developers.openai.com/plugins/build/chatgpt-ui and /plugins/concepts/ui-guidelines |
| O12 | https://developers.openai.com/plugins/guides/optimize-metadata and /plugins/guides/security-privacy |
| O13 | https://developers.openai.com/siwc/chatgpt-plugin (Sign in with ChatGPT) |
| O14 | https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt (read in Chrome; the site refuses direct fetches) |
| O15 | https://chatgpt.com/oauth/client.json (live) |
| O16 | https://learn.chatgpt.com/docs/extend/mcp (Codex configuration) |
| O17 | https://learn.chatgpt.com/docs/plugins (surfaces; the Codex CLI plugin browser) |
| O18 | https://developers.openai.com/plugins/build/plugins (local marketplace) |
| O19 | https://openai.com/chatgpt-connectors.json (ChatGPT egress ranges, listed on https://developers.openai.com/api/docs/guides/ip-addresses, which O1 links) |
| M1 | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization |
| M2 | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| M3 | https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http |
| M4 | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
| M5 | MCP Apps specification 2026-01-26 (github.com/modelcontextprotocol/ext-apps, specification/2026-01-26/apps.mdx) |
| MR1 | github.com/modelcontextprotocol/registry, docs/modelcontextprotocol-io (faq.mdx, authentication.mdx) |
| SB1 | https://supabase.com/docs/guides/auth/oauth-server (and its getting-started, oauth-flows, mcp-authentication and token-security pages) |
| SB2 | https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook |
| SB3 | https://supabase.com/docs/guides/auth/signing-keys |
| SB4 | github.com/supabase/auth master (internal/api/jwks.go, api.go, user.go, oauthserver/authorize.go, models/oauth_scope.go, tokens/service.go, conf/configuration.go, migrations) |
| L1 | Live probes of curvi.ai and the Supabase project, 2026-10-01 11:19 to 11:23 UTC (curvi_mcp_audit.md section 2) |

The review pass on 2026-10-01 re-read O1 to O9, O11, O12, O13, O17, O18, O19, M2, M4, M5, MR1, SB1 and SB4 for the findings applied here (see "Review log").

| # | Requirement | Source | Curvi today | Change |
| --- | --- | --- | --- | --- |
| R1 | Plugin ZIP: root `plugin.json` plus `mcp.json` with one `streamable-http` server; listing fields under `extensions["com.openai"].interface`; review fields under `extensions["com.openai"]` | O3, O10 | None. `skills/curvi/SKILL.md` drives the CLI with an API key | P19-25 |
| R2 | Stable public HTTPS Streamable HTTP endpoint, not a tunnel | O5, O7 | `https://curvi.ai/api/mcp` is live, POST only, stateless (route.ts:13-23, mcp.ts) | None; decision 9 |
| R3 | OAuth 2.1 per the MCP authorization spec; ChatGPT cannot present API keys | O1, O9, M1 | API keys only (api-keys/auth.ts:66-139) | P19-04 to P19-09 |
| R4 | Protected resource metadata (RFC 9728) and `WWW-Authenticate: Bearer resource_metadata="...", scope="..."` on 401 | O1, M1 | Well-known paths 404; 401 sends `Bearer realm="curvi"` (mcp.ts:343) | P19-06 |
| R5 | Authorization server metadata with `S256`; client by CIMD, DCR or static credentials | O1 | Supabase OAuth server disabled on the project ("OAuth server is disabled", L1); OIDC discovery already lists S256 | P19-04 (founder enables) |
| R6 | Verify the signature, `iss`, `aud`, `exp`, `nbf` and scopes on every call; no token passthrough | O1, O12, M1 | Nothing | P19-04 hook sets a fixed `aud` literal (Supabase checks only that `resource` is well formed and never puts it in `aud`, SB4), so the client id allowlist carries the audience binding; P19-07 |
| R7 | Per tool `securitySchemes` (mirrored in `_meta`); auth error result with `isError: true` and `_meta["mcp/www_authenticate"]` holding `error` and `error_description` | O1, O2 | None (mcp.ts:201-209) | P19-08, P19-13 |
| R8 | `readOnlyHint`, `destructiveHint`, `openWorldHint` explicit on every tool (`annotations_required`) | O4, O6, O2 | `destructiveHint` missing on get_pack, check_main_image, list_channels (mcp.ts:159, 187, 196) | P19-13 |
| R9 | `outputSchema` for every tool returning `structuredContent` | O2 | None; error bodies also go into `structuredContent` (mcp.ts:211-219) | P19-13, P19-14 |
| R10 | Chat attachments through `_meta["openai/fileParams"]`, file object declaring `download_url`, `file_id`, `mime_type`, `file_name`, requiring exactly the first two | O2 | `photos[]` with `url` or `data`, strict (api-v1/schemas.ts:24-36) | P19-15 |
| R11 | Status text `openai/toolInvocation/invoking` and `invoked`, at most 64 characters (optional) | O2 | None | P19-13 |
| R12 | Return only relevant data; no session, trace or request ids, timestamps or internal ids unless needed and in the privacy policy | O6, O5 | Pack body has `createdAt`, `productId`, shot ids and `/api/v1` links (actions.ts:153-182) | P19-14 |
| R13 | Side effects never hidden; retries safe or flagged | O6 | Description says "Holds credits like the web form"; `idempotentHint: true` with a model written key (mcp.ts:142-145) | P19-16 |
| R14 | No selling of credits or subscriptions; no plans shown, no upgrade promotion; may say a feature is not in the plan | O6 | Upsell strings reachable from MCP: manage.ts:40, services/db.ts:2199, job-copy.ts:462, services/output-options.ts:36-37, entitlements.ts:114, list_channels `upgradeTo` (actions.ts:466-467) | P19-14 |
| R15 | Not a worse version than the website; no ChatGPT specific pricing | O6 | MCP gated to Growth and up through `apiAccess` (auth.ts:112-115) | Decision 3, P19-03, P19-08 |
| R16 | Listing text (subtitle, descriptions, capabilities, prompts, release notes) carries no pricing, credit or promotion wording; tool text may say whether a call spends credits, as a side effect, but never "Free"; no "MCP" or "Plugin" in the name; display name and subtitle at most 30 characters | O6, O4 | check_main_image says "Free, uses no credits." (mcp.ts:184) | P19-13, P19-25 |
| R17 | Website, support, privacy and terms URLs, HTTPS, same publisher, all four required for MCP review | O3 | /privacy, /terms, /help answer 200; /support and /contact 404 (L1) | P19-23 |
| R18 | Privacy policy names data categories, purposes, recipients, retention timelines and controls, every user related field a tool returns (nested ones included), the OIDC claims ChatGPT receives at sign in, and the client `_meta` hints received | O6, O5, O2 | No mention of ChatGPT, OAuth, data exchanged with OpenAI or IP logging; no retention timeline for outputs or logs (privacy/page.tsx) | P19-14, P19-23 |
| R19 | Domain token served as plain text at `/.well-known/openai-apps-challenge` | O3, O4 | 404 (L1) | P19-22 |
| R20 | Verified individual or business identity; project without EU data residency; `api.apps.write` | O5, O3 | Not started | Runbook, FOUNDER |
| R21 | Reviewer login works immediately: no MFA, email or SMS codes, magic links or private network; full demo account with sample data | O3, O6 | Password sign in exists (components/marketing/auth-form.tsx:145) | Runbook, FOUNDER |
| R22 | Exactly 5 positive and 3 negative test cases, demo recording URL, release notes, countries | O3, O4 | None | P19-25, runbook |
| R23 | Works reliably on desktop and mobile, UI included | O6; O9 (developer mode is web only) | Never run against a real client (PHASE_16.md, "Needs a live run") | P19-26, checklist; mobile once installable there |
| R24 | No trial or demo plugins | O6 | `FEATURES.agentApi` still says coming soon (marketing-facts.ts:227-231) while the routes are live | P19-24 |
| R25 | Optional UI: MCP Apps resource `text/html;profile=mcp-app`, `_meta.ui.csp`, unique `_meta.ui.domain`, a versioned resource URI as a cache key (O11); screenshots no longer shown in the directory (O6) and refused without a UI template (O4) | O11, O2, O4, O6 | None | P19-19 after publication; no screenshots |
| R26 | Protocol 2026-07-28 cacheable results: `ttlMs` and `cacheScope` on `tools/list`, `resources/list`, `resources/read`, `resources/templates/list` | M2 | Absent in lib/api-v1 | P19-13 |
| R27 | Never collect restricted data such as API keys or passwords in chat | O6 | The missing key error tells the caller to send an API key (api-keys/auth.ts:50) | P19-08 |
| R28 | Optional profile tool `_meta["openai/profile"]: true` with a stable opaque `id` | O1, O2 | None | P19-11 |
| R29 | Validate `Origin`; refuse invalid ones with 403 | M3 | Refuses `https://chatgpt.com` and `https://platform.openai.com` (same-origin.ts:32-48, mcp.ts:401-403; L1) | P19-20 |
| R30 | One active review per plugin; the origin cannot change, and the path cannot either by O3 (O5 disagrees); a deleted tool leaves the published list at the next scan, while server changes apply at once; new or changed tools wait for checks | O5, O3 | n/a | Runbook, decision 9 |
| R31 | Content suits ages 13 to 17; no listed prohibited goods promoted or meaningfully enabled (for example vapes, sex toys, pepper spray, fireworks, prescription drugs, spy cameras) | O6 | Intake asks about "recalled or prohibited goods" with no definition (recipes.ts:70, 77, 86; schemas.ts:196-202); OpenAI's list is not in it | Decision 16, P19-29 |
| R32 | Logs and metrics for failed initialization and tool calls | O7 | Not separated | P19-08 |
| R33 | All test cases pass on the ChatGPT and Codex surfaces where the plugin is available | O5, O17 | Never run in Codex | Checklist, Done when |
| R34 | Users are told every requested permission; requests limited to what is needed | O6, O1 | n/a | P19-09 |
| R35 | Install the packaged plugin from a local marketplace; sign in works after installation | O8, O18 | n/a | Runbook C3b |
| R36 | Structured results also carry the serialized JSON as text | M4, O1 | Done today (mcp.ts:214) | P19-13 keeps it |

## Starting point (verified in the code on main ccbd555)

| Area | Today | Where |
| --- | --- | --- |
| Transport | Written without the MCP SDK; POST only; stateless; 2026-07-28 with `server/discover`, plus `initialize` for 2025-11-25, 2025-06-18 and 2025-03-26; header mirroring checks | apps/web/src/lib/api-v1/mcp.ts:31-35, 281-307, 400-478; app/api/mcp/route.ts |
| Tools | create_pack, get_pack, check_main_image, list_channels; annotations as in R8 | mcp.ts:137-199 |
| Descriptors | `name`, `title`, `description`, `inputSchema`, `annotations` only | mcp.ts:201-209 |
| Results | `structuredContent` is the v1 body, errors included | mcp.ts:211-219 |
| Discovery without a key | `initialize`, `server/discover`, `tools/list`, `ping` | mcp.ts:451-472 |
| Auth | `cv_live_` keys; a key acts as its maker with the maker's current role; plan gate `checkApiAccess` returns 403 `upgrade_required`; 401 is a JSON-RPC `-32001` with `Bearer realm="curvi"` | api-keys/auth.ts:66-139, backend.ts:62-92, manage.ts:31-43, mcp.ts:337-351 |
| `ApiCaller` | `keyId`, `prefix`, `scopes`, `principal`, `services`, `rateSubject`; `keyId` and `prefix` are not read anywhere outside the auth code | api-keys/auth.ts:22-31 |
| Body caps | 64,000 bytes without a valid key, 40,000,000 with one; the key is looked up before the body is read | mcp.ts:370-388, api-v1/http.ts:16 |
| Origin | No Origin, the site origin or the request host pass; anything else is 403 | lib/http/same-origin.ts:32-48 |
| Photos | `url` (https, at most 2048 characters) or base64 `data`; at most 6; fetched one after another through the SSRF safe fetch with a 15 s deadline each; JPEG, PNG, WEBP, GIF, TIFF by magic bytes; 25 MB and 80 MP caps; no HEIC | api-v1/schemas.ts:24-36, api-v1/photos.ts:137, url-import/image.ts:20, upload-validation.ts:11-23, validation/seller-inputs.ts:65 |
| Photo error copy | Written for the web form ("Choose a file") and the REST API ("GET /api/v1/channels") | url-import/image.ts:35-42, api-v1/actions.ts:274 |
| Pack view | `packOf` returns `createdAt`, `productId`, shot ids, `links.self` and `links.files` | api-v1/actions.ts:153-182 |
| Channels | `availability` `upgrade_required` with `upgradeTo` (a tier key) | api-v1/actions.ts:454-471, entitlements.ts:146-159 |
| Downloads | R2 links signed for 900 s with `Content-Disposition: attachment`; host `<account>.r2.cloudflarestorage.com` | lib/r2.ts:15, 31, 82-88 |
| Preview encoder | `shareImageJpeg` re-encodes to a bounded JPEG with no metadata | packages/pipeline/src/share-image.ts:13 |
| Credit estimate | `estimatePackCredits` is a pure function; createJob reserves its total | lib/pack-estimate.ts:395, services/db.ts:2061-2073 |
| Rate limits | IP rule checked first, then the subject; `jobs.create` 120 per IP per hour, `imports.photo` 120, `uploads.preflight` 400; get_pack and list_channels unlimited | api-v1/actions.ts:99-113, lib/rate-limit.ts:38-55 |
| Workspace of a session | `members.findFirst` with no ordering, so a user in two workspaces gets an arbitrary one | services/db.ts:537-574 |
| Sign up | Supabase trigger `bootstrap_workspace` makes a free workspace; the grant is paid on a confirmed email; email confirmation is on; `emailRedirectTo` carries `next` | migrations 0004, 0012; auth-form.tsx:123-131 |
| Post auth | `next` goes through `safeNextPath`; a freshly verified email goes to /welcome first | lib/safe-next.ts, app/auth/callback/route.ts:63-66 |
| Marketing layout | /login and /signup sit under the marketing header, which links to /pricing; /pricing buttons go to checkout for signed in users | components/marketing/site-header.tsx:6, components/marketing/pricing-tiers.tsx:113-117 |
| Middleware | Matches only `/app/:path*`, `/login`, `/signup` | middleware.ts:74-76 |
| CSP | Report only; `form-action 'self'` plus Stripe; `frame-ancestors 'none'` | next.config.ts:76-78, 100 |
| Flags and copy | `FEATURES.agentApi` coming soon with mentions `/Curvi API|public API|API keys?\b|\bMCP\b/i`; help article and llms.txt say coming soon; /app/settings/api hands out working keys and points at /api/mcp | marketing-facts.ts:227-236, help-articles.ts (AGENT_HELP_SLUG), lib/llms.ts:46-58, app/app/settings/api/page.tsx:48-74 |
| Seed | `apiAccess` live, on Growth, Pro and Agency; `backgroundSwatches` in seed/templates.ts | packages/pipeline/src/seed/credits.ts:76, 196-240; seed/templates.ts:149 |
| Libraries | `@supabase/supabase-js` and `@supabase/auth-js` 2.117.2 (have the `auth.oauth` consent and grant methods per the research); `jose` 5.10.0 only as a transitive dependency; no `@modelcontextprotocol` package | pnpm-lock.yaml |
| Capacity | Committed render.yaml: plan free, `CURVI_INLINE_PACK_CONCURRENCY` "1". The working tree has an uncommitted change to plan 1c-2g and "2". The hand made Render service ignores render.yaml | render.yaml:48-52 |
| Tests | mcp.test.ts covers transport, discovery and tools in demo mode; mcp.test.ts:98 asserts the cross site Origin refusal | apps/web/src/app/api/mcp/mcp.test.ts |
| Migrations | Latest is `0026_api_keys_client_read_only`; PHASE_18.md (in progress) claims 0027 and up provisionally | packages/db/migrations/meta/_journal.json |
| Environments | One production Supabase project (Free plan, no restorable backups) and one Render service; no staging | founder notes, render.yaml |

## Core experience design

### The conversation

1. The seller connects Curvi (once): ChatGPT opens Curvi's consent page, they sign in or create an account, pick a workspace if they have more than one, and press Connect.
2. They attach a product photo and say what they want, for example "Make Amazon and Shopify images of this on white."
3. If channels or the background are unclear, the model calls `list_channels` and asks.
4. The model calls `estimate_pack` with the attached photo and the choices, and tells the seller the credits needed and the balance.
5. The model calls `create_pack` with the quote and `max_credits`. ChatGPT asks the seller to confirm, because create_pack is not read only (O9). The tool returns at once with the pack started.
6. The model tells the seller the pack takes a few minutes and calls `get_pack` when they ask. Once the pack viewer ships (decision 6), it shows progress and polls get_pack by itself.
7. When the pack is finished, the result carries preview and download links that last 24 hours, plus the compliance result per image. Once the viewer ships, it shows the previews with a download button each.

### Tools

| Tool | What it does | readOnly | destructive | openWorld | idempotent | Status text (invoking / invoked) |
| --- | --- | --- | --- | --- | --- | --- |
| `list_channels` | Channels and sizes, bundles, backgrounds and scene styles, with what this workspace's plan includes | true | false | false | true | Reading channels / Channels ready |
| `estimate_pack` (new) | Credits a pack needs, the workspace balance and a signed quote; reads the photos' sizes; stores nothing | true | false | true | true | Counting credits / Credits counted |
| `create_pack` | Starts a pack from attached photos or links with a quote; spends credits | false | true | true | false | Starting your pack / Pack started |
| `get_pack` | Status, per image results, preview and download links | true | false | false | true | Checking your pack / Pack checked |
| `check_main_image` | Amazon main image rules check; uses no credits; stores nothing | true | false | true | true | Checking the main image / Main image checked |
| `get_profile` (new) | The account and workspace behind this connection, `_meta["openai/profile"]: true` | true | false | false | true | none |

`openWorldHint` is true for the tools that fetch a link or attachment from outside Curvi (create_pack, check_main_image, and estimate_pack, which reads the attached photos' sizes). Every tool declares `securitySchemes: [{ "type": "oauth2", "scopes": ["openid", "email"] }]` and mirrors it at `_meta.securitySchemes`. `profile` is not needed: get_profile reads the workspace name and email from Curvi's own tables. ChatGPT may still ask for every scope Supabase advertises (O1; the live project lists openid, profile, email, phone and offline_access), so the consent page shows each requested scope. Only OIDC scopes exist because Supabase rejects custom scopes (SB4); Curvi enforces permissions in its own code. `_meta.ui.visibility` is `["model"]` on every tool except get_pack (`["model", "app"]`), so the viewer can never start a pack or spend credits (M5: the host must refuse an app's call to a tool without `"app"`).

Annotation justifications, prepared for the dashboard in case it asks (O6 says they are no longer required, O4 still lists `justification_required`):
- list_channels, get_pack, get_profile: read the connected workspace's own data or Curvi's catalog; change nothing; touch nothing outside Curvi.
- estimate_pack: reads the size of each photo from a link or attachment the user provided and the workspace's balance; stores nothing and spends nothing; fetching a user supplied link is open world.
- check_main_image: reads pixels of one image from a link or attachment the user provided; stores nothing and spends nothing; fetching a user supplied link is open world.
- create_pack: starts a job and holds credits from the user's workspace. What cannot be undone: credits charged for images that pass their checks are spent. Images that fail are not charged and their hold is released. Safeguards: estimate_pack and a signed quote first, `max_credits`, and ChatGPT's confirmation because the tool is not read only. Destructive is true by choice (O5 "transactions you can't undo"). It fetches user supplied links, so open world is true. It is not idempotent: a repeat within 10 minutes replays the same pack, a later one starts a new pack.

Tool descriptions (user visible in ChatGPT, rule 9):
- **list_channels:** "Use this when the user asks which marketplaces, ad placements, sizes, backgrounds or scene styles Curvi can make. Lists what create_pack accepts and what this workspace's plan includes. Uses no credits."
- **estimate_pack:** "Use this before create_pack, with the same photos and choices, to find out how many credits the pack will use and how many the workspace has. Tell the user both numbers, then pass the quote it returns to create_pack. Uses no credits and stores nothing."
- **create_pack:** "Use this when the user wants listing or ad images made from a real product photo. Curvi cuts the product out and changes only the background, size and surroundings; it never redraws the product. Do not use it to draw or invent new images or to write listing text. This spends credits from the connected workspace, so call estimate_pack first with the same photos and choices, tell the user the number, and pass its quote and max_credits. A repeat call with the same photos and choices within 10 minutes returns the same pack without spending again. Returns at once; the pack takes a few minutes, so call get_pack when the user asks."
- **get_pack:** "Use this to see how a pack is going and to get its finished images. Returns each image's status and channel check, with preview and download links that work for 24 hours. Uses no credits."
- **check_main_image:** "Use this when the user wants to know whether a photo meets Amazon's main image rules: the longest side, a pure white background at the edges, and how much of the frame the product fills. Uses no credits and stores nothing. Do not use it to edit the photo, to draw new images or to write listing text."
- **get_profile:** "Returns the Curvi account and workspace this connection uses."

Server instructions (504 characters, all inside the first 512, O7): "Curvi turns a real product photo into marketplace and ad images. It never redraws the product; it changes only the background, size and surroundings. It does not draw new images or write listing text. To make images, pick channels and a background (list_channels), call estimate_pack with the attached photo and tell the user the credits, then call create_pack with its quote. A pack takes a few minutes; call get_pack when the user asks. check_main_image checks an Amazon main image and uses no credits."

Tool descriptions and server instructions are the MCP contract that OpenAI scans and stores per version. They are API documentation for outside models, not a Curvi recipe prompt, so they stay in code next to the schemas (as in Phase 16) where tests pin them. Every enumerated value inside them (channels, swatches, scene styles, bundles) is generated from the registry and the seed (rule 2). This reading of rule 2 is founder decision 17. A test pins the instructions wording, including that they never ask the model to loop on get_pack (today's mcp.ts:45 says "get_pack until finished is true").

### Inputs: photo, background, sizes

| Seller intent | Tool input (all existing pipeline options unless marked new) |
| --- | --- |
| The photo attached in chat | New top level `images`: array (1 to 6) of `{ download_url, file_id, mime_type?, file_name? }`, listed in `_meta["openai/fileParams"]: ["images"]`. `photos[]` (url or base64) stays for API key clients. Send one of the two. |
| A photo for the check | New top level `image` (one file object), listed in `_meta["openai/fileParams"]: ["image"]`; `url` and `data` stay. Send exactly one. |
| Where they sell (sizes) | `channels`: spec ids (`amazon.main`) or channel names (`amazon`). Sizes are the registry's: there are no free form sizes, so "1200 by 1200" maps to a spec or is refused with the list. Instagram and Facebook map to Meta through aliases kept with the channel registry (P19-18). |
| How much | `bundle`: main, listing, aplus, everything |
| Plain background | `outputOptions.color` `{ kind: "swatch", key }` with keys from `backgroundSwatches` (white, light gray, studio gray, warm white, sand, sage), `{ kind: "custom", hex }`, or `{ kind: "edge_match" }` |
| Keep the photo's background | `look: "keep_photo"` |
| Lifestyle scenes | `outputOptions.scenePreset` (auto, minimal studio, luxury marble, kitchen lifestyle, outdoor, holiday) and `sceneCount` |
| Brand colors | `{ kind: "brand", index }`, only on plans with a brand kit |
| Credit guard | New `quote` (from estimate_pack) and `max_credits` on create_pack, required for OAuth callers (the server refuses an OAuth call without them; API key callers keep today's input) |
| Retry key | `idempotency_key` becomes optional and is ignored for OAuth callers: the server always derives their key (P19-16), so a key written by the model cannot defeat replay, and its description says to leave it out. API key callers keep today's behavior. |
| Estimate | estimate_pack takes the same input as create_pack (`images`, `photos` or `productId`, plus the options). It fetches attached photos only to read their sizes and hashes, stores nothing, and is rate limited. |

`list_channels` returns the backgrounds and scene styles with labels, so the model can map "white" or "kitchen" to a value without guessing.

### Outputs, structuredContent and outputSchema

Each tool's `outputSchema` is generated from a zod "chat view" schema (zod 4 `z.toJSONSchema`, output side). Success results carry `structuredContent` that validates against it, a text block holding that same object serialized as JSON (M4; O1 asks the same of the profile tool; mcp.ts:214 does it today), and, where it helps the model, a second text block with one plain sentence. Error results carry `isError: true` and text only, never `structuredContent`, so they cannot break the schema.

Pack chat view (create_pack and get_pack):

| Field | Notes |
| --- | --- |
| `pack_id` | The handle get_pack needs. Kept, and listed in the privacy policy (P19-23). |
| `status`, `finished` | As today |
| `product` | The product title, which can come from AI analysis of the photo. Listed in the privacy policy; rendered as plain text only. |
| `channels` | Spec ids |
| `credits` | `{ held, charged }` |
| `progress` | `{ done, total }` images |
| `images` | When finished (or `include_files`): `{ name, channel, kind: image, zip or report, passes_channel_rules, fill_percent, preview_url, download_url }` |
| `links_valid_hours` | 24, instead of absolute expiry timestamps |
| `message` | One plain sentence for the model to relay |
| `error` | Neutral text or null |
| `replayed` | true when a retry returned the same pack |

Dropped from the MCP view: `createdAt`, `productId`, shot ids, `links.self`, `links.files`, per shot RGB background arrays. The REST API keeps `packOf` unchanged (its contract tests stand).

### Credits shown before they are spent

- `estimate_pack` returns `{ credits_needed, credits_available, enough, channels, left_out: [{ channel, reason }], quote, quote_valid_minutes: 15, message }`. It is computed by `estimatePackCredits` with the same inputs createJob uses, including each photo's size and angle (stored media for `productId`, image headers for attachments; createJob passes sizes through output-options.ts:231-235 and services/db.ts:2021-2026, and the planner drops kept photo shots that are too small, deterministic.ts:980-993), and the balance of the caller's workspace (never `getCurrentWorkspace`, which can pick another workspace for a multi workspace user). The quote is HMAC signed over the workspace, a canonical hash of the options, the sorted photo hashes, the credits and an expiry.
- `create_pack` refuses, inside createJob before anything is reserved, when the quote is missing, expired, or for another workspace, other photos or other options, or when the hold would exceed the quote or `max_credits`. It deletes the photos the request wrote.
- create_pack's plain text block says "Started a pack that holds N credits. You are charged only for images that pass their checks."

### Neutral messages

Every string the MCP endpoint can return comes from one MCP copy table keyed by refusal reason. The web app keeps its own copy (curvi.ai may sell plans). A test runs `rule9Problems` from packages/pipeline/src/copy-lint.ts (emoji, arrows and every dash form, including spaced and doubled hyphens) over the table, the descriptions, the instructions, the chat views and the ZIP listing fields, and adds a word list: "upgrade", "top up", "billing", "see plans", "pricing", "checkout", "subscribe", "free trial".

| Reason | Today (where) | MCP copy |
| --- | --- | --- |
| Not enough credits | "Not enough credits for this pack. Top up or pick fewer channels." (services/db.ts:2199, demo.ts:724) | "This pack needs {needed} credits and the workspace has {available}, so it was not started. Pick fewer channels or a smaller set." |
| Pack stopped for credits | "... Top up or pick fewer channels." (job-copy.ts:462) | "There were not enough credits to start this pack. Nothing was charged." |
| Over `max_credits` or the quote | new | "This pack needs {needed} credits, more than the {max} in the estimate, so it was not started. Ask for a new estimate." |
| No quote, or the quote expired or does not match | new | "This pack needs a fresh estimate. Call estimate_pack with the same photos and choices." |
| Feature not in plan (video channels) | "... Upgrade, or remove the ... channels" (entitlements.ts:114) | "{Feature} is not part of this workspace's current plan. Remove those channels to start this pack." |
| Brand colors without a kit | "... upgrade on the billing page." (output-options.ts:36-37) | "Brand colors are not part of this workspace's current plan. Pick another background color." |
| Plugin access off for a tier (if the founder ever changes decision 3) | new | "Using Curvi from ChatGPT is not part of this workspace's current plan." |
| API key without API access (MCP via key) | "... Upgrade to use them." (manage.ts:40) | "API keys are not part of this workspace's current plan." |
| Channel availability | `upgrade_required` plus `upgradeTo` (actions.ts:466-467) | `available: false`, `note: "Not part of this workspace's current plan"` (or "Coming soon") |
| No credential | "Send your Curvi API key as Authorization: Bearer <key>..." (auth.ts:50) | "Connect your Curvi account to use this." (challenge `error_description`) |
| No live connection | "Reconnect Curvi in ChatGPT and pick a workspace." (an earlier draft of this plan) | "Connect Curvi again in ChatGPT and choose a workspace." |
| Product in a prohibited category (P19-29) | new | "Curvi cannot make images of this product from ChatGPT. Nothing was charged." |
| Unknown channel | "... List them with GET /api/v1/channels." (actions.ts:274) | "Curvi does not know {names}. Call list_channels to see the channels it makes." |
| Photo link problems | "... add one with Choose a file." (url-import/image.ts:35-42) | "Photo {n} could not be read. Attach it again as a JPEG or PNG." and per reason variants without web form words |
| No attachment arrived | new | "No photo came through. Attach the product photo again and ask once more." |
| HEIC | new | "This photo is in HEIC format, which Curvi cannot read yet. Save it as JPEG or PNG and attach it again." |
| Client seat | "Client seats can review assets but cannot start packs or spend credits." | unchanged |
| Rate limit | "You are going a bit fast. Try again in N minutes." | unchanged |

### Long running packs

- create_pack returns as soon as the photos are stored and the job is queued. Photos are fetched three at a time with one 30 second deadline for the whole set, instead of up to 90 seconds today.
- No ChatGPT tool timeout is documented (O7); the target is under 10 seconds for create_pack.
- Once the viewer ships (decision 6), it polls get_pack every 5 seconds through the host's `tools/call` bridge until finished (cap 30 minutes), as Shopify and Adobe do with their poll tools. get_pack is the only tool visible to the app (`_meta.ui.visibility: ["model", "app"]`); create_pack is model only.
- Without the viewer, create_pack's message tells the model the pack takes a few minutes and to call get_pack when the user asks; the description does not invite tight loops. The server instructions say the same (Tools).
- MCP Events (`pack.completed`) is backlog: it needs subscription storage and webhook delivery, and OpenAI frames Events as user requested monitoring.
- Queue time depends on production capacity (decision 13).

### Previews and downloads

- Every image gets two links on curvi.ai, signed with HMAC and valid 24 hours: `/api/mcp/preview/{token}` (a bounded JPEG with no metadata, through `shareImageJpeg`) and `/api/mcp/files/{token}` (a redirect to a fresh 15 minute R2 link with the attachment disposition). Each token carries a key id and the connection (or API key) that made it. A click works only while that connection is live and the member is still in the workspace. Zips and the report get a download link only. Both routes ignore query parameters, because ChatGPT may append `redirectUrl` (O2).
- Once it ships, the viewer is `ui://curvi/pack-viewer/v1.html`. A breaking change gets a new URI, because ChatGPT caches by URI (O11). It loads previews from `https://curvi.ai` only (`_meta.ui.csp.resourceDomains`) and opens downloads with `ui/open-link` (M5) when the host offers it, else `window.openai.openExternal({ href, redirectUrl: false })` with `redirect_domains: ["https://curvi.ai"]` in the legacy `openai/widgetCSP` (which `_meta.ui.csp` does not cover). It shows an inline card for 1 or 2 images and a carousel for 3 to 8 (O11), with "See all N files" opening a fullscreen grid. It never shows the Curvi logo (ChatGPT adds it).
- MCP `image` content blocks are not used: their rendering is undocumented and reported broken.

## Sign in design

### Authorization server (decision 1)

Supabase's OAuth 2.1 server on the existing project. Founder settings: asymmetric JWT signing keys (ES256; required because ChatGPT will request the `openid` scope and ID tokens fail with HS256, SB1, SB3), Secure password change and Secure email change on (decision 15), OAuth server on, authorization path `/oauth/consent`, dynamic registration off, and two confidential clients named "ChatGPT developer" and "ChatGPT", each with the exact callback URL ChatGPT shows (`https://chatgpt.com/connector/oauth/{callback_id}`; the stable redirect needs RFC 9207 `iss`, which Supabase does not send, SB4). The client secrets are typed into ChatGPT and the OpenAI dashboard only. Curvi's server never needs them.

### Metadata endpoints

- `GET https://curvi.ai/.well-known/oauth-protected-resource/api/mcp` (path form, tried first by clients) and the same JSON at `/.well-known/oauth-protected-resource`:
  ```json
  {
    "resource": "https://curvi.ai/api/mcp",
    "authorization_servers": ["https://tmwvjmvzjvpeagatjmud.supabase.co/auth/v1"],
    "scopes_supported": ["openid", "email"],
    "bearer_methods_supported": ["header"],
    "resource_documentation": "https://curvi.ai/help#use-curvi-in-chatgpt",
    "resource_policy_uri": "https://curvi.ai/privacy",
    "resource_tos_uri": "https://curvi.ai/terms"
  }
  ```
  `resource` must equal the URL users paste, byte for byte (no www, no trailing slash, no redirect on POST). `authorization_servers` must equal Supabase's `issuer` byte for byte. Both come from env (`MCP_RESOURCE_URL`, `SUPABASE_AUTH_ISSUER`), defaulting to `${NEXT_PUBLIC_SITE_URL}/api/mcp` and `${NEXT_PUBLIC_SUPABASE_URL}/auth/v1`. `offline_access` is left out of the resource metadata (M1 says servers should not list it); Supabase's own metadata advertises it, so refresh tokens are still issued.
- The authorization server metadata is Supabase's own, at `https://tmwvjmvzjvpeagatjmud.supabase.co/.well-known/oauth-authorization-server/auth/v1` (404 until the founder enables the server, L1).
- The 401 challenge: `WWW-Authenticate: Bearer resource_metadata="https://curvi.ai/.well-known/oauth-protected-resource/api/mcp", scope="openid email"`, plus `error="invalid_token", error_description="..."` when a token was sent and failed.
- The tool level challenge (O1 example shape): `{ "isError": true, "content": [{ "type": "text", "text": "Connect your Curvi account to use this." }], "_meta": { "mcp/www_authenticate": ["Bearer resource_metadata=\"...\", error=\"invalid_token\", error_description=\"Connect your Curvi account to use this.\""] } }`. The plain RFC 7235 string is used; OpenAI's example wraps it in extra single quotes, which looks like a doc artifact (checked live in P19-12).

### Token verification

1. A bearer starting with `cv_` takes today's API key path, unchanged.
2. Anything else, when `MCP_OAUTH_ENABLED` is "1", is a JWT verified with `jose` against Supabase's JWKS (`{issuer}/.well-known/jwks.json`): algorithms ES256 or RS256 only (HS256 refused), `iss` equal to the issuer, `aud` equal to the resource, `exp` and `nbf` with 30 seconds of tolerance, `sub` present, `client_id` in `MCP_OAUTH_CLIENT_IDS`, `session_id` present, `scope` holds `openid` and `email` (O1, O12). P19-12 confirms the claim's shape. If Supabase leaves it out, docs/verification.md records why the check is skipped.
3. The session must still exist in `auth.sessions` (cached 60 seconds per session id). Revoking a grant deletes its sessions, so a revoked connection stops within a minute instead of at token expiry (up to 3600 seconds, SB1).
4. Tokens are never logged, never echoed and never forwarded (no passthrough, M1).
5. JWKS responses are cached by jose and by Supabase's edge (about 10 minutes each, SB3); a key rotation can lag that long, and a restart clears the local cache.

### The audience hook

Supabase checks only that `resource` is an absolute URI with no query or fragment (`validateResourceParam`), never binds it to the token, and issues `aud: "authenticated"` (SB4). A Custom Access Token hook (Postgres function, SB2) sets `aud` to the fixed literal `https://curvi.ai/api/mcp` for any token whose claims carry `client_id` (only OAuth issued tokens do). The hook does not see `resource`, so the audience binding rests on the client id allowlist. It returns every other token untouched, so web sessions keep `"authenticated"`. The hook runs on every sign in and refresh for every user, so it must be trivial and never raise: a failure would block all logins. The resource URL is a literal in the function (the URL is permanent, decision 9).

### Workspace scoping

New tenant table `mcp_connections` (rule 5): `id`, `workspace_id`, `user_id`, `oauth_client_id`, `client_name`, `profile_id`, `created_at`, `last_used_at`, `revoked_at`; one live row per (user, client) (decision 18). One binding covers every ChatGPT account and Codex install of that person on that client. The consent page writes it. Every MCP call reads it by (`sub`, `client_id`), then re-reads the membership and the workspace (as `ApiKeyBackend.principal` does for keys), so a member who leaves or a role change applies at once. Authorization never comes from tool arguments. The caller is the same `ApiCaller` the key path builds, with `kind: "oauth"`, all three internal scopes, the user's rate subject and the connection id. `profile_id` is a random 16 byte base64url value, made once per user and copied into every later row for that user, so it survives reconnects and workspace changes (O1).

If a verified token has no live row, the server creates one only when no row has ever existed for (user, client) and the user has exactly one membership (consent that finished before the row write). Every other case, including any revoked row, gets the tool level challenge "Connect Curvi again in ChatGPT and choose a workspace." That reconnect works because the consent page shows the picker whenever no live row exists. To move to another workspace while connected, the user disconnects in Settings, Connected apps, and connects again.

### Consent page

`https://curvi.ai/oauth/consent?authorization_id=...`, in its own minimal layout (no marketing header, no pricing link, `noindex`).

1. Signed out: the sign in and sign up form inline, with `next` set back to this URL (AuthForm gains a `next` prop). The /login and /signup pages are not used here, because their header links to pricing. Signed in: "Signed in as {email}" with a "Use another account" link.
2. Signed in: `supabase.auth.oauth.getAuthorizationDetails(authorization_id)`. When it returns full details, the client id comes from them. When it returns only `redirect_url` (Supabase approved because the user consented before; auth-js 2.117.2 `OAuthRedirect`), the page reads this authorization's `client_id` from `auth.oauth_authorizations` over the owner connection (columns checked in P19-12) and does not follow the link yet. The code in that link lasts 10 minutes (SB1).
3. If the client id is not in `MCP_OAUTH_CLIENT_IDS`: deny (or, on the consented path, do not follow the link) and show "Curvi does not work with this app yet, so nothing was shared." This runs before any redirect.
4. Consented path with a live row for (user, client): follow `redirect_url`. Otherwise show the page: the scopes ChatGPT asked for (from the details' `scope`, or `auth.oauth_authorizations`), and the workspace picker when the user has more than one membership (default: the live row's workspace, else the one used most recently, else the oldest).
5. Connect: re-read the membership for (user, posted workspace) and refuse if there is none; upsert the row (reusing the user's `profile_id`); then `approveAuthorization` (fresh path) or the stored `redirect_url` (consented path). Cancel: `denyAuthorization` on the fresh path; on the consented path show "Nothing was shared. You can close this page." and do not follow the link.

Consent copy (rule 9):
- Title: "Connect ChatGPT to Curvi"
- Under the title: "Signed in as {email}." and the link "Use another account"
- "ChatGPT will be able to:"
  - "Make packs in the workspace you pick. Each pack uses credits from that workspace, and Curvi tells ChatGPT how many before it starts."
  - "Read your packs and get their preview and download links."
  - "Check main images. This uses no credits."
- "ChatGPT will receive:" then one line per requested scope:
  - openid: "A private id for your Curvi account"
  - email: "Your email address"
  - profile: "Your name and picture, if your account has them"
  - phone: "Your phone number, if your account has one"
  - offline_access: "Access that stays on until you disconnect"
- When scopes beyond openid and email appear: "ChatGPT asks for these by default. Curvi does not use them."
- "ChatGPT never sees your password and cannot see your payment details. You will go back to chatgpt.com." (true once P19-05 and decision 15 are settled; P19-27 checks it)
- With a live row on another workspace: "ChatGPT now uses {workspace}. Picking another moves every ChatGPT and Codex connection on your account to it."
- Picker label: "Which workspace should ChatGPT use?"
- Buttons: "Connect" and "Cancel"
- Footer: "You can disconnect at any time in Settings, Connected apps."
- Expired request: "This connection request expired. Go back to ChatGPT and press Connect again."
- Cancel on the consented path: "Nothing was shared. You can close this page."

### Sign up inside the flow

A new user signs up on the consent page. Email confirmation is on, so they leave to click the email link; `/auth/callback` sends a `next` that starts with `/oauth/consent` straight back to the consent page, skipping /welcome. Supabase's authorization request lasts 10 minutes (`AuthorizationTTL`, SB4 `internal/conf/configuration.go`; the 10 minutes in SB1 is the code's lifetime; checked live in P19-12); if it expired, the copy above tells them to press Connect again in ChatGPT, where they are now signed in. The `bootstrap_workspace` trigger gives them a free workspace and the signup grant as on the web.

### Revocation

`/app/settings/connections` (Connected apps) lists the member's own connections (client, workspace, connected on, last used); owners and admins also see the workspace's other connections. Disconnecting your own calls `supabase.auth.oauth.revokeGrant` with the web session and sets `revoked_at`. Disconnecting a member's sets `revoked_at` and deletes that member's sessions for that client (`auth.sessions` where `user_id` and `oauth_client_id` match, over the owner connection; column checked in P19-12), so their token fails within the session cache minute and a reconnect has to pass the consent page. A revoked row is never recreated silently. The MCP server checks the live row and the session on every call.

### API keys keep working

The `cv_live_` path, the REST API v1, the CLI and Codex `bearer_token_env_var` setups keep working exactly as today, with the Growth plan gate. Only the copy an API key caller can meet through `/api/mcp` becomes neutral. With `MCP_OAUTH_ENABLED` at "0", the endpoint behaves exactly as today, which is the rollback.

### Security checklist (for the reviewer pass)

- Audience: a fixed `aud` literal set by the hook, bound by the allowlisted client ids (Supabase does not bind `resource`); scope check; ES256 or RS256 only; live session check.
- A ChatGPT token is a full Supabase user token (SB1). Data API: closed to OAuth tokens by a restrictive policy on every public table (P19-05), with RLS tests that send an OAuth shaped JWT. Without it, today's RLS would let the token read the workspace (with `stripe_customer_id`), its subscriptions and every recipe prompt, and rename the workspace (0002_security_hardening.sql:21-28, 63-66, 75). Auth API: accepts it for `/user` (password, email, metadata), `/logout`, `/factors` and `/user/oauth/grants` with no client check (SB4). Secure password change and Secure email change are on, P19-12 probes it, and decision 15 settles it.
- Dynamic registration stays off, so no lookalike client can register; redirect URIs are exact match (SB4).
- `mcp_connections` follows the api_keys pattern: members read their own rows, owners and admins read the workspace's, no client role writes; the server writes over the owner connection after its own checks.
- The consent action re-reads the membership for the posted workspace; the client allowlist runs before any redirect; the demo consent backend throws `DemoModeRefusedError` in production.
- Signed links carry a key id, the connection or key id, workspace, job, file, kind and expiry; verified in constant time; the connection must be live, the member still in the workspace, and the file still in that job and workspace.
- Our logs and Sentry carry no tokens, no signed links, no tool results and no client `_meta` hints. Link paths do reach Cloudflare and Render request logs, which is why links are tied to a live connection and expire in 24 hours.
- Failed initialize, discovery, sign in and tool calls produce redacted counters and Sentry events, by reason (O7).
- `_meta["openai/subject"]` and other client hints are never used for authorization.
- Once it ships, the viewer can call only get_pack, renders text with `textContent` only, and loads only curvi.ai URLs.
- Cloudflare does not challenge OpenAI's connector egress (O19) on the MCP and well known paths (runbook B0).

## Work items

Effort, for one agent: XS under 2 hours, S about half a day, M 1 to 2 days, L 3 to 5 days. "Migration" always means the next free number at build time (PHASE_18 may claim 0027 and up), written with `pnpm db:generate` where Drizzle can, by hand for functions and policies, with a test in packages/db.

### Workstream 1: groundwork

**P19-01 Rule 7 rows** (AGENT, S)
- docs/verification.md gains "PHASE_19: ChatGPT and Codex plugin" with one dated row per external fact this plan uses (sources O1 to O16, M1 to M3, SB1 to SB4, L1), re-fetched at build time (also O17 to O19, M4, M5, MR1 and the O12 and O13 pages), plus the conflicts: justifications (O6 against O4), plugin `description` 1,024 against 4,000 characters, developer mode plans (O9 against O14), the single quotes in OpenAI's challenge example, the destructive definition (O2 and O12 against O5), the path change (O3 against O5), deleted tool timing (O3 "after a scan" against O5 "as soon as a scan detects"), developer mode on the web only (O9) against desktop and mobile (O6), and `ui/open-link` (M5) against `openExternal` (O2).
- Record the `jose` version added in P19-07 and the Supabase Auth version the hosted project reports.
- Acceptance: every fact the code relies on has a row with URL, date and the file that uses it.

**P19-02 Shared seams** (AGENT, S; lands on `p19/integration` before any worktree starts)
- Split apps/web/src/lib/api-v1/mcp.ts into `mcp.ts` (transport, auth branch) and `mcp-tools.ts` (tool definitions, `toolList`, `toolResult`), so the auth and tools worktrees edit different files.
- `ApiCaller` gains `kind: "api_key" | "oauth"`, `keyId: string | null`, `connectionId: string | null`, `ipExempt: boolean`.
- Empty `lib/api-v1/chat-views.ts` and `lib/api-v1/mcp-copy.ts` with the exported names the worktrees fill.
- Seams for the parallel branches: `overLimit` takes the caller (P19-21 fills the body); optional file object fields in `CreatePackRequest` and `MainImageCheckRequest`; empty link and quote fields in the chat views; `resources/*` method stubs in mcp.ts behind the capability flag; a redacting MCP logger; a `get_profile` stub in mcp-tools.ts.
- Acceptance: no behavior change; every existing test passes.
- As built on `p19/integration` (wave 0), for the lanes:
  - `lib/api-v1/mcp-tools.ts` holds the tool definitions, `MCP_INSTRUCTIONS`, `MCP_TOOLS`, `findTool`, `toolList`, `toolResult` and the `GET_PROFILE_TOOL` definition. `lib/mcp-auth/profile.ts` holds the `getProfile` stub and `GET_PROFILE_LISTED` (false): P19-11 fills the one and flips the other there, so it never edits the tool list.
  - `lib/api-v1/mcp.ts` keeps the transport and the auth branch. `McpResourceProvider` and the `SERVED_RESOURCES` constant (null) are the resources seam: with a provider, the server advertises `resources`, answers the three `resources/*` methods (unknown uri: `-32602`) and checks `Mcp-Name` against `params.uri`; P19-19 sets the constant, and tests pass `deps.resources`.
  - `lib/api-v1/mcp-log.ts`: `logMcpEvent(event, fields, { level, error })` keeps only `reason`, `method`, `tool`, `status`, `auth` and `protocol`, redacted (`redactLogText`), and counts by event and reason (`mcpLogCounts`).
  - `lib/api-v1/mcp-copy.ts` holds the whole "Neutral messages" table as `MCP_COPY` (lanes wire the lines they own) and `MCP_BANNED_WORDS`.
  - `lib/api-v1/chat-views.ts` holds the view schemas from "Outputs" (`PackChat` with nullable `preview_url` and `download_url`, `EstimateChat` with `quote`, `ChannelsChat` with `aliases`, `MainImageCheckChat`, `ProfileChat`) and `CHAT_VIEW_FIELDS` for P19-23. P19-14 writes the builders.
  - `lib/api-v1/schemas.ts`: `OpenAIFileObject` (as P19-15 specifies), optional `images` on `CreatePackRequest` and `image` on `MainImageCheckRequest`. The REST document and the MCP tool arguments use `CreatePackRequestNoFiles` and `MainImageCheckRequestNoFiles`, and the actions refuse both fields (`chatFileRefused`) until P19-15 wires them.
  - `ApiCaller` has `kind`, nullable `keyId` and `prefix`, `connectionId` and `ipExempt`; `overLimit(policy, headers, caller, subject = caller.rateSubject)`.
  - `lib/mcp-signing.ts` (an addition): `parseSigningKeys` reads an `MCP_LINK_KEYS` value (first pair signs, all verify), and `signPayload` and `verifyPayload` take a purpose (`link` or `quote`), so P19-16 and P19-17 share one ring. Each of those lanes reads the env and adds it to .env.example and docs/LAUNCH_CHECKLIST.md.

**P19-03 Seed entitlement `assistantAccess`** (AGENT, S)
- packages/pipeline/src/seed/credits.ts: new `TierFeature` `assistantAccess`, `featureStatus` live, in every tier's `features` (decision 3).
- `checkAssistantAccess(plan)` in lib/entitlements.ts with the neutral copy.
- Tests: seed test (every tier has it while the decision stands); entitlement test.

### Workstream 2: sign in

**P19-04 Supabase setup and the audience hook** (FOUNDER and AGENT, M)
- FOUNDER (runbook A2, A3, B2): signing keys, OAuth server, authorization path, hook switch.
- Migration: `public.curvi_access_token_hook(event jsonb) returns jsonb`; if `event->'claims' ? 'client_id'` set `claims.aud` to `'https://curvi.ai/api/mcp'`, else return `event` unchanged; `language sql stable`, no table reads; grant execute to `supabase_auth_admin` inside a `pg_roles` check (as migrations 0002 to 0012 do for their grants), revoke from `authenticated`, `anon`, `public` (SB2).
- Tests (packages/db): a web claims event keeps `aud: "authenticated"`; an OAuth claims event gets the resource; missing or odd fields never raise; grants are exactly as above, checked against the `supabase_auth_admin` role createTestDb now makes (P19-05).
- Acceptance: after the founder enables it, web sign in and /app still work, and a decoded ChatGPT token shows `aud` equal to the resource.

**P19-05 `mcp_connections` and closing the Data API to OAuth tokens** (AGENT, M)
- Same migration: the table with a `workspace_id` foreign key and cascade, `user_id` with no foreign key (as `members.user_id`, schema.ts:168; `auth.users` does not exist in PGlite, test-helpers.ts:35-45), a `profile_id` column, unique partial index on (`user_id`, `oauth_client_id`) where `revoked_at` is null, index on `workspace_id`, RLS on, a select policy for the row's user or the workspace's owners and admins, and no insert, update or delete policy.
- Also a restrictive policy `no_oauth_clients` on every public table: `AS RESTRICTIVE FOR ALL TO authenticated USING ((auth.jwt() ->> 'client_id') IS NULL)` (the SB1 token-security pattern for keeping OAuth clients out). The MCP server uses the owner connection, so it never needs PostgREST.
- createTestDb gains the `supabase_auth_admin` role and an `auth.jwt()` shim.
- packages/db/src/schema.ts and a test file `packages/db/src/mcp-connections.test.ts`: a member reads only their rows, an admin reads the workspace's, another workspace reads none, every client role write is refused (rule 5); a JWT with `client_id` reads nothing from workspaces, subscriptions or recipes; a test walks every public table with RLS and fails when one lacks the restrictive policy.

**P19-06 Discovery documents and challenges** (AGENT, S)
- Route handlers for `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/mcp` (under `app/.well-known/`, or a next.config rewrite to `app/api/well-known/` if Next.js does not serve dot folders; check at build). Public, `Cache-Control: public, max-age=3600`, `Access-Control-Allow-Origin: *` on GET.
- `lib/mcp-auth/challenge.ts`: the header builder and the tool level challenge result.
- Env: `MCP_RESOURCE_URL`, `SUPABASE_AUTH_ISSUER` (both optional with the defaults above) in .env.example and docs/LAUNCH_CHECKLIST.md.
- Tests: exact JSON fields; `resource` and `authorization_servers` equal the configured values; header format snapshot; the tool challenge matches O1's documented shape.

**P19-07 Token verification** (AGENT, M)
- Add `jose` as a direct dependency of apps/web (current major after a rule 7 check; 5.10.0 is already in the lockfile through Trigger.dev).
- `lib/mcp-auth/verify.ts`: `verifyAccessToken(token, config)` as in "Token verification", returning claims or a typed failure (`invalid_token`, `expired`, `wrong_audience`, `unknown_client`, `session_ended`).
- Session check by `session_id` against `auth.sessions` over the owner connection, cached 60 seconds in a bounded map. If the owner role cannot read `auth.sessions` on hosted Supabase (unverified), fall back to `supabase.auth.getUser(token)`.
- Env: `MCP_OAUTH_CLIENT_IDS` (comma list), `MCP_OAUTH_ENABLED` ("0" by default).
- The scope check from "Token verification" (`insufficient_scope` failure).
- Tests with a generated ES256 key pair and a stub JWKS: valid; wrong `iss`; `aud` "authenticated"; expired; `nbf` in the future; HS256; unknown `kid`; no `client_id`; client not allowlisted; session gone; scope without email; scope claim absent.

**P19-08 One authenticator for /api/mcp** (AGENT, M)
- `lib/mcp-auth/authenticate.ts` `authenticateMcp(headers, scope)`: the API key path unchanged; the OAuth path verifies, reads the connection, the membership and the workspace, checks `assistantAccess`, and builds the `ApiCaller` (`kind: "oauth"`, `ipExempt: true`, `rateSubject: user:<id>`), touching `last_used_at` at most once a minute.
- mcp.ts: with `MCP_OAUTH_ENABLED` "1", no Authorization header on `initialize`, `tools/list` or `tools/call` answers HTTP 401 with the challenge (decision 2); a failed token answers 401 with `error="invalid_token"`; a valid token with no live row gets a row only in the one case "Workspace scoping" allows, else the tool level challenge; `server/discover` and `ping` stay open. With the flag "0", today's behavior.
- The body cap stays 64 KB for OAuth callers: their photos arrive by link.
- The no credential copy asks to connect the account, never for a key (R27).
- Redacted structured counters and Sentry events for 401s, challenges, initialize and discover failures and tool errors, by reason (O7), through P19-02's redacting logger.
- Tests: both paths; every existing mcp.test.ts case passes with the flag off; an OAuth caller cannot reach another workspace; a client seat cannot create; a removed member is refused at once; the plan check reads the seed; a revoked row is never recreated; no token, signed link or client `_meta` hint reaches the logger.

**P19-09 Consent page and sign up inside the flow** (AGENT, L)
- `apps/web/src/app/oauth/layout.tsx` (minimal), `oauth/consent/page.tsx`, `oauth/consent/actions.ts`; `lib/mcp-auth/consent.ts` behind a backend interface with a demo implementation, so e2e runs without Supabase.
- AuthForm takes an optional `next` prop. `listMemberships(userId)` reads members joined to workspaces over the owner connection.
- middleware.ts matcher adds `/oauth/:path*` for the session refresh (no redirect there; the page handles signed out users).
- app/auth/callback/route.ts: a `next` under `/oauth/consent` skips /welcome.
- next.config.ts: add `https://chatgpt.com` to `form-action` (the consent action redirects there; the CSP is report only today, so this avoids noise and a future block).
- The consented path (only `redirect_url` returned), the requested scopes rendered in plain words, the membership re-check on Connect, the client allowlist before any redirect, the "Signed in as" line, and a demo consent backend that throws `DemoModeRefusedError` in production (as `getApiKeyBackend` relies on `getServices()`, backend.ts:158-170).
- Copy as in "Consent page".
- Tests: Vitest on the action (allowlist, row before approve, deny path, expired id, picker default, a posted workspace that is not the user's is refused, the allowlist checked on the consented path, the consented path with no live row shows the picker and writes the row, the demo backend refuses production, requested scopes render); Playwright `e2e/oauth-consent.spec.ts` in demo mode: signed out shows the form and no pricing link, two workspaces show the picker, an expired id shows the expiry copy, Connect leaves for the stub redirect.

**P19-10 Connected apps** (AGENT, M)
- `apps/web/src/app/app/settings/connections/page.tsx` and actions, a link in the settings navigation, services to list and revoke.
- An admin's disconnect of a member also deletes that member's sessions for that client (Revocation).
- Copy: title "Connected apps"; a row reads "ChatGPT can make packs in {workspace} using its credits."; button "Disconnect"; notice "Disconnected. ChatGPT can no longer use this workspace, and links it already shared stop working."
- Tests: service tests (own revoke calls `revokeGrant` and sets `revoked_at`; an admin can revoke a member's; an editor cannot revoke another member's; an admin revoke stays revoked across calls; a member can reconnect through the consent page; a two workspace member reconnects and picks); Playwright `e2e/connections.spec.ts` in demo mode.

**P19-11 get_profile** (AGENT, S)
- The tool with `_meta["openai/profile"]: true`, empty input, `outputSchema` `{ id (required, non empty), name, email }` with `additionalProperties: false` (O1).
- `id` is the user's stored `profile_id` (random, never derived from a secret, never reassigned; O1 "assign an opaque ID once, persist its association"). `name` is the workspace name, `email` the user's email. The result also carries the profile serialized as JSON in a text block (O1).
- Tests: stable across refresh, reconnect and a workspace change; no raw ids; schema valid; the text block equals the structured content.

**P19-12 Developer mode proof, on a thin build** (FOUNDER and AGENT, M; the gate before the full consent page and before other branches merge)
- Deploy, dark then flipped (runbook B): P19-04 to P19-08, P19-11, P19-20 and a bare consent page (sign in, the row write, Approve and Cancel, the allowlist), with only the developer client allowlisted. Production is the only environment; developer mode connections are private to the founder's ChatGPT account.
- AGENT prepares and runs the scripted checks: the resource metadata, Supabase's discovery document, the 401 header; Cloudflare lets ChatGPT through (B0). FOUNDER does the ChatGPT steps.
- Auth API probe: with a token of the same kind, minted through a third, test only client with a fixed loopback redirect and deleted afterwards (ChatGPT's own token is never visible), try `PUT /auth/v1/user`, `/auth/v1/factors`, `/auth/v1/logout` and a PostgREST select on workspaces and subscriptions.
- Record the scopes ChatGPT requests, the `scope` claim, the `auth.oauth_authorizations` and `auth.sessions.oauth_client_id` columns, and the authorization request lifetime.
- Pass: ChatGPT connects through the static client, the consent page completes, `tools/list` and `list_channels` run, the token's `aud` is the resource, a refresh after an hour works, PostgREST returns nothing, and decision 15 is settled from the Auth API probe. Fail: take the WorkOS fallback (decision 1) before building the full consent page.

### Workstream 3: tools and the core experience

**P19-13 Tool descriptors** (AGENT, M)
- `mcp-tools.ts`: the annotations, `securitySchemes` and mirror, `outputSchema` from the chat view schemas, status text, descriptions and instructions from "Tools".
- `tools/list` (and, once the resources capability is advertised, `resources/list`, `resources/read` and an empty `resources/templates/list`) carry `ttlMs` and `cacheScope` per M2, values set after the rule 7 check.
- Every success result keeps the text block with the serialized JSON (R36); `_meta.ui.visibility` per "Tools".
- Tests: three hints present and boolean on every tool; `securitySchemes` and its mirror on every tool; `outputSchema` on every tool with `structuredContent`; status text at most 64 characters; instructions hold the flow inside 512 characters and never ask for a get_pack loop; descriptions pass the copy lint; all four cacheable methods carry both fields; every success result has a text block equal to `JSON.stringify(structuredContent)`; create_pack is model only.

**P19-14 Chat views, data minimization and neutral copy** (AGENT, M)
- `chat-views.ts`: `PackChat`, `EstimateChat`, `ChannelsChat`, `MainImageCheckChat` (the existing check body, which holds no ids), `ProfileChat`, with view builders.
- Errors: `isError: true`, text only.
- `mcp-copy.ts`: the table in "Neutral messages". createJob's insufficient credits refusal gains `creditsNeeded` and `creditsAvailable` (services/db.ts and services/demo.ts); `publicJobError` takes an audience (`"web"` or `"assistant"`) for the pack error line.
- `chat-views.ts` exports the list of every field, nested ones included, for the privacy test in P19-23.
- Tests: views hold none of the dropped fields; every success result in the existing tool tests validates against its `outputSchema`; the copy lint walks every MCP reachable string; the web copy is unchanged.

**P19-15 Photos attached in ChatGPT** (AGENT, M)
- `OpenAIFileObject` zod schema: `download_url` (https URL, at most 8,192 characters, since the length is undocumented), `file_id` (at most 256), optional `mime_type` and `file_name`; required exactly `download_url` and `file_id`; unknown keys stripped, not refused.
- create_pack and estimate_pack `images` and check_main_image `image`, each listed in `_meta["openai/fileParams"]`. The schema and descriptor parts land in p19/tools through P19-02's seams; the fetch parts stay in p19/files (Sequencing). `download_url` goes through `readPhoto` and the SSRF safe fetch unchanged; the type comes from magic bytes only; `download_url` and `file_id` are never stored or logged.
- `storePackPhotos`: three fetches at a time, one 30 second deadline for the set, order and de-duplication kept.
- A missing file argument or a placeholder string gets the "No photo came through" error; HEIC is sniffed only to give its message.
- Tests: the schema mirrors O2's rule (four properties declared, two required, neither optional one required); the documented runtime example parses; parallel order; deadline; missing file; HEIC; a `download_url` resolving to a private address is still refused.

**P19-16 Credits before spending** (AGENT, L)
- `estimate_pack` (new action in api-v1/actions.ts): input as in "Inputs", output `EstimateChat`; reads each attached photo's size, angle and hash without storing it (stored media for `productId`); uses `estimatePackCredits` with the same inputs createJob builds and a new `workspaceBalance(workspaceId)` service method that checks membership.
- The quote: HMAC signed with `MCP_LINK_KEYS` under its own prefix, over the workspace, a canonical options hash, the sorted photo hashes, the credits and a 15 minute expiry (decision 5).
- create_pack: `quote` and `max_credits`, required for OAuth callers; `CreateJobInput.maxCredits` and the quote check; refusal reasons `quote_required`, `quote_mismatch` and `over_max_credits` before `reserve_credits`, photos discarded.
- Replay: for OAuth callers the key is always derived, whatever the model sends: `mcp:` plus sha256 of (connection or key id, user id, sorted photo sha256 values, canonical body) plus the 10 minute bucket; the previous bucket's key is checked through the existing replay lookup first, so the window is at least 10 minutes (10 to 20). An API key caller's own key is still honored.
- Annotations per decision 5.
- Tests: the quote equals the hold createJob makes for the same request (the Phase 15 parity pattern), including keep_photo packs with small photos and productId packs; a stale, foreign or altered quote is refused; over the quote or `max_credits` nothing is reserved or stored; a retry replays even when the model changes `idempotency_key`; estimate stores nothing; create_pack still runs `mode: "listing"` (rule 3 path unchanged).

**P19-17 Lasting links and previews** (AGENT, M)
- `lib/mcp-links.ts`: `signLinkToken({ kid, connectionId or keyId, workspaceId, jobId, fileId, kind, exp })` and `verifyLinkToken`, HMAC-SHA256 with keys from `MCP_LINK_KEYS` (`kid:secret` pairs; the newest signs, all verify, and an old key is kept 24 hours after a rotation), constant time compare; `MCP_LINK_TTL_SECONDS` = 86,400 (decision 7).
- On each click: the connection is live (or the key unrevoked) and the membership exists (one cached read, 60 seconds), and the file still belongs to that job and workspace (`getJobFileDownload` checks only the last part today, services/db.ts:2514-2546). Routes ignore query parameters.
- `app/api/mcp/files/[token]/route.ts`: verify as above, then 302 to a fresh `presignDownload`. `app/api/mcp/preview/[token]/route.ts`: a bounded JPEG (longest side 1,024) through `shareImageJpeg`, `Cache-Control: private, max-age=300`.
- Expired or tampered token: 410 or 404 with "This link expired. Ask ChatGPT for the pack's files again."
- get_pack fills `preview_url` and `download_url`.
- Tests: tamper, expiry, another workspace, a deleted file, no EXIF in previews, the redirect target carries the attachment disposition; a revoked connection's link is refused; a removed member's link is refused; rotation keeps old links working until they expire; `?redirectUrl=` is ignored.

**P19-18 list_channels for the chat** (AGENT, S)
- Add `backgrounds` (key, label, hex from `backgroundSwatches`), `scene_styles` (values and labels from the output options), `bundles`; channels carry `available` and `note` instead of `availability` and `upgradeTo` in the MCP view (the REST body is unchanged).
- Aliases `instagram` and `facebook` map to the Meta family (marketing-facts.ts:273-284 has no instagram; expandChannels, actions.ts:128-143, returns it as unknown today), kept with the channel registry and listed by list_channels; expandChannels accepts them.
- Tests: every value comes from the seed or registry; no tier name appears; "instagram" expands to the live Meta specs.

**P19-19 Pack viewer (MCP Apps UI)** (AGENT, L; built in parallel, shipped by deploy and Rescan after the first publication, decision 6)
- Resource `ui://curvi/pack-viewer/v1.html` (a breaking change gets a new URI, O11), `mimeType: "text/html;profile=mcp-app"`, served by new `resources/list` and `resources/read` methods (and an empty `resources/templates/list`), with the `resources` capability in `server/discover` and `initialize`.
- Source in `apps/web/src/lib/mcp-ui/pack-viewer/`, built into one self contained HTML string (inline script and style, no external script, system fonts, about 50 KB budget).
- Uses the `ui/*` bridge (`ui/initialize`, `ui/notifications/tool-input`, `ui/notifications/tool-result`, `tools/call`). States: awaiting approval (no `toolInput` until `ui/notifications/tool-input`, O2), queued, running, finished, failed, link expired. An inline card for 1 or 2 images and a carousel for 3 to 8 (O11), download buttons, "See all N files" fullscreen, and "Open in Curvi" through `setOpenInAppUrl` where the host offers it (feature detected).
- `_meta.ui.resourceUri` on create_pack only (O11: a template on every call re-renders too often); the viewer polls get_pack through `tools/call`. `_meta.ui.csp` with `resourceDomains: ["https://curvi.ai"]`, no connect or frame domains; legacy `openai/widgetCSP.redirect_domains: ["https://curvi.ai"]`; `_meta.ui.domain` set to the unique value OpenAI expects (checked at build, rule 7).
- Downloads open with `ui/open-link` first, else `openExternal` with `redirectUrl: false`. Text goes through `textContent` only, never `innerHTML` (structuredContent is untrusted, O11); only curvi.ai preview and download URLs are loaded or opened.
- The plugin works without the viewer: text results always carry the links.
- Viewer copy (rule 9): "Making your images", "Waiting for your go ahead", "{done} of {total} ready", "Ready", "Download", "See all {n} files", "Open in Curvi", "Some images did not pass their checks and were not charged."
- Tests: Vitest on the viewer state machine (awaiting approval, queued, running, finished, failed, link expired), 1 and 2 image layouts, carousel bounds 3 to 8, markup and script in product, message and error never run, no URL other than curvi.ai in the HTML, size budget, the copy lint. Manual: desktop web and the desktop app, and mobile once installable there (checklist).

**P19-20 Transport** (AGENT, S)
- `isAllowedMcpOrigin`: no Origin, this site, `https://chatgpt.com`, `https://platform.openai.com`; anything else 403 (M3 allows an allowlist; the endpoint uses no cookies, so the CSRF concern of same-origin.ts does not apply).
- An OPTIONS handler with CORS for those origins: allow `Authorization`, `Content-Type`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`; expose `WWW-Authenticate`.
- Tests: update mcp.test.ts:98 (an unknown site is still refused; ChatGPT's origin passes); preflight headers.

**P19-21 Rate limits** (AGENT, S)
- `overLimit` takes the caller: `ipExempt` callers skip the IP rule (all ChatGPT traffic arrives from OpenAI's egress IPs) and are counted per user and per workspace.
- New policies in lib/rate-limit.ts: `mcp.read` (get_pack, list_channels, get_profile; 1,200 per user and 2,400 per IP an hour) and `mcp.links` (preview and file routes; 600 per IP and 600 per connection or key an hour, not per workspace, so one leaked link cannot use up the owner's budget). estimate_pack fetches photos, so it counts against `imports.photo` per user.
- Tests: OAuth callers never share an IP bucket; key callers keep today's rules; polling inside the limit passes; one connection's link traffic never blocks another's.

**P19-29 Prohibited goods for assistant requests** (AGENT, M; numbered last so earlier ids stay stable; decision 16)
- A new intake recipe version in packages/pipeline/src/seed/recipes.ts asks for a `restrictedCategory` drawn from OpenAI's prohibited goods list (O6: for example nicotine vapes, sex toys, pepper spray, fireworks, prescription drugs, drug paraphernalia, spy cameras). The list is seeded (rule 2). IntakeResult gains a matching optional field with a default, so older answers stay valid. Today's prompt asks only about "recalled or prohibited goods" with no definition (recipes.ts:70, 77, 86; flags in schemas.ts:196-202).
- For requests from the assistant, a set category stops the pack at intake, nothing is charged, and the neutral copy is returned. The web keeps today's behavior unless the founder decides otherwise.
- `pnpm eval` runs with golden negatives (a vape, a pepper spray, a firework) and shows no regression on the existing set.
- Tests: the schema default keeps old answers valid; the assistant audience refuses; the web audience is unchanged.

### Workstream 4: site, policy and copy

**P19-22 Domain verification route** (AGENT, XS)
- `/.well-known/openai-apps-challenge` returns `OPENAI_APPS_CHALLENGE_TOKEN` as `text/plain` with nothing else, 404 when unset. Env in .env.example.
- Test: exact body, content type, 404 without the env.

**P19-23 Privacy, terms and support** (AGENT drafts, FOUNDER approves, S)
- Privacy (app/(marketing)/privacy/page.tsx), new section "Using Curvi from ChatGPT and other assistants": "When you connect Curvi to ChatGPT or another assistant, the assistant receives a private id for your Curvi account and your email address when you sign in, plus any other sign in details it asks for, which the connect page lists. For each request we receive a sign in token for your Curvi account, the photos you attach, the choices the assistant sends, and hints the assistant adds: your language, an approximate location (city, region, country, time zone and rough coordinates), the app or browser in use, and anonymous ids for you, the conversation and your organization. We do not store these hints. We do not receive your conversations. We send back your account email and workspace name, product titles, pack ids, pack status and credits used, your workspace's credit balance, image check results, image previews and download links, and OpenAI receives them. Connection records stay until you disconnect or close your account. Request logs, which include IP addresses, are kept for {N} days. You can disconnect at any time in Settings, Connected apps." Plus retention timelines for outputs and logs in "Retention and deletion", and OpenAI named as a recipient of tool results you request. {N} is founder decision 10. The hint list follows O2's client `_meta` fields.
- Terms (app/(marketing)/terms/page.tsx): "Connected assistants: you can connect Curvi to an assistant such as ChatGPT. Actions it takes in your workspace with your permission count as yours, and credits it spends are charged the same way as in the app."
- New `app/(marketing)/support/page.tsx`: "Need help? Email hello@curvi.ai and we answer within two business days. Include your workspace name and, for a pack, the pack id ChatGPT showed you." Plus links to /help and Connected apps. The response time is a founder confirmation.
- Tests: pages answer 200; the claims e2e still passes; "Last updated" dates move; a field list next to the privacy copy (`assistant-fields.ts`) covers every chat view field from P19-14, nested ones included, and every entry appears in the copy.

**P19-24 Flags, help and llms.txt** (AGENT, S)
- `FEATURES.agentApi` flips to live in wave 4, after the P19-27 reviewer pass (PENDING item 7; the API and MCP server are already live; R24).
- New `FEATURES.chatgptPlugin`, coming soon, mentions `/\bin ChatGPT\b|ChatGPT (plugin|app)/i`; flipped only after publishing.
- The agent article (`AGENT_HELP_SLUG`, help-articles.ts:37, 106-114) stays, rewritten for an API and MCP server that are live and a CLI and skill that are coming soon. A new article `use-curvi-in-chatgpt` sits beside it: connect, what it can do, credits, disconnect; a short "Codex with an API key" section (`[mcp_servers.curvi] url = "https://curvi.ai/api/mcp"`, `bearer_token_env_var = "CURVI_API_KEY"`, Growth and up). Until `chatgptPlugin` is live the ChatGPT part is worded as coming soon by the flag.
- lib/llms.ts and the settings API page (ChatGPT needs no key; the Codex snippet).
- Tests: the claims test with both flags; help and llms snapshots; seo.test.ts (354-356) and llms.ts (126) keep the agent slug.

### Workstream 5: package, tests and review

**P19-25 Plugin package** (AGENT, S)
- New private workspace package `packages/openai-plugin`: `package/plugin.json`, `package/mcp.json`, `package/assets/logo.png` (from apps/web/public/brand/curvi-mark-512.png), `package/assets/composer-icon.png` (from curvi-mark-192.png), and no screenshots (decision 6, O4, O6); `src/build.ts` validates and zips with `archiver` (already a dependency) to `dist/curvi-<version>.zip` (gitignored); root script `pnpm plugin:zip`.
- The build fails on: a field over its limit (30, 30, 4,000, 1,024 root description, 120 per capability, 128 per prompt), not exactly 5 positive and 3 negative cases, a non https URL, `test_credentials` or `reviewer_instructions` keys, hooks or `.app.json` references, the placeholder developer name, a brand color under 2:1 contrast against white or `#212121`, an asset that is not square or under 48 px, the ZIP limits, a `screenshots` field, any `rule9Problems` finding or a price or credit word ("credit", "free", "price", "trial", "discount") in a listing field, and a channel name in longDescription or capabilities that is not a live `CHANNEL_FAMILIES` name (or the lines are generated from it; decision 17).
- Contents are in "Submission runbook". `src/manifest.test.ts` runs the same checks in `pnpm test`.

**P19-26 Interoperability and end to end tests** (AGENT, M)
- `apps/web/src/app/api/mcp/openai-interop.test.ts`, replaying the documented shapes: `initialize` without a token gets 401 with `resource_metadata`; the metadata document; a token; `tools/list` with every documented field; `tools/call` with the file object from O2; the tool level challenge from O1; the profile shape. One 2026-07-28 client and one `initialize` client both pass; an API key client still passes.
- Playwright: oauth-consent, connections, /support, the help article.
- The golden prompt set (the 5 positive and 3 negative cases plus 10 more phrasings, a fixture for every negative case, and the P19-29 negatives: a vape, a pepper spray) is stored in packages/openai-plugin as fixtures for the manual developer mode runs (O7, "optimize metadata").

**P19-27 Reviewer pass** (AGENT, S)
- The reviewer agent (.claude/agents/reviewer.md) on lib/mcp-auth, the consent and connections pages, the hook, `mcp_connections` RLS, the restrictive `no_oauth_clients` policy, the consent guards, link revocation, the link tokens, rate limits, logging and its redaction, Origin and CORS, and decision 15's probe results, against the security checklist. It also covers the open Phase 16 workstream 5 review (PENDING item 6) for the MCP path. Fix every finding before the production deploy.

### Workstream 6: secondary listings (follow on)

**P19-28 Official MCP Registry** (AGENT prepares, FOUNDER publishes, S)
- `packages/openai-plugin/registry/server.json`: `$schema` per the registry's current schema URL (rule 7), `name` `ai.curvi/curvi`, `title` "Curvi", `description` "Marketplace and ad images from a real product photo. The product is never redrawn." (under 100 characters), `version`, `remotes: [{ "type": "streamable-http", "url": "https://curvi.ai/api/mcp" }]`.
- Route `/.well-known/mcp-registry-auth` serving `MCP_REGISTRY_AUTH` (the `v=MCPv1; k=ed25519; p=...` line) as text.
- FOUNDER: make an Ed25519 key with OpenSSL 3 (macOS LibreSSL cannot: `brew install openssl@3`, then `/opt/homebrew/opt/openssl@3/bin/openssl`, MR1), set the env, run `mcp-publisher login http --domain curvi.ai --private-key "$PRIVATE_KEY"`, then `mcp-publisher publish`. Versions are immutable, and a server can only be hidden with status `deleted`, so publish only after the production OAuth deploy.
- Not in this phase: Claude's directory (after the Anthropic pre-check), Smithery and Glama (they expect CIMD or DCR), Cursor (curated, open source only), mcp.so (repository URL).

### Effort summary

| Workstream | Items | Effort |
| --- | --- | --- |
| 1 Groundwork | P19-01 S, P19-02 S, P19-03 S | 1.5 days |
| 2 Sign in | P19-04 M, 05 M, 06 S, 07 M, 08 M, 09 L, 10 M, 11 S, 12 M | 14 days |
| 3 Tools | P19-13 M, 14 M, 15 M, 16 L, 17 M, 18 S, 19 L (after publication), 20 S, 21 S, 29 M | 17 days |
| 4 Site | P19-22 XS, 23 S, 24 S | 1.5 days |
| 5 Package and review | P19-25 S, 26 M, 27 S | 2.5 days |
| 6 Secondary | P19-28 S | 0.5 days |
| Total | 29 items | about 37 agent days at the middle of each size. The critical path (wave 0, p19/auth, the spike, P19-12, the full consent page, wave 4) is about 14.5 agent days at the low end of each size and 19 at the middle, so about 3 to 4 weeks of calendar time with the other branches alongside, plus founder steps (identity verification, ES256 migration, Cloudflare, reviewer account, demo video) and OpenAI's review time (unknown; developers report 3 to 6 weeks). The viewer is off this path (decision 6). |

## Data model summary (one migration, next free number at build time)

- Number: `0028` (`0027_site_visits` comes from the site-visitors branch, merged into `growth/base` under `p19/integration`; PHASE_18 renumbers after 0028).

- New tenant table `mcp_connections` with `workspace_id`, `profile_id`, RLS and a test (rule 5).
- New function `public.curvi_access_token_hook(jsonb)` with its grants (inside a `pg_roles` check).
- The restrictive `no_oauth_clients` policy on every public table, with a test that walks them. No new columns on existing tables. Supabase keeps OAuth clients, grants and sessions in its own auth schema.
- createTestDb gains the `supabase_auth_admin` role and an `auth.jwt()` shim.
- Code seed: `assistantAccess` in every tier; a new intake recipe version and the seeded list of OpenAI's prohibited categories (P19-29). No new price, model id or channel spec (rule 2).

## Environment variables

| Name | Where | Purpose | .env.example |
| --- | --- | --- | --- |
| `MCP_OAUTH_ENABLED` | web | "1" turns on the OAuth path and the 401 on unauthenticated discovery; "0" is today's behavior and the rollback | `MCP_OAUTH_ENABLED=0` |
| `MCP_RESOURCE_URL` | web | Canonical resource, default `${NEXT_PUBLIC_SITE_URL}/api/mcp` | empty |
| `SUPABASE_AUTH_ISSUER` | web | Default `${NEXT_PUBLIC_SUPABASE_URL}/auth/v1` | empty |
| `MCP_OAUTH_CLIENT_IDS` | web | Comma list of the Supabase client ids for ChatGPT | empty |
| `MCP_LINK_KEYS` | web | Link and quote signing keys as `kid:secret` pairs; the newest signs; keep an old key 24 hours after a rotation | empty |
| `OPENAI_APPS_CHALLENGE_TOKEN` | web | Domain verification token | empty |
| `MCP_REGISTRY_AUTH` | web | Registry proof line (follow on) | empty |

Each is added to .env.example and docs/LAUNCH_CHECKLIST.md (rule 8). No secret is committed.

## Tests (summary)

| Package | Tests |
| --- | --- |
| packages/db | Hook function cases and grants; `mcp_connections` RLS; the restrictive policy walk and OAuth JWT reads |
| packages/pipeline | `assistantAccess` in the seed; the P19-29 intake recipe and its schema default |
| apps/web unit | Resource metadata and challenges; token verification table with the scope check; authenticator (both paths, flag off equals today); consent action and its guards; scope rendering; connections service; tool descriptors (hints, schemes, output schemas, status text, instructions, visibility); chat views and schema validation; copy lint; privacy field coverage; file object shape and photo fetch; quote and hold parity; `max_credits`; derived replay key; link tokens and routes, revocation and rotation; logger redaction; list_channels from seed and channel aliases; viewer state machine; Origin and CORS; rate limits |
| apps/web interop | openai-interop.test.ts (documented OpenAI and MCP shapes, both protocol generations, API keys) |
| packages/openai-plugin | manifest.test.ts (every submission limit) |
| e2e | oauth-consent, connections, support, help article; existing specs unchanged |
| Manual | MCP Inspector with an API key; the developer mode checklist on desktop web; the local marketplace install in the desktop app (ChatGPT and Codex); iOS, Android and Codex CLI after publishing |

## Submission runbook

FOUNDER steps need the founder's accounts, money or credentials. AGENT steps are code or text the builder prepares. Agents never create accounts and never type credentials into production or into OpenAI's dashboard.

### A. Before the build (FOUNDER)

- **A1 FOUNDER:** confirm or change the founder decisions above.
- **A2 FOUNDER:** Supabase, Project Settings, JWT signing keys. If the project still signs with the legacy HS256 secret, migrate to ES256 with the standby key flow, at a quiet time (the project is on the Free plan with no restorable backups). Then sign in to curvi.ai in a private window to confirm.
- **A3 FOUNDER:** Supabase, Authentication, OAuth Server: enable it, set the authorization path to `/oauth/consent`, leave dynamic registration off. Check Authentication, URL Configuration: Site URL `https://curvi.ai`. Turn on Secure password change and Secure email change in the Auth settings, and "require current password" if offered, then check /reset-password in a private window (decision 15).
- **A4 FOUNDER:** platform.openai.com, Settings, Organization, General: start business verification (company name) or individual verification (your name) now, since review of the identity can take time. Confirm you are an organization owner (`api.apps.write`) and that the project you will use has global data residency, not EU.
- **A5 FOUNDER:** in ChatGPT, check that Settings, Security and login shows Developer mode on your plan. The docs disagree on write tools for Plus and Pro (O9 against O14). If create_pack is blocked as a write tool on your plan, test it in a ChatGPT Business workspace.

### B. Developer mode proof (P19-12)

- **B0 FOUNDER (AGENT prepares):** Cloudflare: confirm that bot fight mode, AI crawler blocking and WAF rules skip `/api/mcp`, `/api/mcp/*` and `/.well-known/*` for OpenAI's connector egress (O19). Record any skip rule in docs/verification.md.
- **B1 FOUNDER:** apply the migration in the Supabase SQL editor (the agent hands over the SQL and a PGlite dry run, as for earlier migrations).
- **B2 FOUNDER:** Supabase, Authentication, Hooks: enable Custom Access Token with `public.curvi_access_token_hook`. Sign in to curvi.ai in a private window and open /app. If sign in fails, turn the hook off at once and tell the agent.
- **B3 FOUNDER:** Render env `MCP_OAUTH_ENABLED=1` on the dark build already on main (P19-04 to P19-08, P19-11, P19-20, the bare consent page). Render restarts the service, which settles running packs and returns their holds, so do it at a quiet time.
- **B4 FOUNDER:** ChatGPT, Settings, Security and login, Developer mode on. Open https://chatgpt.com/plugins, press plus, name "Curvi (dev)", description "Curvi developer connection", MCP URL `https://curvi.ai/api/mcp`, authentication OAuth. Note the callback URL ChatGPT shows (`https://chatgpt.com/connector/oauth/...`).
- **B5 FOUNDER:** Supabase, Authentication, OAuth Apps: create a confidential client "ChatGPT developer" with exactly that callback URL. Copy its client id and secret into ChatGPT's dialog. Add the client id to Render env `MCP_OAUTH_CLIENT_IDS`. If ChatGPT needs the client id before it shows the callback, create the client with a placeholder redirect first, then replace it.
- **B6 FOUNDER and AGENT:** run "Verifying the live connection" below and record the results in docs/verification.md.

### C. Package and site (AGENT, then FOUNDER approves)

- **C1 AGENT:** every item except P19-19 and P19-28 merged, the rule 6 gate green, the reviewer pass clean.
- **C2 FOUNDER:** deploy; flip nothing else yet.
- **C3 AGENT:** `pnpm plugin:zip` with the contents below (no screenshots).
- **C3b AGENT and FOUNDER:** copy the built plugin folder under `~/.codex/plugins/` and point an entry in `~/.agents/plugins/marketplace.json` at it (O18), restart the ChatGPT desktop app, install the plugin from its Plugins Directory, connect through OAuth, and run the 5 positive cases in ChatGPT and in Codex in the desktop app (O8, O18).
- **C4 FOUNDER:** record the demo video (script below) on desktop web from the developer mode connection and in Codex in the desktop app from the C3b install. Record on the iOS app only if the draft is reachable there. Upload it unlisted (YouTube or Loom) and give the URL to the agent for `review.demo_recording_url`; rebuild the ZIP.

### D. Reviewer account (FOUNDER)

- **D1 FOUNDER:** create a mailbox or alias such as review@curvi.ai. Sign up at https://curvi.ai/signup with a strong password and confirm the email. No MFA.
- **D2 FOUNDER:** set the workspace name to "Curvi Review", put it on Starter without charge (no API access, decision 14) and grant 300 credits through the SQL editor (the agent drafts the SQL; you run it). Keep it to one workspace so the consent page shows no picker.
- **D3 FOUNDER:** make two packs in the browser: Amazon main and Shopify on white, and a Meta feed image with a kitchen scene.
- **D4 FOUNDER:** connect this account once in developer mode (in a separate ChatGPT account or after disconnecting yours) to confirm it works with no extra step.
- **D5 FOUNDER:** keep it funded. Watch its activity. Change the password after each review closes and update Review details at the same time; keep it unchanged while a review or update is open (OpenAI rescans daily).

### E. Submit (FOUNDER)

- **E1:** https://platform.openai.com/plugins, Upload new or existing plugin, pick the verified developer identity, Upload plugin, choose the ZIP.
- **E2:** fix any Metadata findings with the agent, rebuild, re-upload.
- **E3:** MCPs, Connect. MCP Server URL `https://curvi.ai/api/mcp`; Authentication OAuth. Create a second Supabase client "ChatGPT" with the callback URL this drawer shows, enter its client id and secret, add its id to `MCP_OAUTH_CLIENT_IDS`. Domain verification: copy the token into Render env `OPENAI_APPS_CHALLENGE_TOKEN`, wait for the restart, open https://curvi.ai/.well-known/openai-apps-challenge and check it shows exactly the token, then verify.
- **E4:** wait for the tool scan; fix findings with the agent (annotations, schemas, CSP). Tool fixes need only a deploy and Rescan.
- **E5:** Review information, Review details: login URL `https://curvi.ai/login`, the reviewer email and password, workspace "Curvi Review", and the instructions text below.
- **E6:** Submit for review and accept the attestations. One review at a time; Cancel Review to replace it.
- **E7:** wait. There is no timeline and support will not expedite. Reply to a rejection email with the fix.
- **E8:** after approval, open the approved version and press **Publish plugin**. Then the agent flips `FEATURES.chatgptPlugin` and adds the listing link to the help article and llms.txt; you deploy. Coordinate any press with press@openai.com first (O5). Then, on iOS, Android and Codex CLI (installed from the directory), run the 5 positive cases and fix anything by deploy. Deploy the viewer (P19-19) and Rescan.

### Prepared answers

`mcp.json`:
```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": { "curvi": { "type": "streamable-http", "url": "https://curvi.ai/api/mcp" } }
}
```

`plugin.json` root: `$schema` `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`; `name` `curvi`; `version` `1.0.0`; `description` "Make marketplace and ad images from a real product photo. The product is never redrawn."; `author` `{ name: <verified developer name>, email: "hello@curvi.ai", url: "https://curvi.ai" }`; `homepage` `https://curvi.ai`.

`extensions["com.openai"].interface`:

| Field | Value |
| --- | --- |
| displayName | Curvi |
| shortDescription | Listing images from one photo |
| developerName | the verified developer name (OpenAI overwrites it from the identity) |
| category | Creativity |
| websiteURL | https://curvi.ai |
| supportURL | https://curvi.ai/support |
| privacyPolicyURL | https://curvi.ai/privacy |
| termsOfServiceURL | https://curvi.ai/terms |
| brandColor, brandColorDark | from the site's brand tokens, checked by the build |
| logo, composerIcon | `./assets/logo.png`, `./assets/composer-icon.png` |
| screenshots | none (not shown in the directory, O6; refused without a UI template, O4) |

longDescription (the channel names are generated from `CHANNEL_FAMILIES` and checked by the build, decision 17; no credit or price wording, R16):

> Curvi turns one product photo into images that fit each store's rules. Attach a photo of your product and say where you sell: Amazon, Shopify, Walmart, Etsy, eBay, TikTok Shop, Google Merchant, Pinterest or Meta ads. Curvi cuts the product out and changes only the background, size and surroundings. The product itself is never redrawn, so labels, logos and colors stay exactly as photographed.
>
> Pick a plain background such as white or warm white, keep your photo's own background, or add lifestyle scenes in a style you choose. Every image is checked against its channel's size and background rules, and Curvi tells you which images pass. You see previews in the chat and download the files you want.
>
> Curvi can also check whether a photo meets Amazon's main image rules.
>
> You need a Curvi account, and you can create one when you connect.

capabilities:
- "Makes marketplace images from your own product photo without redrawing the product"
- "Sizes images for Amazon, Shopify, Walmart, Etsy, eBay, TikTok Shop and Google Merchant" (generated from `CHANNEL_FAMILIES`)
- "Makes ad images for Meta, Pinterest and TikTok placements" (generated from `CHANNEL_FAMILIES`)
- "Plain color, kept photo or lifestyle scene backgrounds"
- "Checks every image against its channel's size and background rules"
- "Checks a photo against Amazon's main image rules"

defaultPrompt:
- "Make Amazon and Shopify listing images from this product photo on a white background."
- "Does this photo meet Amazon's main image rules?"
- "Make a Meta feed image for Instagram and a Pinterest pin of this product in a kitchen scene."

`review.test_cases.positive` (each attaches a sample product photo through `file_attachment_urls`, a JPEG the agent adds under apps/web/public/review/):

| # | description | prompt | tools_triggered | expected_behavior |
| --- | --- | --- | --- | --- |
| 1 | Check a main image | "Is this photo OK as an Amazon main image?" | check_main_image | Curvi reports pass or fail for the longest side, the white background and the product fill, with the measured values. No credits are used. |
| 2 | See what Curvi makes | "Which marketplaces, sizes and backgrounds can Curvi make for me?" | list_channels | Lists channels with sizes, the backgrounds and the scene styles, and which ones this workspace's plan includes. |
| 3 | Estimate credits | "How many credits would an Amazon main image and a Shopify product image of this take?" | estimate_pack | States the credits needed and the workspace balance. Nothing is started. |
| 4 | Make a listing pack | "Make an Amazon main image and a Shopify product image of this on white." | estimate_pack, create_pack, get_pack | States the credits and asks to confirm, starts the pack and says it takes a few minutes, then, when asked, shows preview and download links and whether each image passes its channel's rules. The product looks exactly as in the photo. |
| 5 | Keep the photo's background | "Keep this photo's background and size it for Etsy and eBay." | estimate_pack, create_pack, get_pack | Same flow with the original background kept, sized for both channels. |

`review.test_cases.negative` (each `description` gives the reason and the expected behavior, O3; the objects carry only `description` and `prompt`):

| # | description | prompt |
| --- | --- | --- |
| 1 | "Curvi makes images and does not write copy, so ChatGPT answers on its own without calling Curvi." | "Write a product description for my candle listing." |
| 2 | "Curvi works only from a real product photo and never draws new images, so no Curvi tool is called and ChatGPT says Curvi needs a product photo." | "Draw a cartoon cat wearing a space helmet." |
| 3 | "Curvi cannot change store listings or prices, so no Curvi tool is called and ChatGPT says this needs the Shopify admin." | "Change the price of my product in my Shopify store." |

`review.commerce`: false. `review.commerce_description`: "Uses the credits in an existing Curvi account. Nothing is sold in ChatGPT."

`publication.countries`: `[]` (no restriction, decision 8). `publication.release_notes`: "First release. Make marketplace and ad images from a product photo and check Amazon main images."

Reviewer instructions (dashboard only, never in the ZIP): "Sign in at https://curvi.ai/login with the email and password below. The account has one workspace, Curvi Review, with credits and two finished packs. In ChatGPT, connect Curvi and press Connect on the Curvi page. Use the sample photo from the test cases. A pack takes a few minutes; ask ChatGPT how the pack is going to see its images."

Demo video script (3 to 5 minutes; desktop web from the developer mode connection, then Codex in the ChatGPT desktop app from the local marketplace install): connect and sign in on the Curvi page, showing the permissions list; attach the sample photo; run the 5 positive cases in order (main image check, channels, estimate, a listing pack with the confirmation and its finished links, a kept background pack); run the 3 negative prompts and show that Curvi is not called; open a preview and download a file; run one positive case in Codex; then disconnect in Curvi's Connected apps and show that ChatGPT asks to connect again.

## Sequencing and parallelization

Worktrees branch from `p19/integration`; each agent starts with `git merge --ff-only p19/integration` (worktree agents otherwise start from an old main).

| Wave | Branch (worktree) | Items | Needs |
| --- | --- | --- | --- |
| 0 | p19/integration (one agent, serial) | P19-01, P19-02 (all seams), P19-03 | nothing |
| 1 | p19/auth | P19-04, 05, 06, 07, 08, 11 | wave 0 |
| 1 | p19/tools | P19-13, 14, 16, 18, 21 and the schema and descriptor parts of P19-15 | wave 0 |
| 1 | p19/files | P19-15 (photo fetch), 17 | wave 0 |
| 1 | p19/site | P19-22, 23, 24 (without the agentApi flip) | wave 0 |
| 1 | p19/screening | P19-29 | wave 0 |
| 2 | p19/spike | the bare consent page and P19-20 | p19/auth |
| gate | founder | P19-12 on main, dark then flipped | p19/auth and p19/spike merged dark |
| 3 | p19/consent | the full P19-09 and P19-10 | the gate |
| 3 | p19/ui | P19-19, built any time after tools and files merge; ships after publication | p19/tools and p19/files merged |
| 4 | p19/integration | P19-25, 26, 27, the agentApi flip, then the rule 6 gate | everything above except P19-19 |
| 5 | p19/registry | P19-28 | production OAuth deploy |

Shared files per wave: mcp.ts (p19/auth for the auth branch; P19-20 in p19/spike; the resources methods in p19/ui), mcp-tools.ts (p19/tools; P19-11 adds get_profile in p19/auth after P19-02's stub), chat-views.ts (p19/tools; P19-17 fills link fields through P19-02's seam), actions.ts and schemas.ts (p19/tools only; `overLimit` callers at actions.ts:249, 292, 406 stay there), mcp.test.ts (p19/spike for Origin, p19/tools for descriptors), recipes.ts and schemas.ts in packages/pipeline (p19/screening only). p19/auth owns lib/mcp-auth, the migration and packages/db; p19/files owns photos.ts, lib/mcp-links.ts and the link routes; p19/site owns the marketing pages, flags, help and llms (PHASE_18 also edits llms.ts and help-articles.ts copy, so rebase on main before merging). p19/auth and p19/spike merge to main dark (`MCP_OAUTH_ENABLED=0`, the hook and the OAuth server off) after their own lint, typecheck and test pass, because production deploys only from main (render.yaml:12, 41). Other branches merge to main only after P19-12 passes.

## Rollout and the rule 6 gate

1. Dark merge of p19/auth and p19/spike (lint, typecheck, test); FOUNDER applies the migration (B1) and deploys with `MCP_OAUTH_ENABLED=0`. The MCP endpoint behaves as today.
2. FOUNDER: A2, A3, B0; the hook (B2) and the web sign in check.
3. FOUNDER: the developer client (B4, B5) and `MCP_OAUTH_ENABLED=1` (B3, a restart).
4. P19-12. Pass: continue. Fail, or decision 15 says fallback: WorkOS before more building.
5. The other branches merge; on `p19/integration` the full rule 6 gate (`pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`), `pnpm eval` (P19-29 changes a recipe, so no regression is allowed), then the reviewer pass (P19-27) with every finding fixed.
6. FOUNDER: deploy main with `MCP_LINK_KEYS`; the developer mode checklist below; the C3b local install; results into docs/verification.md.
7. FOUNDER: confirm `CURVI_INLINE_PACK_CONCURRENCY` in the Render dashboard (decision 13).
8. Submission (runbook C to E); publish (E8).
9. After publishing: mobile and Codex CLI checks, the viewer by deploy, the MCP Registry (P19-28).

Rollback, fastest first: `MCP_OAUTH_ENABLED=0` (an env change; Render restarts the service and the restart settles running packs and returns their holds, inline-runner.ts, render.yaml:33-36, so pick a quiet time; ChatGPT connections stop, keys keep working); turn the hook off in Supabase (OAuth tokens then fail the audience check, web sign in unaffected); turn the OAuth server off.

After publishing: tool changes (descriptions, schemas, annotations, security schemes, tool `_meta`, UI resource references and their CSP) need only a deploy; OpenAI's daily scan or a manual Rescan applies them after automated checks, and a held update keeps the old live definition, so every tool change stays backward compatible. New tools stay hidden until they pass; a deleted tool leaves the published list at the next scan, and server changes apply before any scan, so a removed tool keeps answering with a neutral error until a Rescan confirms its removal. Listing text, assets, test cases or `mcp.json` changes need a new ZIP version, a new review and a new publish. The URL `https://curvi.ai/api/mcp` is treated as fixed (decision 9).

## Verifying the live connection from ChatGPT developer mode

1. AGENT: `curl -s https://curvi.ai/.well-known/oauth-protected-resource/api/mcp` returns the JSON with the exact resource; Supabase's `/.well-known/oauth-authorization-server/auth/v1` answers 200 with `S256` and the same issuer; `initialize` without a token answers 401 with `resource_metadata`; with an API key the four existing tools still answer.
2. AGENT: MCP Inspector (`npx @modelcontextprotocol/inspector`) against production with an API key header: every tool's annotations, security schemes and output schemas show; every success result validates.
3. FOUNDER: connect in developer mode on the web (B4, B5), complete the consent page, note the scopes it lists, and check the tool list in the connection's details.
4. FOUNDER: run the 5 positive and 3 negative prompts and the golden set. create_pack asks for confirmation (per your ChatGPT permission setting); links open; downloads save files; the product looks exactly as photographed.
5. FOUNDER (after C3b): the 5 positive cases in ChatGPT and in Codex in the desktop app from the local install. If Codex cannot sign in with the static client (O16: Codex uses a `127.0.0.1` loopback callback, appends a callback id when the issuer does not advertise RFC 9207 support, and inserts the listener port at run time), take decision 1's fallback before publishing, or get written confirmation of the redirect a hosted plugin uses in Codex.
6. FOUNDER: after 20 minutes, a download link from step 4 still works; after an hour, a new call still works (refresh token).
7. FOUNDER: Disconnect in Curvi's Connected apps; links already shared stop working; the next call in ChatGPT asks to connect again; reconnecting works; an admin's revoke of a second test member stays revoked; a two workspace account reconnects and picks.
8. AGENT: from the founder's notes, record in docs/verification.md: the date, the ChatGPT plan, whether ChatGPT sent an Origin header, which protocol version and handshake it used, the `download_url` host and length, whether HEIC arrived as HEIC, how long create_pack took, whether any tool call timed out, whether `aud`, the refresh and the challenge string behaved as designed, the scopes requested, and the Auth API probe results.
9. After publishing: the 5 positive cases on iOS, Android and Codex CLI; fixes by deploy.

## Still unverified (settle in P19-12 or the checklist)

- ChatGPT with a Supabase static client end to end; whether a published plugin keeps one callback URL for all users; which redirect Codex uses for a directory installed plugin (Supabase cannot accept Codex's variable loopback port; now a gate, checklist step 5).
- Whether the hook sees `client_id` in the claims as documented, and whether the owner role can read `auth.sessions` on hosted Supabase.
- The hosted columns of `auth.oauth_authorizations` and `auth.sessions.oauth_client_id` (present in Supabase Auth's migrations, SB4); the `scope` claim's shape.
- Whether PostgREST checks `aud`: moot once P19-05's restrictive policy is in; P19-12 confirms.
- Which Auth API calls a ChatGPT style token can make on the hosted project (decision 15, P19-12).
- Which protocol version and handshake ChatGPT uses for ordinary calls; whether it sends an Origin header; its tool call timeout; how it handles polling without a UI.
- `download_url` host, lifetime, length and accepted types; HEIC handling; the reported 9.6% of calls with the file missing.
- The exact `_meta.ui.domain` value OpenAI expects; whether calls made from a widget get ChatGPT's confirmation.
- Whether annotation justifications are still enforced; the root `description` limit (1,024 or 4,000).
- Developer mode write tools on Plus and Pro; whether a Business workspace publish reaches mobile.
- Review time, any fee, a plan by region availability list.
- The real median pack time in production.

## Done when

- Every item P19-01 to P19-27 and P19-29 is built and its tests pass, and `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` passes on `p19/integration` (rule 6). P19-19 and P19-28 follow publication.
- `pnpm eval` shows no regression after P19-29's recipe change.
- The reviewer pass finds nothing open.
- The developer mode checklist steps 1 to 8 pass on production and are recorded in docs/verification.md with dates (rule 7).
- The 5 positive cases pass in Codex in the ChatGPT desktop app before submission, and in Codex CLI after publishing.
- On iOS and Android the cases are run where the plugin is available, after publishing, and any failure is fixed by deploy.
- A ChatGPT style token reads nothing through the Data API, and decision 15 is settled with the P19-12 probe results.
- No string reachable through /api/mcp promotes an upgrade, a top up or a plan, and none asks for an API key.
- The ZIP builds, passes its own checks and is accepted by the dashboard's automated checks; the domain is verified; the tool scan is clean.
- The plugin is submitted; after approval it is published and `FEATURES.chatgptPlugin` is live.

## Backlog

- `list_packs` for returning users ("show me yesterday's pack"); new tools go live through the daily scan without a new ZIP.
- MCP Events `pack.completed`.
- Mixed mode with an anonymous main image check, rate limited by `openai/subject`.
- Dynamic client registration with consent safeguards, then Claude's directory (after the Anthropic pre-check), Smithery, Glama and the Claude and VS Code install links.
- WorkOS Standalone Connect if Supabase's beta changes or CIMD and the stable redirect become required.
- An MCP based skill in a later ZIP version.
- Directory translations (`publication.translations`), once imported translations change the directory text.
- A Supabase custom auth domain (paid), so the sign in URL shows curvi.ai.
- HEIC decoding if attachments often arrive as HEIC.

## Review log

2026-10-01. Three reviews (docs 21, security 9, code 19) raised 49 findings. Each was re-checked against the repo on main ccbd555 and the official pages (O1 to O9, O11, O12, O13, O17, O18, O19, M2, M4, M5, MR1, SB1, SB4, and Supabase's live discovery document). All 49 hold and are applied above. No finding is rejected. Two alternative fixes are set aside:

- Keying connections by `session_id` (docs finding 4, code finding 31, option 2): set aside because Supabase creates the session at the token exchange, after the consent page, so the page cannot bind a workspace to it (decision 18).
- Making the reviewer an editor in a founder owned workspace (security finding 30, option 2): set aside because signup gives every user an owner workspace (0004_signup_bootstrap.sql), so the reviewer would see the picker; the Starter option is applied (decision 14).

Corrected in passing: the 10 minute authorization request lifetime stands (SB4 `AuthorizationTTL`); only its citation changed. Additions found while re-checking: Supabase Auth now has a "require current password" setting (decision 15, A3); O2's location hint includes rough coordinates (P19-23); estimate_pack is open world now that it reads photos; the local marketplace installs a plugin folder, not the ZIP (C3b); P19-05 grows to M and P19-16 to L.
