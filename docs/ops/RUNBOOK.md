# Operations runbook

Updated 2026-10-02 from the integration implementation. Verify the deployed commit in protected health before relying on a new action. Live credentials, inboxes, paid provider probes and operational drills have separate acceptance evidence in [verification.md](../verification.md). This runbook contains configuration names only.

## Identify the running release

Read public `/api/health` first. Read the same endpoint with the configured `CRON_SECRET` only from an authorized operator environment to inspect schema, commit and running-pack detail. A merged main commit is not deployment proof. Check Render's live deployment and compare it to `health.commit`; schema must be current. The release helper additionally requires fresh protected `details.release` information rather than trusting a cached running-pack count.

Consult [ALERTS.md](ALERTS.md) for each warning. Keep customer support descriptions plain; raw provider errors, storage keys and credentials belong only in protected diagnostics.

## Migrations and seeding

Production migration history through 0044 was confirmed by the schema owner on 2026-10-02. For subsequent changes, use the current repository journal, never a former lane's numbering. Expand before changing runtime readers; retain rollback-compatible columns/keys until the required live release has passed.

The guarded migration command requires an explicit target and a valid completed backup less than an hour old:

```sh
pnpm ops:migrate --env staging
pnpm ops:migrate --env prod --backup-now
```

It verifies the new journal entry and health schema after migration. `--backup-now` refuses a running or unknown backup state because starting a Render cron run can cancel an existing run. It waits for a completed report whose backup started after the request. A failure does not silently skip the backup gate. `--seed` is optional: it prints recipe/switch drift before changes; review the intended recipe traffic split first. Operator switches are preserved, but an intended production recipe experiment still needs an aligned seed.

The scripts read shell configuration and do not load env files. Production names include `DATABASE_URL`, `OPS_SITE_URL`, `CRON_SECRET`; triggering a backup also needs `RENDER_API_KEY` and `RENDER_BACKUP_CRON_ID`. Staging uses corresponding `STAGING_` names and must be a separate site/database. Use [BACKUP_RESTORE.md](BACKUP_RESTORE.md) for backup setup and isolated restores.

## Publish and deploy

The user's current instruction authorizes frequent tested main merges with Render auto-deploy. It supersedes the earlier plan's mandatory auto-deploy-off preference. Keep each batch buildable and verify its CI and deployed health. The source `@curvi/trigger` package runs inside the web/inline runtime; there is no separate hosted worker deployment.

An explicit manual release is available when a controlled drain is needed:

```sh
pnpm release --env prod
```

It requires a clean tree, exact HEAD pushed and a successful push CI for that SHA. It verifies the migration, writes the expiring `ops:deploy_pending` flag, waits for idle running-pack counts, deploys the exact commit, verifies Render plus health/provider/public smoke, and creates a local release tag. A failed post-deploy check offers a rollback; it never downgrades the database. Interruption attempts to clear the pause. Degraded business warnings are visible even when the runtime/schema is healthy.

The tool preserves Render's auto-deploy trigger by default. `--disable-auto-deploy` is an explicit operational choice, not a prerequisite. With main auto-deploy enabled, a merge-triggered build may already have started before this manual drain; the script cannot retroactively gate it. `--staging-smoke` additionally checks the configured staging target. Shell-only configuration includes `OPS_RELEASE_TOKEN`, `OPS_RELEASE_EMAIL`, `RENDER_API_KEY` and `RENDER_SERVICE_ID`; credentials are not web UI fields.

After a deployment, verify job ownership/recovery and queue counts, then the affected customer flow. Do not activate paid canaries, send real email, or enable a new external feature merely because deployment was authorized.

## Operator access and actions

`OPS_EMAILS` identifies eligible operators. All `/app/ops` pages and server actions require a verified session and AAL2. Enroll and confirm a factor through `/app/ops/security`. Nonoperators receive no cockpit data. Follow [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) for a lost operator factor; there is no password-only in-app bypass.

- Overview shows health, daily spend, pack counts/timings, durable switches, provider probe/reset state, open alerts, cron/backup records, database sizes and bounded CSP counts.
- Switch changes store before/after values in `ops_audit`. `ops:packs_paused` supports a seller-facing message. `ops:deploy_pending` expires; do not use it as an indefinite outage switch. Seed operations do not reset these keys.
- Credit grants require workspace, amount, reason and confirmation, and use an idempotency key. Repeated submission must not create another ledger grant. Billing history displays the server-supplied note.
- Provider Reset records a durable reset and clears preflight cache; it does not make a metered provider request. Probe now remains subject to the seeded/env canary gate and spend caps. The current breaker interface does not provide a trustworthy expiry timestamp; inspect reason/probe/reset instead.

## Stuck, failed and interrupted packs

Use `/app/ops/jobs` filters, then the per-job timeline. Check the last heartbeat, runner/run key, stored steps, delivered files, ledger and provider errors before taking action. Source-photo links last five minutes and remain inside the owning workspace. The timeline links a Sentry job search when configured.

A normal settle or requeue refuses a fresh heartbeat. Force requires explicit confirmation and is audited as forced. Requeue validates the durable tenant-scoped payload, changes the run key, preserves additive COGS and performs a scoped unique pickup. It retains the backend's one-restart and age limits. Done/canceled jobs are not reopened by this path. Settlement uses delivered-file evidence to charge or release correctly; never manually zero a ledger to hide an incident.

Record the actual state transition and ledger outcome after an action. Process crash/deploy recovery is not accepted until a controlled live smoke shows no duplicate owner, charge or file delivery.

## Cron, retention and alerts

The web tick runs on the seeded ten-minute cadence with a 240-second budget. It uses a database lease, heartbeat and due markers. An active tick cannot be duplicated; a budget overrun or partial failure is visible to the external heartbeat. Optional integrations are skipped and unmonitored until configured. The weekly funnel mail includes Money, Operations and trigger evidence in its existing deduped send path.

Retain the separate encrypted backup cron. The delivery Blueprint must give each service only its required configuration; the web service has no backup-bucket write credentials. See [LAUNCH_CHECKLIST.md](../LAUNCH_CHECKLIST.md) for the adopted production inventory.

Run retention in dry-run mode first, inspect counts and then authorize the real bounded pass. It excludes funnel history and billing consents, and preserves billing-notice records for three years. Apply `ops/r2/lifecycle.json` as one complete config holding both anonymous and temporary rules. The legacy sweep migrates/deletes old temporary data in bounded cursor batches.

P20-47 alerts persist open/resolved transitions and retryable notification state; missing optional telemetry does not resolve an alert. Check both durable rows and actual delivery before declaring alerting operational. See [ALERTS.md](ALERTS.md).

## Billing and customer support

Use [STRIPE_SETUP.md](../STRIPE_SETUP.md) for payment setup and acceptance. Owners/admins schedule a smaller plan at next renewal from Billing, with Keep current plan available while pending. Do not instruct them to apply an immediate Dashboard downgrade. A schedule request alone changes no credits.

Credit history groups holds/charges by job and keeps grants/top-ups/refunds visible; invoice links are fetched only for owner/admin roles. For a disputed balance, inspect the job timeline and `billing:verify` output before granting a correction. Every correction needs an authorized reason and an audit record.

A picked-version ZIP and report are rebuilt from selected variants. Exact post-packaging checks are keyed by object identity; an older variant without saved checks is unmeasured. Never copy another version's compliance proof to reassure a customer.

Support forms and feedback notifications have dedupe/rate/ownership checks. Inbox delivery, secure email-change confirmation and real device auth templates remain operational checks. Refer to the dated phase matrices for feature-specific open gates.
