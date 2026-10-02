# Private completion webhooks

Phase 21 adds optional workspace receivers at `/app/settings/webhooks`. No endpoint is created, verified or activated by deployment. Setup requires an owner or admin session, the existing `MCP_LINK_KEYS` wrapping ring, and a receiver the customer controls. Missing signing configuration fails closed. Disable and deletion remain available even when that configuration is missing.

Saving a receiver generates a 32-byte random signing secret, shown once inside an analytics-masked panel, and stores only its authenticated encrypted form. The URL must use a public HTTPS hostname on port 443, without user information, query parameters or a fragment. The destination is immutable: create and verify a replacement to change it. A workspace may have three receivers. Setup, rotation, verification and replay share a seeded per-member and per-workspace hourly limit; disable and deletion are exempt so a customer can always stop delivery.

`Verify and activate` explicitly sends one signed `webhook.verify` challenge. The receiver verifies the normal signature and answers with a 2xx status and `curvi-webhook-verification` header containing the lowercase hexadecimal HMAC SHA256 of `curvi:webhook:verify:v1:CHALLENGE`, using the displayed signing secret as the key. A successful response proves secret possession before activation. Failed verification never activates the endpoint. An already active endpoint must be disabled before another verification attempt. Verification is limited to once per endpoint per minute.

## Event contract

The JSON payload contains only:

```json
{
  "id": "stable-event-uuid",
  "type": "pack.run.terminal",
  "version": 1,
  "workspace_id": "workspace-uuid",
  "job_id": "pack-uuid",
  "run_id": "logical-run-uuid",
  "outcome": "failed",
  "pack_status": "done",
  "occurred_at": "2026-10-02T12:00:00.000Z",
  "pack_path": "/api/v1/packs/pack-uuid"
}
```

`outcome` is `done`, `failed` or `canceled` for this execution. `pack_status` is the pack's terminal state at that commit. A failed or canceled follow-up can leave an older delivered pack available, so the fields can differ. `done` means the execution ended normally, not that every image passed quality checks. Fetch the current pack with the receiver's own authorized API key to inspect available files, review flags and later state. The event excludes balances and makes no final credit-settlement promise.

A database trigger writes the immutable event and eligible deliveries in the terminal job transaction. First runs and accepted follow-ups have different logical run IDs. A terminal failed pack explicitly retried gets a new logical run. Fencing-key changes during live recovery/restart preserve the logical ID; repeated terminal writes preserve the original event ID. Existing historical terminal packs are not backfilled. A later endpoint activation receives future terminal transitions only, except for an explicit permitted replay of an existing delivery.

## Signature verification

Headers are `curvi-webhook-timestamp` (Unix seconds), `curvi-webhook-key-id`, `curvi-webhook-signature` (`v1=` followed by 64 lowercase hexadecimal characters) and, for completion events, `curvi-webhook-event-id`.

Calculate HMAC SHA256 over the exact UTF-8 prefix `curvi:webhook:v1:TIMESTAMP:KEY_ID:` followed by the exact raw request body bytes. Use the displayed base64url secret **as a UTF-8 key string**, not decoded bytes. Reject unknown key IDs, malformed signatures and timestamps outside a five-minute past/future window. Compare equal-length MACs in constant time before JSON parsing. A receiver must deduplicate the authenticated payload's event ID. Do not rely on the unsigned convenience event-ID header for deduplication.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

// First validate timestamp, key ID and v1=64-hex header syntax.
const expected = createHmac("sha256", signingSecret)
  .update(`curvi:webhook:v1:${timestamp}:${keyId}:`, "utf8")
  .update(rawRequestBody)
  .digest();
const received = Buffer.from(signatureHeader.slice(3), "hex");
const valid = received.length === expected.length && timingSafeEqual(received, expected);
```

Return a 2xx response after durably accepting the event. Delivery is at least once: a receiver success followed by a sender crash can repeat the same event. Events can arrive out of order; `pack_path` returns current authorized state.

## Delivery bounds and concurrency

The existing ten-minute leased tick runs webhooks last, after critical generation, billing and retention work. This is not an instant notification service. One bounded pass attempts at most three deliveries and reserves an 18-second budget; network attempts are sequential. DNS plus HTTPS has a five-second total deadline and a two-second connection deadline. Each SQL operation has a one-second statement timeout and a 250-millisecond lock timeout; the worker rechecks its deadline and lease after locks and before transmission.

Every attempt resolves all DNS answers, rejects private, loopback, link-local, metadata, mapped, multicast, documentation and other reserved addresses, and pins one validated address at the socket lookup. HTTPS retains the original hostname for TLS certificate checks and SNI. Connection pooling, redirects and automatic address-family selection are disabled. Request and response bodies are capped at 4 KiB, response headers at 8 KiB. Response bodies and sensitive errors are never persisted.

A claim uses `FOR UPDATE SKIP LOCKED`, increments the attempt count and has a 30-second lease. A process crash makes it reclaimable after expiry. Sending holds `FOR NO KEY UPDATE` on the endpoint, then locks/rechecks the delivery. Terminal event fanout takes only `FOR KEY SHARE` on receivers, so HTTP latency does not block pack completion. Endpoint deletion waits for active key-share references. Endpoint revisions fence disable/re-enable and signing-key rotations; stale revisions are canceled even when insertion races with a disable. Explicit replay captures the active endpoint's current revision under its lock.

Disabling, deleting or replacing a signing key waits for a bounded in-flight request, then prevents later attempts and cancels queued deliveries. A request already in flight can finish. The worker also cancels stale or disabled deliveries and expires abandoned attempts when signing configuration is missing.

There are six attempts per delivery, with seeded delays of 10 minutes, 30 minutes, 2 hours, 6 hours and 12 hours before subsequent attempts; scheduling adds its cadence. Deliveries expire 72 hours after creation. Owners/admins can explicitly replay up to twice before that original expiry; each replay retains the event ID and resets its attempt allowance. Retry exhaustion is visible in settings and does not change generation or credits.

Event and delivery metadata is removed after 30 days by the existing bounded retention task. Deleting an endpoint removes its deliveries and signing material. Deleting the workspace or pack cascades its events and deliveries. Source-photo retention is unchanged. Customer exports omit signing keys, encrypted secrets, URL paths, response bodies and internal lease state.

## Signing-key rotation

There are two separate rotations:

1. **Receiver signing key:** `Replace signing key` generates a new receiver secret and key ID, disables the endpoint and cancels pending attempts. Install the new secret at the receiver and explicitly verify again. Old receiver signatures must be refused for the new key ID. Replay of a retained event is explicit.
2. **Server wrapping ring:** persistent endpoint secrets reuse the existing `MCP_LINK_KEYS` ring under the `webhook-secret` HKDF/AES-GCM purpose, with workspace and endpoint IDs inside authenticated ciphertext. Prepend the new approved wrapping key while retaining old keys. Delivery and verification rewrap authenticated secrets under the current key while holding the endpoint lock. Rewrapping does not change the receiver secret/key ID/revision. Do not remove an old wrapping key merely because the original 24-hour link lifetime elapsed: first ensure every endpoint using it was rewrapped, explicitly rotated or deleted, including inactive endpoints. A metadata-only count of ciphertext `kid` values may be reviewed without printing ciphertext or secrets. Removing a needed key fails closed with `key_unavailable`; it does not silently generate a replacement secret.

No new credential, external receiver, persistent access grant or paid worker was provisioned for this implementation. Live receiver acceptance remains a separate explicit customer action and needs a consenting endpoint and latency agreement. Fixture tests do not establish live delivery proof.
