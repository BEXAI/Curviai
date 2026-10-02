# Phase 22 connection readiness

Read-only audit by `p22_connection`, 2026-10-02 15:36 UTC. Checkout `/private/tmp/curvi-phase-21`, prerequisite commit `fc44989f30e70d113873acb1dbca927d3b63fea0`, with concurrent Phase 21 changes present. This handoff is the only repository file this audit changes. No secrets or env files were read, and no OAuth client, grant, credential, setting, database row or external submission was created or changed.

## Assessment

Reuse the Phase 19 connection implementation. Its main authorization controls exist; no replacement OAuth server or source defect has been established by this audit. The remaining critical path is deploying the prerequisite, configuring an explicitly authorized test connection, proving the Supabase token boundary, and running the actual ChatGPT and Codex flow. Existing simulated browser and unit coverage cannot establish those live results.

The Phase 22 launch request authorizes implementation, deployment and submission. It does not remove the outstanding PR #6 CodeQL gate or the separate approvals for credentials, persistent OAuth access, security probes that modify a test account, legal attestations and paid execution.

## Public production evidence

Harmless GETs using curl with normal TLS verification, observed 2026-10-02 15:33–15:34 UTC:

| Check | Observed result | Limit |
| --- | --- | --- |
| `https://curvi.ai/.well-known/oauth-protected-resource/api/mcp` | HTTP 404 | OAuth discovery is unavailable. This does not identify the deployed env value. |
| `https://curvi.ai/api/health` | `ok: true`, database healthy, schema current, runner idle; commit `dae0fb0`; expected/applied `0044_disposable_domains`; `checkedAt: 2026-10-02T15:34:01.834Z` | The pending combined Phase 19 implementation is not proven deployed. |
| Supabase project `tmwvjmvzjvpeagatjmud`, public `/auth/v1/.well-known/openid-configuration` | Issuer `https://tmwvjmvzjvpeagatjmud.supabase.co/auth/v1`; authorization and token endpoints; JWKS and UserInfo endpoints; `authorization_code` and `refresh_token`; S256 and plain advertised; token authentication supports `client_secret_basic`, `client_secret_post`, `none` | Discovery can exist while OAuth issuance is disabled. No client, hook, signing key or token behavior was inferred. |
| Same OIDC document, scopes | `openid`, `profile`, `email`, `phone`, `offline_access` | Curvi requires openid/email and explains additional requested scopes. The actual consent request remains to be observed. |
| Same OIDC document, issuer identification/client metadata | No `authorization_response_iss_parameter_supported` or `client_id_metadata_document_supported` flag | Use the exact callback URI presented for the connection; do not invent a stable redirect. |

An earlier Python URL fetch failed before HTTP response because of the local URL/TLS environment. Curl succeeded without disabling certificate validation; the curl results above are the evidence.

## Current official contract

Rechecked 2026-10-02. OpenAI supports predefined OAuth clients as well as CIMD and DCR. It requires protected-resource discovery, authorization-server discovery, S256, resource audience binding and per-request token validation. Without issuer identification, ChatGPT uses a connection-specific callback. Advertised OIDC scopes are requested by default; consent must reflect them. The profile tool needs a stable, opaque identity. UserInfo with a verified email supports Enterprise domain restrictions. These requirements still fit the Phase 19 architecture, subject to the live proof below. [OpenAI authentication](https://developers.openai.com/plugins/build/auth)

Chat file fields must be top-level fields declared in `openai/fileParams`; their object schema declares `download_url`, `file_id`, `mime_type` and `file_name`, with only the first two required. Curvi's descriptors and attachment parser already follow that contract. [OpenAI file inputs](https://developers.openai.com/plugins/reference#define-file-inputs)

Supabase's OAuth scopes constrain OIDC information rather than database or API access. Its OAuth tokens otherwise behave as user session tokens, carrying `client_id`; tenant RLS must explicitly constrain them. The existing deny policies therefore remain necessary, and are not evidence that the Auth API itself is contained. [Supabase token security](https://supabase.com/docs/guides/auth/oauth-server/token-security), [Supabase OAuth flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows)

## Existing implementation to preserve

| Control | Repository evidence | Acceptance still missing |
| --- | --- | --- |
| Dark rollout and OAuth discovery | `apps/web/src/lib/mcp-auth/config.ts`, `challenge.ts`; both protected-resource routes | Approved production configuration and exact deployed enabled response. |
| Tokens | `mcp-auth/verify.ts` accepts ES256/RS256, verifies signature/issuer/audience/expiry/nbf, allowlisted client ID, UUID identity/session, required scopes and live session | Real token exchange and refresh; hosted signing configuration and audience hook. Never capture token values in evidence. |
| Workspace binding | `mcp-auth/authenticate.ts`, `backend.ts`, `connections.ts`; server-stored connection supplies workspace; membership/role is reread; first-use recovery is limited; revoked rows cannot be silently revived | Two-workspace and removed-member behavior through real connected clients. |
| Consent | `mcp-auth/consent.ts`, `consent-backend.ts`; unknown clients refused before redirect, current membership checked on submit, requested scopes listed; consented redirect checked against stored authorization | Hosted `auth.oauth_authorizations` readability, fresh and repeat consent, expiry, account switch and callback behavior. |
| Account identity | `mcp-auth/profile.ts`; authenticated `get_profile`, persisted opaque profile ID across refresh/reconnect | Real host label/deduplication and verified-email UserInfo behavior. |
| Client/editor roles | `api-v1/actions.ts` and shared `DbService`; client seats cannot start packs, tenant reads remain scoped | Actual role downgrade and cross-workspace negative tests. OAuth's OIDC scopes do not replace these checks. |
| Disconnect | `mcp-auth/connected-apps.ts`; self or current owner/admin may revoke a connection; local row is revoked before grant/session cleanup | Hosted self/admin revocation, refresh failure, and reconnect. Local row blocks new tool calls immediately; session cache is at most 60 seconds. |
| File links | `mcp-links.ts`, `mcp-links-backend.ts`; sealed expiring tokens bind connection/key, workspace, job, file and purpose; each delivery checks live subject and tenant ownership | Preview/image/ZIP/report opened inside real ChatGPT, expiry and disconnect. Subject liveness cache allows up to 60 seconds; do not claim instantaneous file-link revocation. |
| Attachments | `api-v1/mcp-tools.ts`, `schemas.ts`, `photos.ts`; authenticated tools, strict file descriptors, workspace-owned content keys; magic-byte/size/dimension checks; no attachment URL or file ID persistence | Actual ChatGPT file object and media formats, missing/expired upload behavior. |
| Network boundary | `url-import/safe-fetch.ts`, `address.ts`; vetted DNS lookup used at connection, bounded fetches and image parsing | Existing fixture tests cover hostile destinations. No arbitrary live third-party fetch is needed for launch proof. |
| Direct Data API isolation | Migration `0028_mcp_connections.sql` restrictive `no_oauth_clients`; database test enumerates public tables; Phase 21 adds the same protection | Hosted OAuth token sees no tenant data through PostgREST and cannot invoke protected mutating RPCs. |

Relevant existing suites include `mcp-auth/{verify,authenticate,consent,consent-backend,connected-apps,challenge}.test.ts`, `api/mcp/{mcp-oauth,mcp-seams,mcp-descriptors,mcp-pack-links}.test.ts`, `api-v1/photos.test.ts`, `mcp-links*.test.ts`, `packages/db/src/mcp-connections.test.ts`, and `e2e/oauth-consent.spec.ts`. This audit did not rerun them while the root's full Phase 21 verification was running. The Playwright consent suite explicitly stubs ChatGPT and uses demo authorization requests.

## Required approvals and data for the root's bundled request

1. Exact OpenAI publishing organization/project and its verified developer identity. An inferred GitHub owner or brand is insufficient. Confirm the account can manage submission and the eligible project's residency.
2. An approved test identity and workspace, plus permission to create/configure the specific private development OAuth client and later the submission client. Capture each exact callback from its actual dashboard. Secrets go directly into approved provider/host fields, never chat or this repository.
3. Permission for the planned Supabase configuration changes: OAuth server, audience hook, signing/security settings as actually needed, and Render OAuth/client/signing settings. Inspect current state before creating anything. An existing suitable secret should be reused through its approved configuration path; do not manufacture or expose it.
4. An explicit disposable-account security-probe authorization covering attempted password change and MFA enrollment, with recovery/cleanup, and non-sensitive sample data only. Do not probe the founder's account. If the token can change password or enroll MFA, retain the documented established-IdP fallback gate; do not accept the risk silently or provision a paid provider.
5. An owned/consented product fixture, a stated provider-spend/credit ceiling for screening evaluation and actual generation, and the authorized reviewer account/access policy. Existing Phase 19 proposes a Starter reviewer workspace, 300 credits and two sample packs; those are proposals, not proof of approval or creation.
6. Legal agreement/attestation acceptance remains an action-time step on the actual text. No browser/computer tool was available to this audit, so the root needs the authorized publishing browser/session or a user-performed account step for live proof.

## Ordered live acceptance

1. Deploy the tested prerequisite with gates preserved; record full deployed commit and migration health. Ensure ordinary sign-in still works after any authorized auth setting change.
2. Configure the approved client and signing material privately. Check enabled metadata and an unauthenticated MCP request's OAuth challenge. Confirm S256 and exact resource audience in the real authorization exchange without recording sensitive values.
3. Complete actual ChatGPT connect, deny, account switch, repeat consent and refresh. Record which scopes were requested, which workspace was selected and the resulting stable profile. Confirm UserInfo returns verified email for the designated test account.
4. Run containment first: Data API/RPC isolation and the specifically approved disposable-account Auth API probes. Stop activation on escape; implement the existing fallback only once its account/access prerequisites are authorized.
5. Prove member-role and workspace boundaries through tools. Disconnect self/admin; verify tool refusal, file links after their bounded cache window, refresh refusal and explicit reconnect. A web sign-out policy is separately recorded in Phase 19's launch checklist and must match observed behavior.
6. Once funded screening acceptance and targeted recipe activation are approved and pass, run the real attachment → estimate → explicit credit confirmation → generation → progress → in-chat preview/image/ZIP/report path. Record host/surface/version, test time, deployed commit, non-sensitive case ID, credit reconciliation and sanitized screenshots. No OAuth secret, token, private asset URL or customer content belongs in the evidence.

Actual ChatGPT connection, asset handoff, submission and approval remain unproved at this checkpoint.
