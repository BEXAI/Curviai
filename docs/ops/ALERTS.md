# Alerts runbook

Updated 2026-10-02 for docs/phases/PHASE_20.md P20-17. Every alert Curvi can raise, what it means and the first thing to do. A test (apps/web/src/lib/alerts-doc.test.ts) fails when a down or degraded code in the health severity table (apps/web/src/lib/health-status.ts) has no entry here, so a new warning comes with its runbook line.

The rule: an alert reaches the founder through a channel that does not depend on the broken part. Uptime and cron monitors run outside Render. Founder emails go out through Resend, with Sentry as the second channel. Nothing depends on Sentry alone.

Local alert code and tests do not establish monitor or mailbox delivery. Confirm external checks and real delivery separately in [verification.md](../verification.md); use [RUNBOOK.md](RUNBOOK.md) for current operator actions and release policy.

## Channels

| Channel | Watches | Fires when | Reaches the founder by | Set up |
| --- | --- | --- | --- | --- |
| Monitor A (UptimeRobot, keyword) | `https://curvi.ai/api/health` every 5 minutes | the body does not contain `"ok":true`: the site is down, times out, answers 5xx (a 503 during a bad deploy, or while draining), or reports `ok: false` (the database stopped answering after boot) | push and email | founder, "Monitors" below |
| Monitor B (UptimeRobot, keyword) | the same URL every 5 minutes | the body does not contain `"status":"ok"`: anything monitor A sees, plus every degraded warning (packs paused, a dead cron, a stale backup, high memory, a full database) | email | founder, "Monitors" below |
| healthchecks.io | the nightly backup cron (P20-10, `HEALTHCHECKS_BACKUP_URL`), and the tick cron (P20-38) | a ping does not arrive within the check's period plus grace | email | founder, "Monitors" below |
| Render | deploys | a deploy fails to build or start | email (Render's notification settings) | founder |
| Founder email (Resend) | spend, LLM traffic, provider quota, credit expiry | see "Founder emails" | email to `FOUNDER_ALERT_EMAIL` from `FOUNDER_ALERT_FROM` | `RESEND_API_KEY`, `FOUNDER_ALERT_EMAIL`, `FOUNDER_ALERT_FROM` on Render |
| Sentry (Developer plan, free) | server errors, every `console.error`, pack crashes and time caps, and a copy of every founder email | a new issue | email (an issue alert rule) | `SENTRY_DSN` and the alert rule, "Sentry" below |

## When monitor A fires (down)

1. Open `https://curvi.ai/api/health`. No answer or a Render error page: check the Render dashboard (service events, the last deploy, the instance's memory graph). A crash loop after a deploy: roll back to the previous deploy in Render.
2. A body with `"status":"down"`: read `degradedBy`. The first code is the reason (table below).
3. Still unclear: the detailed report gives each warning in plain words: `curl -s -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/health`.
4. Check Sentry for new issues in the same minutes.

## When monitor B fires (degraded)

1. `curl -s https://curvi.ai/api/health` and read `degradedBy`: each entry is a code from the table below.
2. Run the detailed report (step 3 above) for the plain sentence behind each code.
3. Fix the cause. The monitor clears by itself on its next check once `status` is `ok` again.

`ok` and the HTTP status do not change with `status`: Render restarts only for the down cases it restarted for before (a database that never answered since boot, a schema behind the build, draining).

## Health codes

`/api/health` lists warnings as short codes. Severity: down (the site or its data path is broken, `ok` is false), degraded (packs, payments, backups or alerts are at risk), info (a look is due, nothing is broken). A code that has no row in the severity table counts as degraded, so a new warning is never silently ignored. A code ending in `:*` stands for a family, such as `cron_overdue:stale-jobs`.

### Down

| Code | Means | First action |
| --- | --- | --- |
| `database_failed` | The app's `select 1` failed or took longer than 2 seconds. Before this instance's first full pass it answers 503 (a deploy that cannot reach the database never gets traffic); after it, 200 with `ok: false`. | Supabase dashboard: project status, paused project (Free pauses after a week of inactivity), connection limits. Check `DATABASE_URL` points at the transaction pooler. |
| `schema_behind` | The database lacks a migration this build ships; the instance answers 503 so it never takes traffic. | Apply the missing migration after a fresh backup (docs/LAUNCH_CHECKLIST.md; the guarded `ops:migrate` command), or roll the deploy back. |
| `draining` | The instance received SIGTERM (a deploy, restart or spin down) and is finishing or settling its packs. | Usually nothing: the new instance takes over. If it lasts more than a few minutes, check Render's events for a stuck deploy. |

### Degraded

| Code | Means | First action |
| --- | --- | --- |
| `packs_paused:*` | The new pack preflight pauses every pack that needs a cutout: every configured cutout provider is down. `packs_paused:quota` means the fal accounts are out of credit; `packs_paused:failures` means repeated errors opened the breakers. | Quota: top up the fal account at fal.ai, then wait for the breaker (30 minutes after the last quota answer; an enabled, successful canary or an audited operator reset can clear the preflight block sooner). Do not restart for it. Failures: check fal's status page; it usually clears in minutes. |
| `scenes_paused` | Every configured image provider is down. Packs still deliver white background and cutout files; scenes are paused and not charged. | Check the image providers' credit and status (Gemini, BFL, OpenAI) and the provider probe: `curl -s -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/health/providers`. |
| `maintenance` | New packs are paused by the operator switch `ops:packs_paused` (P20-19). | Expected during a release. Otherwise clear the switch once the reason is gone. |
| `provider_quota:*` | The named provider answered that its account is out of quota or credit, and its breaker is open. Degraded only when it pauses a stage (no other provider of that stage is available); with a backup still serving it is info. | Top up or raise the limit on that provider's account. The founder email and Sentry issue for the same quota answer carry the task. |
| `breaker_open:*` | Every configured provider of that pipeline stage (`cutout`, `scene_plate`, `harmonize`, or an LLM stage) has an open breaker. | Read the matching `provider_quota:*` codes and the provider probe. Failure trips close after 2 minutes; quota trips after 30. |
| `no_*_provider` | No key is set for a stage: `no_llm_provider`, `no_image_provider` or `no_cutout_provider`. | Set the key named in the detailed report on Render (Save only, then deploy). |
| `storage_not_configured` | R2 credentials are missing, so packs cannot be stored. | Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and the bucket on Render. |
| `fal_balance_low` | A fal account's newest balance reading is under its seeded line (P20-16, from PHASE_18 P18-03's balance rows). | Top up that fal account before it runs dry. |
| `cron_never_ran:*` | A scheduled route (`stale-jobs`, `purge-source-media`, PHASE_18's `funnel-digest`, `provider-balance` and `lifecycle`, `billing-reconcile`, `backup`, and the tick cron) has never recorded a successful run. | Check the Render cron service exists, its command calls the route with `CRON_SECRET`, and its last run's log. The leased tick invokes registered due jobs; verify the adopted tick service and optional integration configuration. |
| `cron_overdue:*` | That cron's last success is older than twice its interval; the backup instead once the newest backup is older than the seeded `backup.maxAgeHours` (26 hours, P20-10). | Open the cron service in Render: failed runs, a changed `CRON_SECRET`, or a paused service. For the backup, see healthchecks.io too. |
| `cron_check_failed` | The cron run times could not be read from `platform_settings`. | Usually a database problem; see `database_failed`. |
| `memory_high` | The process uses at least 85 percent of the container's memory limit. An out of memory kill fails running packs. | Render's memory graph. Lower `CURVI_INLINE_PACK_CONCURRENCY` or move up a plan (docs/LAUNCH_CHECKLIST.md, Render plan upgrade). |
| `db_size_high` | The database holds at least 70 percent of the Supabase Free plan's 500 MB (seed `healthLimits`). Past 500 MB Supabase turns it read only and every write fails. | Find the large tables (`select relname, pg_total_relation_size(relid) from pg_catalog.pg_statio_user_tables order by 2 desc limit 10;`), prune old rows with a reviewed retention dry run and bounded pass, or decide on Supabase Pro (founder decision 11). |
| `llm_credits_expired:*` | The seeded provider credits (OpenAI, 2026-12-31) have expired, so that family now bills normally or answers out of credit. | Decide paid usage or move Claude back to primary (docs/phases/PHASE_17.md workstream 5). |
| `llm_model_retiring:*` | A model in an active recipe chain is within 14 days of its earliest retirement date (P20-22; info from 30 days; earliest dates are provider bounds, not confirmed shutdown dates). | Read the provider’s latest retirement notice, evaluate a replacement, and review the intended seed/production traffic split before any approved rollout. Never auto-switch or re-seed from an earliest-date warning. |
| `stripe_secret_key_missing` | Stripe variables are set but `STRIPE_SECRET_KEY` is not, so checkout is closed (P20-01). Each readiness problem closes checkout, so it is info until billing is meant to be live (a live key is set, or a checkout has opened before) and degraded from then on: sales have stopped. | Set the key on Render (Save only, then deploy). |
| `stripe_webhook_secret_missing` | `STRIPE_WEBHOOK_SECRET` is not set, so checkout is closed; a payment could not be verified or granted (P20-01). Info until billing is meant to be live, then degraded. | Set the endpoint's signing secret on Render. |
| `stripe_price_missing` | A self serve `STRIPE_PRICE_*` variable is not set, so checkout is closed (P20-01). Info until billing is meant to be live, then degraded. | Set the price ids the detailed report names (docs/STRIPE_SETUP.md section 1). |
| `stripe_key_mode_mismatch` | The Stripe key's mode does not fit the site (a test key on production, a live key on a laptop or staging, or keys from two modes), so checkout is closed (P20-01). Info until billing is meant to be live, then degraded. | Set keys of the right mode, or label the environment with `NEXT_PUBLIC_ENV_LABEL`. |
| `billing_email_not_configured` | `BILLING_EMAIL_FROM` or `RESEND_API_KEY` is not set, so no plan activation email could go out and checkout is closed (P20-07). Info until billing is meant to be live, then degraded. | Set both on Render: the sender on the verified `updates.curvi.ai` domain and the Resend key. |
| `stripe_*` | Any other Stripe warning: `stripe_webhook_quiet` (a checkout opened and no webhook succeeded since; P20-02), `stripe_webhook_endpoint_mismatch` (the endpoint does not cover the handled events on the pinned API version), `stripe_reconcile_behind` (the last reconcile run hit `billingReconcile.maxEventsPerRun`, processed the oldest events and carries on next run) or `stripe_portal_upgrade_config_missing` (subscribers on a plan and cadence cannot upgrade online; P20-06). Info while checkout is closed, degraded once it is open, since a payment could then go ungranted or an upgrade fail. | Read the detailed report; fix the named variable on Render, or the webhook endpoint in the Stripe Dashboard. Run `pnpm billing:verify`. |
| `billing_email_failing` | The last plan email (activation or plan change) did not go out, for example Resend refused the key or the sender (P20-07). The claim was given back, so the next webhook retry or reconcile sends it. | Check `RESEND_API_KEY` and that `BILLING_EMAIL_FROM` is on a verified domain in Resend; the detailed report names the invoice and Resend's answer. |
| `lifecycle_email_not_configured` | Lifecycle email is switched on (`ops:lifecycle_email_enabled`, PHASE_18 P18-06) but a sender variable is missing, so every lifecycle email is skipped. | The detailed report names the missing variables (`RESEND_API_KEY`, the sender, the unsubscribe link secret or the postal address); set them on Render, or switch email off. |
| `legal_facts_pending` | Stripe is set up while the terms still say the entity, postal address or governing law come later (P20-23, decision 9). Info while checkout is closed, degraded once it is open. | Fill them in apps/web/src/lib/legal/facts.ts with counsel before live keys. |
| `turnstile_secret_missing` | Production runs without `TURNSTILE_SECRET_KEY`, so the anonymous spend endpoints use the stricter fallback limits (P20-29; not emitted until it ships). | Set the secret on Render. |
| `config_check_failed` | The configuration report threw; the other warnings may be missing. | Read the server log line `[health] configuration check failed` and the Sentry issue. |

### Info

| Code | Means | First action |
| --- | --- | --- |
| `recipe_drift` | The `recipes` rows differ from the seed in this build (prompts, models, traffic split). | Compare in the detailed report; make the seed match production before the next `pnpm db:seed`. |
| `recipe_check_failed` | The recipes table could not be read. | See `database_failed`. |
| `fal_admin_key_missing` | A fal inference key is set without the Admin key that reads its balance (PHASE_18 P18-03). | Create an Admin scope key in fal and set `FAL_ADMIN_KEY` (and `FAL_ADMIN_KEY_BACKUP`). |
| `llm_credits_expiring:*` | The seeded credit window is in its reminder period. | Decide before the expiry date (PHASE_17 founder decision 4). |
| `shot_concurrency_invalid` | `CURVI_SHOT_CONCURRENCY` is not a whole number, so the default applies. | Fix or remove the variable. |
| `restore_drill_overdue` | The newest recorded restore drill is older than 35 days (P20-11; seed `restoreDrill.maxAgeDays` in operations.ts). | Run the restore drill and record it. |
| `trigger_secret_ignored` | `TRIGGER_SECRET_KEY` is set but ignored (P20-18). | Remove it from Render. |

## Founder emails

Each goes to `FOUNDER_ALERT_EMAIL` once per period, deduplicated across instances, and is copied to Sentry as an issue tagged `source:founder_alert` with the tags `alert` and `period`, so each new period opens a new issue. If the email cannot be sent, the alert is written as a structured error log line (which Sentry also captures, with the reason the email failed) and an `events` row.

| Subject | `alert` tag | Period | Means | First action |
| --- | --- | --- | --- | --- |
| "Curvi provider spend passed $50.00 on {day}" | `spend_alert` | UTC day | Provider spend for the day passed the alert line. Packs keep running. | Check `generation_jobs.cogs_micros` for a runaway workspace. |
| "Curvi provider spend hit the daily hard stop on {day}" | `hard_stop` | UTC day | The daily hard stop now refuses provider calls; shots go to needs review at no charge until the UTC day rolls over. | Find the cause before an audited `ops:global_hard_stop_usd` change; the environment value remains a fallback. |
| "Curvi: {provider} says the account is out of quota or credit" | `llm_quota` | provider family and UTC hour | An LLM provider answered out of quota; traffic falls back along the chain. | Top up or raise the project budget. |
| "Curvi: {fallback} served {share} of {primary} calls this hour" | `llm_fallback` | UTC hour | The Claude fallback served more than the seeded share of OpenAI first calls. | Look for OpenAI quota, rate limit or outage errors in the `llm_call` and `provider_quota_exhausted` logs. |
| "Curvi: the {name} credits expire on {date}" | `llm_credit_expiry` | reminder date | A seeded credit window's reminder day. | Decide paid usage or the Claude switch back. |
| "{provider} answered that its account is out of quota or credit" | `provider_quota` | provider and UTC hour | Any registered provider family answered out of quota; durable quota state remains current even when the email is deduped. | As `provider_quota:*` above. |

## Sentry

- Events: server request errors (`onRequestError`), every `console.error` (warnings stay in the log), pack crashes and runs past their time cap (errors), packs a shutdown interrupted or settled before they started (warnings), failed settles, and the founder alert copies. Pack events carry the tags `job_id`, `workspace_id`, `run_key` and `run_kind`: search `job_id:<uuid>` to see one pack's errors.
- Nothing secret is sent: request bodies, cookies, query strings, credential headers and link tokens are removed before an event leaves the server (apps/web/src/lib/sentry/scrub.ts).
- Caps (seed `errorReporting`): the same error at most 20 times an hour, at most 60 events an hour and 150 a day per instance, which keeps the free plan's 5k errors a month from running out. When a cap drops events the server logs the warning line `sentry_event_dropped` with the counts; the errors still reach Render's log.
- Without `SENTRY_DSN` nothing is sent and none of this applies.

## Monitors (founder setup)

1. **Monitor A.** UptimeRobot, Keyword monitor, URL `https://curvi.ai/api/health`, interval 5 minutes, keyword `"ok":true`, alert when the keyword does not exist. Alert contacts: the mobile app (push) and email.
2. **Monitor B.** A second keyword monitor on the same URL, keyword `"status":"ok"`, alert when it does not exist. Alert contact: email.
3. **healthchecks.io.** A check named `curvi-backup` with a period of 1 day and a grace time that covers the backup's run time (start with 2 hours), email alerts on. Put its ping URL in `HEALTHCHECKS_BACKUP_URL` on the backup cron service only (P20-10). After the first run, confirm the check shows "up": a wrong check id still answers HTTP 200. Create the `curvi-tick` check for its seeded ten-minute schedule with an appropriate grace period; only the tick launcher holds `HEALTHCHECKS_TICK_URL`. Pinging one check more than 5 times a minute may be rate limited.
4. **Render.** Turn on email notifications for failed deploys.
5. **Sentry.** Create the project (Next.js), set `SENTRY_DSN` on Render, and add an issue alert rule that emails on every new issue. Founder alert copies open a new issue per period, so each one emails.

Checks that are safe on production (P20-17 acceptance; the staging 503 drill joins the Release 4 gate):

- healthchecks.io: create a temporary check with a short period (for example 5 minutes, grace 5 minutes) and never ping it, or pause the backup's ping; an alert email should arrive within 30 minutes. Then delete the temporary check.
- UptimeRobot: create a temporary keyword monitor on `https://curvi.ai/api/health` with a keyword that never appears; an alert should arrive within 10 minutes. Then delete it.

## Resend: sending without a verified domain

Checked 2026-10-01 (docs/verification.md, PHASE_20): the shared `resend.dev` test sender only delivers to the Resend account owner's own address; anything else gets a 403 ("You can only send testing emails to your own email address"). A `from` address on a domain that is not verified gets a 403 domain mismatch: the domain of `from` must match a verified domain exactly, subdomain included. Curvi's verified sender domain is `updates.curvi.ai`, so `FOUNDER_ALERT_FROM` (and `BILLING_EMAIL_FROM`) must be an address on it; the default `alerts@curvi.ai` works only once `curvi.ai` itself is verified. When a founder email fails, the alert's log line carries the notice (for example "Resend returned status 403"), and Sentry receives both the alert copy and that log line.

## Durable cockpit alerts (P20-47)

The tick evaluates seeded failed-pack/failure-rate, stale-job, queue-wait, signup/withheld-grant, gallery submission and unusable-feedback rules. Health samples add repeated memory, database size, restore and cron warnings. Reconciliation, workspace-cap and margin rules use supplied telemetry; if a sample is absent its rule is not falsely resolved. The tick supplies current UTC cap and margin samples through `ops/alert-signals.ts`; incomplete historical QC omits margin telemetry rather than clearing an existing alert.

Each rule/subject has a durable open/resolved history. Delivery uses a lease, deterministic idempotency key and retries; a deduped send is not evidence of mailbox receipt. Open the cockpit, inspect the linked job/workspace and resolve the cause, then confirm the next evaluation records recovery and the recovery notification arrives. The seeded provider canary stays off without `CURVI_PROVIDER_CANARY_ENABLED=1`; do not enable paid probes during an unapproved incident investigation.
