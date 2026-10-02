# Schema and operator handoff — 2026-10-02

Production project `tmwvjmvzjvpeagatjmud` is migrated through **0044**. Root applied 0028; schema owner applied 0029–0044 through the user's Mac Chrome SQL Editor after direct user authorization was verified. Original user SQL was preserved. Each batch checked its predecessor hash, rejected duplicate/out-of-order execution, used a transaction, a 5-second lock timeout and a 60-second statement timeout, and returned its committed journal hashes.

[Saved read-only verification query](https://supabase.com/dashboard/project/tmwvjmvzjvpeagatjmud/sql/d84a8305-7532-4c78-84aa-cf9041c7e4f3). Full temporary review scripts and machine-readable evidence are in `/tmp/curvi-migration-review/`; this directory is not a durable repository artifact. Browser ownership is released to root.

## Verification

- Journal: **45 rows**, all timestamps/hashes match the checkout manifest. MD5 of ordered `created_at:hash` records joined with a newline: `366a929191018fe22b54aac2d3936aa0`.
- **43 public tables**; missing RLS: **0**; missing restrictive `no_oauth_clients`: **0**.
- Client grants on new platform tables: **0**; write grants on new tenant tables: **0**. The operator audit sequence is inaccessible to client roles.
- Anonymous/authenticated execution of the token hook and signup-grant function: **false**. The internal auth role retains token-hook execution. No OAuth provider/hook was enabled and no credentials or broader access were created.
- Expected Phase 20 columns: **13/13**; selected runner/retention/alert indexes: **5/5**; invalid public indexes: **0**; enabled restart/runner protection triggers: **2/2**.
- Gallery policy requires approval and consent. Published gallery rows missing approval: **0**. Workspace seller-profile protection and disposable-domain function logic are present.
- 0037 ran only after empty referrals/no inbound foreign keys/no duplicate reward keys checks; a transaction table lock protected the empty-table check. 0039 checked that no expiring top-up rows existed before its update. No user data was deleted.

## Local deliverables and checks

- 0040–0044, schema snapshots, billing scheduling checks, protected runner metadata, retention indexes, operator alerts/gallery review contracts, and protected disposable-domain storage.
- Vendored CC0 domain list: official `disposable-email-domains/disposable-email-domains`, commit `0c4fd3aaac31f826cd5d2e698385c6cc53f76336` (2026-10-02), 9,199 domains. SHA-256 `eec4f833fcac629a2da00bcaad7f431630b28bfee7daee3a676ea6a57a6a815b`. Seed CLI validates the snapshot before connecting and atomically synchronizes under an advisory lock before pending signup grants.
- P20-47 `evaluateOpsAlerts(db, { now?, notify?, healthWarnings?, reconciledJobs?, workspaceCaps?, shotMargins? })`: deduplicated durable alerts, resolution history, notification retry/lease/idempotency. Tick owner integrated health/reconciliation signals.
- P20-50 operator gallery queue: `requireOperator()` action gate, AAL2 authorization, transactional audit, review decisions, public-gallery approval filtering, and gallery/sitemap cache invalidation. Owner share UI shows pending/rejected review state.
- Node 22 checks: database suite **312 passed / 2 skipped** (39 passing files, one optional PostgreSQL race file skipped); DB typecheck/lint pass. Domain loader **8** and parser **2** focused tests pass. Alerts/gallery/share/action checks **34** pass; changed-file lint passes. Subsequent whole-web typecheck passed after owner integration; the final root suite reports 6,598 passing tests.

## Remaining release work

- **Live domain seed completed** at `2026-10-02T12:43:04.781051Z`; independent postflight confirms **9,199** domains and the exact pinned checksum. The existing signup-grant function can now use the snapshot; no existing grants were replayed or changed.
- No feature flags, OAuth grants, token-hook activation, or live email sends were enabled. Notification tests used an injected transport.
- Cap/margin telemetry is integrated by the tick owner. Missing or incomplete optional margin telemetry preserves existing margin alerts rather than resolving them.
- Root owns final integration checks, commits, deployment, and production application health. Optional P2 tables and destructive `ops_switches_contract` remain deferred; legacy switch keys must survive one production release.

## Live disposable-domain snapshot — 2026-10-02

Executed only the root-reviewed targeted batch, SHA-256 `81a00d2719f22a04fbb14e7c01e16d1fa8152e6519d6f5fdc9cfe75c80d5ba0e`, in the exact production project. UI clipboard read-back confirmed the editor contained all 139,465 reviewed bytes before execution. The read-only preflight returned zero domains and null seed metadata, exact migration 0044, and the expected access restrictions. The transaction used the loader advisory lock, a table lock, payload checksum/format guards, and an unknown-row abort; its snapshot-sync delete necessarily affected zero existing rows.

Independent postflight after commit returned **9,199** domains and SHA-256 `eec4f833fcac629a2da00bcaad7f431630b28bfee7daee3a676ea6a57a6a815b`. Stored source metadata identifies the official [CC0 snapshot](https://github.com/disposable-email-domains/disposable-email-domains/tree/0c4fd3aaac31f826cd5d2e698385c6cc53f76336), commit `0c4fd3aaac31f826cd5d2e698385c6cc53f76336`, source date `2026-10-02T05:50:24Z`, 130,263 source bytes, and seed time `2026-10-02T12:43:04.781051+00:00`.

Before and after values match: RLS enabled on both inspected tables (**2**), restrictive OAuth deny policies (**2**), anonymous/authenticated table privileges (**0**), column privileges (**0**), and signup-grant execution (**false** for each client role). Migration 0044 remains exact and latest at `1790938535212`; the security-definer signup function contains the disposable-domain check. No other settings, recipes, credentials, privileges, auth-hook activation, or signup settlements were changed.

[Saved read-only postflight query](https://supabase.com/dashboard/project/tmwvjmvzjvpeagatjmud/sql/ae44f657-8b31-45dd-af2f-05e3f2d7aa02). Original user SQL remains untouched. Evidence: `/tmp/curvi-migration-review/0044-domain-seed-production-evidence.json`, corresponding preflight/commit/postflight accessibility captures, and `0044-domain-seed-postflight.png`. The temporary directory is not a durable repository artifact. **Browser ownership released to root.**

## Applied migration hashes

| Migration | Journal timestamp | SHA-256 |
| --- | ---: | --- |
| `0028_mcp_connections` | 1790864442094 | `903a24cfe4aaa635f01ad106cb2d00c3c53cdde1094d8e07d52db6d570129984` |
| `0029_attribution_and_funnel` | 1790864502094 | `7ac60856b6b071980666e616fb56ed7c112d26b28a2e102d11e288a5975a59d5` |
| `0030_deploy_restarts` | 1790866451714 | `68d150b11f2947921c8709ddf897621bc40318aeb073281b589d6054ebd49f4c` |
| `0031_seller_profile` | 1790866641551 | `8128f9a09b18198a2468cc3d04e2b7600816d7cc290690e3ba64a8a41e6f1450` |
| `0032_free_previews` | 1790866646688 | `eff55703eeeac8948e1fe05c1068033160bfba82c8a90a1633a20a50be5f23f6` |
| `0033_share_proof` | 1790866816106 | `f72dc01bf9ab50123b4bece67dac9ebafc2aeef3d7b9727b7a196267f9b368c8` |
| `0034_lifecycle_email` | 1790868078311 | `5f65b1089dfe0fdbb64ef38547a608ad064166769f0f9ae7cb7cef32044deb76` |
| `0035_pack_feedback` | 1790870292166 | `1f55997df5db236d43e7dc2924ac76c8e3c167b2606d3fb96417ce8e7585640c` |
| `0036_pack_claims` | 1790870315379 | `4aeaf49314b31032f4866813350a950a9f08aa5e388d33ac14a4bd5cf26f6bc3` |
| `0037_referrals` | 1790870469863 | `65ad15e70dd5770d16e3a867df782196c3607a87780e17d0d0025669390fb765` |
| `0038_ops_switches_and_audit` | 1790872346199 | `dd2df4d0f8610f26face54d39c77e95be2d1ad04285fe0826a6c6164f104e646` |
| `0039_billing_terms` | 1790921588222 | `42146c3a3e8a61db06018ef6b6c138392563ac37930745da5dea25ce744c082e` |
| `0040_billing_schedule` | 1790938247303 | `bff2546b9e060cb916981d9482e21d9a5c54ec472982ac782aadefa1440bbbd2` |
| `0041_runner_columns` | 1790938296172 | `ee904ab37319fed5ceb97ef9c21401c10d85a39249034c6f12e9dc1f5f5cc673` |
| `0042_retention_indexes` | 1790938380386 | `9ceec762888fbb9c9cf5794ce8ae8c100ddb1695ea9a640018e39685783f7a8d` |
| `0043_ops_alerts_gallery` | 1790938484592 | `9a78a3e4332dc9fbc232d3f6f9e4af6f2d5a8329fb384e329629a8e2637e8e24` |
| `0044_disposable_domains` | 1790938535212 | `229894fcc8c89c1fa382e1289a7c03366f1e3dddaca6a7022c54d9fd63bc3270` |

## Follow-up secret scan and security review

Audited all 24 findings in the redacted source-snapshot report. They are synthetic test values, non-secret idempotency identifiers, or the `R2_BUCKET_PRIVATE` environment-variable name in `render.yaml` (its value is configured separately). `.gitleaks.toml` extends every default rule and adds 18 exact-full-line AND exact-path exceptions in three rule-specific blocks. It does not ignore test directories or disable a detection rule. The configuration follows the [pinned Gitleaks documentation](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md).

Pinned Gitleaks 8.30.1, `dir /tmp/curvi-source-scan --config /tmp/curvi-phases-18-20/.gitleaks.toml --redact=100`: processed 16,849,554 bytes (16.85 MB), exited 0, and reported zero findings. Snapshot contains 1,508 files including the new config and no environment files. Report: `/tmp/curvi-gitleaks-reviewed-results.json`. A separate four-file synthetic canary corpus exited 1 as expected and detected all four markers: changed generic/Stripe/JWT values inside the named fixture paths, plus an unchanged fixture outside its approved path. Report: `/tmp/curvi-gitleaks-canary-results.json`. No genuine credentials were printed or copied into configuration.

Independent review of operator-session, trusted-IP, and Sentry-tunnel changes found no blocking issue. The 10 focused tests passed (3 operator-session, 5 client-IP, 2 tunnel). Account plus token verification, matching subject, required AAL2, proxy-proof gating, HTTPS ingest/project restriction, body size/rate limits, redirect refusal, and error-envelope filtering are present. Actual Render forwarded-hop behavior and Cloudflare proof overwrite remain deployment verification work. No other owner's security source files were changed.
