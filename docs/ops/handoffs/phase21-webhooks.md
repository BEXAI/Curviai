# Phase 21 webhook implementation handoff

Owner: p21_webhooks. Shared checkout: `/tmp/curvi-phase-21`. No Git publication, live SQL, environment secret reads or third-party deliveries by this lane.

Implemented private completion contract, purpose-separated encryption/rewrapping, exact-byte HMAC signatures, proof-of-secret ownership verification, public HTTPS DNS/IP validation and pinned socket transport, bounded durable worker, owner/admin settings actions/UI, explicit replay/disable/delete/key rotation, seeded policy and final cron job. Logical run outcomes are distinct from pack availability; follow-up failure and interrupted/canceled runs set explicit outcomes without changing existing pack preservation behavior.

Central schema owner implements `logical_run_id`, `logical_run_outcome`, event/endpoint/delivery tables, endpoint revisions, atomic triggers and private RLS. Root owns abandoned-followup setter in the shared service file and navigation. Privacy lane owns export/retention/browser tests. Review lane owns `docs/verification.md` source entries. Runbook: [COMPLETION_WEBHOOKS.md](../COMPLETION_WEBHOOKS.md).

Tests so far: 38 crypto/wire fixture tests and seven DB-backed management/delivery tests pass; existing Shopify webhook tests remain green. Additional action, privacy-render, rate-limit, cron and follow-up regression tests are running; final evidence will be appended below. The Node HTTPS lookup fixture verifies real Node option shape and aborts before any network connection. PGlite tests exercise migration-backed data, stable repeat event IDs, role/tenant refusal, one claim winner, disable/delete/rotation cancellation, lease expiry, missing-key cleanup, retry exhaustion, bounded replay and wrapping-key rekey.

Live receiver activation and staging transmission are not claimed. The existing PR6 security gate remains under root ownership and was not changed.

## Code freeze evidence

The lane is ready for the root integration gate. `/tmp/curvi-p21-webhooks-focused.log`: 151 passing tests across 10 files (includes existing Shopify, rate-limit and cron regression suites). `/tmp/curvi-p21-webhooks-followup.log`: 17 passing pipeline follow-up tests. `/tmp/curvi-p21-webhooks-lint.log`: scoped ESLint completed without findings. Webhook code and fixtures pass TypeScript; the latest whole-web typecheck still reported the privacy lane's `trust/export.test.ts` delivery fixture missing `endpointRevision`, already sent to that owner for correction. Root owns the subsequent complete lint/type/unit/build/browser and real-Postgres gates.

The eight new database tests include fresh clock checks after lock acquisition and cancellation of stale endpoint revisions after reactivation. The four server-action tests prove owner-session/configuration gates, hourly member/workspace quotas, always-available disable/delete, and sanitized failures. Two renderer tests prove the analytics masking boundary and disable controls while key configuration is missing. No further code changes are planned absent integration findings.
