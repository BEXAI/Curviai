# Pending work

Updated 2026-10-02. Phases 18, 19 and 20 now share an integration checkout based on `release/2026-10-02` (`02a0ae0`). Their local implementations and acceptance gates are recorded in [Phase 18](phases/PHASE_18.md), [Phase 19](phases/PHASE_19.md) and the [66-item Phase 20 matrix](phases/PHASE_20.md#current-acceptance-matrix-2026-10-02-integration-in-progress). Older statements that every item was unbuilt, the database stopped at 0013, or a separate worker must be deployed no longer describe this work.

This file tracks remaining work. A passing local test, applied migration or merged PR does not prove a deployed feature, delivered message or successful real payment. The timestamped source of production evidence is [verification.md](verification.md); local handoffs are under [ops/handoffs](ops/handoffs/phase-20.md).

## Confirmed integration state

- The schema owner confirmed production migrations through **0044_disposable_domains**, with all 45 journal entries matching the migration manifest. This includes additive schedule, runner, retention, alerts/gallery and disposable-domain contracts. The targeted 9,199-domain seed was applied and independently verified on 2026-10-02; the final new web runtime is still under release verification. The schema's source checkpoint was `7082ec4`; verify its current publication through the release PR and deployed commit, since SQL application is separate from Git publication.
- PR2, PR3, PR4 and PR5 are merged; their commits and CI evidence are in the orchestration checkpoint. PR6 contains the final dependent feature release and security corrections. Publication continues in tested batches. Before calling a batch deployed, match the protected health `commit` and schema report to that batch and check Render's deployment result; do not infer deployment from GitHub alone.
- The user has authorized frequent tested merges to main and Render auto-deploy. The old plan decision to require auto-deploy off is superseded. The optional manual release tool preserves the existing trigger by default; a main-triggered deploy may already be underway before a manual drain starts.
- Runtime work uses the inline pack runner and the leased web tick. The `@curvi/trigger` package name remains for shared implementation code, but its retired hosted task entrypoints are not a deployment target.
- Runtime switches remain durable `ops:` values and do not reset on seed. Paid canaries, assistant OAuth/public listing, optional growth email, referrals and other gated features must follow their individual recorded acceptance gates. No real emails, paid provider calls or new credentials were authorized for the implementation pass.

## Next publication and deployment checks

1. Complete the current release PR's integration CI and publish coherent dependency batches. The old phase-branch merge/cherry-pick sequence is historical. Migrations 0028–0044 are already applied; preserve their files, journal and hashes rather than renumbering or replaying them. Keep operator-key compatibility rows until every reader has run in production for one release.
2. Deploy the Render web service with its inline pack runner and verify recovery/queue/caps/tick/storage contracts before enabling dependent scheduled jobs. There is no separate Trigger.dev worker deployment. Confirm protected health identifies the intended commit and schema and that job ownership/heartbeat columns are in use.
3. Publish billing scheduling/notices/history with the shared transactional sender, renewal tick registration, schedule webhook handlers and UI together. The three schedule events must be configured before the flow is enabled.
4. Publish customer auth/support/help, operator security/cockpit/alerts/gallery and exact picked-file report/ZIP changes with their dependencies. Operator pages and actions require AAL2; there is no password-only fallback.
5. Finish the production Blueprint/env inventory, use the existing service identity in its preview, and check that no duplicate service or overwritten env value would result. Record actual cron and secret scope in [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md).
6. After each batch, run no-spend health/public smoke and inspect running/queued counts. Browser and live business-flow acceptance remains separate from unit tests.

## Money and legal gates

The billing code now schedules a smaller plan or annual-to-monthly change at the next renewal, shows the pending date and supports Keep current plan. Billing is owner/admin only. The old email-only downgrade instructions are superseded by [STRIPE_SETUP.md](STRIPE_SETUP.md).

Still required:

- Stripe test-mode products/prices, default portal with Switch plan off, upgrade-only configurations and exact webhook events/API version. Exercise monthly/annual starts, test-clock renewals, upgrade, schedule/Keep/cancel/pause/discount, top-up/refund, disputes and duplicate checkout. Save scrubbed real event payloads for fixtures and run the external PostgreSQL race suite.
- Real transactional activation/renewal/price-change notice delivery and dedupe verification. Prepare a price-change dry run before any approved send; the CLI sends notices and does not update Stripe prices. Billing consents and notice retention must remain intact after workspace deletion.
- Live payment and refund proof only when separately authorized, with the operator workspace excluded from growth/economics metrics. No live purchase is recorded by this implementation task.
- Actual unit-economics samples, not fixture averages, before deciding generative-still price or enabling founding/referral offers. Credits currently have no expiry while the account remains open; changing that policy would require a separate credit-lot design.
- The founder supplied and authorized publishing AIManagement Inc. and its postal address on 2026-10-02; `LEGAL_FACTS` now supplies them to terms and privacy. Governing law, counsel review and any approved refund promise remain pending. These public business details do not establish a verified OpenAI publisher or constitute acceptance of legal agreements. `LEGAL_FACTS` stays the source for terms/privacy/help retention facts. Do not claim legal setup or review completed.

## Production safety gates

- Review each pending migration for actual data changes, compatible application/workers, old-writer isolation and reversible or forward-repair behavior. Encrypted-backup setup and restore drills were retired by the user on 2026-10-03 and are no longer release blockers. Local disk/GitHub recover code only; they do not restore live database data. See [current policy](ops/BACKUP_RESTORE.md).
- External uptime and heartbeat monitors, real alert delivery and recovery; protected Sentry scrubbed server/browser events and readable source maps. See [ALERTS.md](ops/ALERTS.md).
- Adopt the ten-minute tick and confirm due jobs, lease renewal, partial failure reporting and first weekly Money/Operations/Triggers email. Retention requires a production dry run and a measured bounded delete pass; funnel history and billing consents remain excluded.
- Apply the single R2 lifecycle config with **both** `anon/` and `tmp/` rules. Confirm legacy temporary-object sweep and real expiry; do not overwrite one rule by applying the other separately.
- Run process-interruption/deploy recovery smoke and confirm one owner, at most one allowed restart, no duplicate charge, preserved COGS and stale-job settlement. Local representative results: concurrency two peaked at 1012.20 MiB and passed the 2048 MiB budget; concurrency one peaked at 724.66 MiB and failed 512 MiB. Use the 2 GiB/concurrency-two profile for staging overlap/latency acceptance; do not describe 512 MiB as supported by this evidence.
- Provider balances and quota recovery need funded, authorized tests. Canary code is opt-in and stays disabled without its gate. Model-retirement/recipe traffic-drift checks now pass local tests; compare live rows and warning output without changing production traffic.
- Trusted proxy-IP spoof tests through the deployed proxy, shared Redis behavior, final corrected-head CodeQL verification after the recorded finding review, and seven days of CSP reports plus clean staging checks before enforced CSP. Local scaffolding is not that evidence.

## Customer and operator acceptance

- Confirm Supabase token-hash templates on a phone, scanner-safe GET/POST confirmation, resend cooldown, password reset and secure email change; verify Stripe customer email changes only after confirmed identity matching.
- Prove support inbox/ack, feedback and billing email delivery. Growth mail stays off until its sender, address, consent and suppression requirements are accepted.
- Configure Turnstile only after the assistant review gate; prove challenges and fallback limits without blocking the reviewer account. The validated disposable-domain snapshot is seeded; smoke a withheld signup grant after the auth hook is approved and configured.
- Enroll founder operator MFA, verify recovery procedure, test audited switches/grants/provider reset and stale/forced job actions. Verify pending gallery submissions are private until approval and unpublishing removes them.
- Run real picked-version and regenerated-scene smoke: source still exists, new version is unpicked, only delivered files are charged, chosen files reach ZIP/report/PDF. Legacy versions without exact saved checks are explicitly unmeasured.
- Local six-page axe/readiness checks passed (10) and related customer/browser regressions passed (26). Repeat deployed checks after integration; real Sentry/mail/Stripe/CAPTCHA effects remain open.

## Assistant and growth gates

The assistant API/MCP and plugin code are implemented locally. Remote OAuth server/hook configuration, real ChatGPT Developer Mode, identity/review submission and listing publication continue under the authorized [Phase 22 launch plan](phases/PHASE_22.md), reusing [Phase 19](phases/PHASE_19.md). Registry ownership proof retains its existing separate acceptance gate. Keep public assistant gates off until their evidence is recorded.

P19-29 is not accepted live: on 2026-10-02 production still has `intake_normalizer@7` active at 100%, with version 8 absent. Assistant generation intentionally fails closed with temporary screening-unavailable copy until the funded version 8 eval and approved database rollout succeed. The guard also refuses an unsupported standby or compiled-only recipe fallback, releases held credits and leaves ordinary web/REST packs unchanged. Listing tools or returning a credit estimate does not establish screening readiness. Prepared SQL and green mock tests are not authorization to promote the recipe.

Deploy the combined web release with `MCP_OAUTH_ENABLED=0` and public assistant flags off. Verify metadata stays unavailable, ordinary API-key discovery/read-only tools and existing downloads work, and the deployed commit/schema match. Do not run generation as a no-spend smoke. Once the funded version 8 eval passes and activation is approved, use reviewed targeted recipe SQL with expected-state/hash checks and read-back evidence, staging first; preserve unrelated recipe traffic and operator settings. Do not use a broad `pnpm db:seed` for this rollout. The current detailed sequence is [Phase 19 founder steps](phases/PHASE_19.md#founder-steps-in-order).

The MCP Sentry sink is already registered by `apps/web/src/sentry.server.config.ts` through Next.js instrumentation. Remaining work is approved configuration and observed redacted delivery in the intended project/release, not registering another sink. Never treat local wiring as external delivery acceptance.

Phase 18 still needs owned/consented eval products, real benchmark and jewelry/people inspection, actual IPTC download verification, Shopify/Amazon URL-import smoke, Google sign-in setup, funded preview/store-audit tests, and approved founding/referral/lifecycle activation. Planner v4/v5 are inactive at zero traffic; real eval and controlled canary promotion remain pending. A seed must not silently override a deliberate production recipe traffic split.

## Triggered and later backlog

The Phase 20 plan deliberately defers priority/fairness, shared PostgreSQL breakers, larger product/library paging, economics cockpit, structured log overhaul, team invitations/switcher, multi-product batches, listing copy, scene adjustment, customer MFA, checkpoint/resume and later video/pack changes until their recorded triggers. They are not counted as completed implementation. The weekly report makes the available trigger evidence visible; an uncategorized support request still needs manual review.

Other later work includes Shopify embedded app/billing and auto-packs, Amazon publishing, external Drive/Dropbox/Canva export, C2PA credentials, broader owned golden-set evaluation, trademark/domain decisions and any future partial-dispute policy change. Existing plan documents retain their original rationale; reassess each against current code before estimating it as new work.

## Operational references

- [RUNBOOK.md](ops/RUNBOOK.md): release, migration, switches, job recovery and support triage.
- [STRIPE_SETUP.md](STRIPE_SETUP.md): exact billing configuration and test-mode acceptance.
- [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md): production variable/service inventory and verified rollout steps.
- [STAGING.md](ops/STAGING.md): isolated staging and opt-in smoke workflows.
- [verification.md](verification.md): dated production facts, observations and unresolved checks.


## Phase 21 and Phase 22 continuation

The user retired encrypted-backup planning and its release gates on 2026-10-03. No backup bucket, dump, age recipient, executor or restore drill is required for this rollout. Local disk/GitHub preserve code only; they do not restore live database rows, Auth state or stored objects. Existing backup data and unrelated security controls remain untouched.

Migrations **0045 and 0046 are applied and must not be replayed**. **0047, 0048 and 0049 remain UNAPPLIED**. The integrated release is reviewing an inert candidate handoff and a guarded atomic 0047–0049 transaction; neither a live writer fence nor SQL execution is established by that preparation. Required checks are the exact target/journal, compatible application and workers, isolation of every old writer, bounded transaction/postflight verification and explicit rollback or forward-repair limits. A momentary zero-job count is not writer isolation. Report irreversible data effects before executing them. Follow the reviewed [maintenance handoff](ops/MIGRATION_MAINTENANCE.md) once its checks pass. Paid evaluation remains paused pending its numeric cap, and dedicated reviewer identity/secure sign-in remain unresolved acceptance steps.

### Historical implementation checkpoints (2026-10-02)

The following original phase snapshots preserve their test counts and then-pending publication/access states. They are not current SQL instructions or a reason to replay 0045/0046.

Phase21 code for resolution cases, optional owner credit budgets and private completion webhooks is published in [draft PR8](https://github.com/BEXAI/Curviai/pull/8), stacked on PR6. The frozen local gate passes6,800 unit tests, lint/types, full195 browser checks and9 rebuilt affected privacy/legal checks. Hosted CI also passes, including all14 PostgreSQL17 concurrency tests with zero skips. Exact main/deploy proof and reviewed migration0045–0047 application remain pending. No live endpoint or budget has been activated. See [Phase21 checkpoint](ops/PHASE_21_CHECKPOINT.md).

Phase22 now authorizes full plugin implementation and official submission/publication, with actual approval left to OpenAI. It includes the viewer before first submission, existing-pack rendering, bounded authenticated link refresh, partial-output handling and strict package checks. Source, local fixtures, production tests, actual ChatGPT evidence and portal decisions are distinct milestones. Public business name/address and their publication are authorized. Verified platform publishing identity, governing law, counsel review, secure test/reviewer access, owned sample assets, bounded funded evaluation and exact action-time attestations remain pending. See [Phase22 checkpoint](ops/PHASE_22_CHECKPOINT.md). The three earlier future proposals are preserved in [Phase23](phases/PHASE_23.md), planning only.

Phase22 source commit `55bbce4` passes lint/types,6,842 unit tests, production build and199 browser tests, with no source-scan secret findings. Five code/review lanes are complete. Hosted Phase22 checks, prerequisite security disposition, live deployment/access and the actual ChatGPT/review steps remain open.
