# Launch checklist: external steps before paid launch

Written 2026-09-28 for Phase 10 batch 1 (docs/phases/PHASE_10.md). Every step here happens outside the repo: in a dashboard, a DNS zone, a contract, or a production database. The code side of each step is already in the repo unless the step says otherwise.

How to use it: work top to bottom. Steps marked "start early" only take calendar time (DNS, review, account activation), so begin them on day one and finish them in order. Each step says who does it, what to do, and how to know it worked. When a step is done, record it with the date in docs/verification.md (CLAUDE.md rule 7).

Every external setting name, value and limit below was checked against the linked official page on 2026-09-28. Anything that could not be confirmed says so.

| # | Step | Who | Blocks |
|---|---|---|---|
| 1 | Legal review of terms and privacy (start early) | Founder with a lawyer | Paid launch |
| 2 | Resend sending domain with SPF, DKIM and DMARC (start early) | Founder | Step 3 |
| 3 | Supabase custom SMTP through Resend | Founder | Signups outside the team |
| 4 | Inbound mail for support@curvi.ai | Founder | Support replies |
| 5 | Render deploys only after CI passes | Founder | Step 7 |
| 6 | Apply migrations 0011 to 0013 to production, then run `pnpm db:seed` | Founder | Step 7 |
| 7 | Add the batch 1 environment variables, then push main (batch 1 goes live) | Founder, engineer for `.env.example` | Steps 8 to 13 |
| 8 | Render health check path and shutdown delay | Founder | Safe deploys |
| 9 | Render plan upgrade (done 2026-10-01: `1c-2g`, 1 CPU, 2 GB, $25 a month; set the concurrency below) | Founder (costs money) | Paid launch |
| 10 | Stripe live mode | Founder | First dollar |
| 11 | Upstash Redis | Founder | Shared rate limits |
| 12 | PostHog | Founder | Funnel data |
| 13 | Sentry | Engineer, then founder | Error alerts |
| 14 | Inline runner and shared tick cron | Engineer, then founder | Packs and scheduled jobs |
| 15 | Uptime monitor | Founder | Outage alerts |
| 16 | Post deploy smoke test | Founder | Announcing paid plans |

## Deploy order for batch 1

Do these in exactly this order. Main auto deploys, so everything the new code needs must be in production before the push.

1. Step 5: Render deploys only after CI passes.
2. Step 6: apply migrations 0011, 0012 and 0013 to production, in that order.
3. Step 6: run `pnpm db:seed` against production right after the migrations. Until it runs, migration 0012's signup grant finds no `free_signup_credits` setting, so new confirmed signups get no free credits; the seed writes the setting and then settles those signups.
4. Step 7: add the new environment variables to Render with Save only (they take effect with the deploy in the next line), and to `.env.example`.
5. Step 7: push main, then wait for CI and the Render deploy, and check `/api/health`.
6. Step 8: only now set Render's health check path to `/api/health`, and the shutdown delay.

## 1. Legal review of terms and privacy (start early)

**Who:** founder, with a lawyer.

**Do:** have counsel review the live pages at https://curvi.ai/terms, https://curvi.ai/privacy and https://curvi.ai/legal/subprocessors (source: `apps/web/src/app/(marketing)/terms/page.tsx`, `privacy/page.tsx` and `legal/subprocessors/page.tsx`). Every fact and number on them comes from `apps/web/src/lib/legal/facts.ts`, the retention table from `lib/legal/retention.ts` and the vendor list from `lib/legal/subprocessors.ts` (PHASE_20 P20-23). Points to cover:

- The founder supplied and authorized the public legal entity name and postal address in `apps/web/src/lib/legal/facts.ts` on 2026-10-02. Review the rendered details with counsel. Keep `entity.governingLaw` null and its pending notice until explicitly chosen; incorporation in Delaware does not choose governing law. Record the applicable publication dates and rendered fingerprints in `lib/legal/pages.test.ts` when copy changes. Existing terms-acceptance records do not establish acceptance of revised text.
- Credits, subscriptions and refunds as the product actually works: credits are held when a pack starts, charged only for delivered assets, and released otherwise; a refund or dispute claws back the credits that invoice granted (PHASE_10 decision 3); annual plans grant the year of credits on the paid invoice (decision 2).
- Uploaded content: the license customers grant to process their photos, retention and deletion.
- AI generated output: Concept Mode images are generated and labeled as such; Listing Mode keeps the real product pixels. Acceptable use, and the moderation gate that holds flagged uploads.
- Subprocessors: the page lists only the vendors whose variables the build sees (Render, Supabase and Cloudflare always; Stripe, Resend, PostHog, Sentry, Upstash, Turnstile on Cloudflare, and the model providers Anthropic, Google (Gemini), Black Forest Labs, OpenAI and fal when their keys are set; the OpenAI Ads pixel unless it is turned off). Trigger.dev is not on it: `TRIGGER_SECRET_KEY` stays unset (PHASE_20 P20-18 removes the path). The marketing pages are built at deploy time, so a vendor variable saved with Save only shows on the page from the next deploy.
- Privacy rights for EU, UK and California visitors, and whether PostHog analytics needs a consent banner for EU traffic.

**Verify:** the lawyer's written sign off is on file with a date; both pages show the reviewed text and an effective date; a code change carrying the new text has shipped (copy follows CLAUDE.md rule 9).

## 2. Resend sending domain with SPF, DKIM and DMARC (start early)

**Who:** founder (needs the Resend account and Cloudflare DNS access for curvi.ai).

**Do:**

1. In Resend, Domains, add a sending subdomain rather than the root. Resend recommends a subdomain "to isolate your sending reputation", for example `updates.curvi.ai`.
2. In Cloudflare DNS for the curvi.ai zone, add exactly the records Resend shows. For a subdomain they look like this (copy the real values from Resend; when pasting, leave the root domain off the name, so `send.updates`, not `send.updates.curvi.ai`):
   - MX, name `send.updates`, mail server like `feedback-smtp.us-east-1.amazonses.com`, priority 10.
   - TXT, name `send.updates`, SPF value like `v=spf1 include:amazonses.com ~all`.
   - TXT, name `resend._domainkey.updates`, the DKIM key Resend shows, proxy status DNS only.
3. Add DMARC for the organizational domain: TXT, name `_dmarc`, value `v=DMARC1; p=none; rua=mailto:dmarc@curvi.ai;`. The rua mailbox must receive mail (step 4). After two to four weeks of clean reports, change `p=none` to `p=quarantine`.

**Verify:** Resend shows the domain as Verified. Send a test from Resend to a Gmail address; in Gmail, Show original reports SPF PASS, DKIM PASS and DMARC PASS. `dig TXT _dmarc.curvi.ai +short` returns the DMARC record.

**Sources:** https://resend.com/docs/dashboard/domains/introduction, https://resend.com/docs/dashboard/domains/cloudflare, https://resend.com/docs/dashboard/domains/dmarc (checked 2026-09-28).

## 3. Supabase custom SMTP through Resend

Why this blocks launch: without custom SMTP, Supabase Auth sends only to "pre-authorized addresses" (the project team), at "2 messages per hour", with no delivery SLA. Every other signup fails with "Email address not authorized", so real customers never get a confirmation email, and free credits are granted only on a confirmed email (PHASE_10 decision 4).

**Who:** founder.

**Do:**

1. In Resend, create an API key with sending access for the domain from step 2. Use a key separate from the app's `RESEND_API_KEY`.
2. Supabase dashboard, Authentication, Emails (Notifications), SMTP Settings, enable custom SMTP:
   - Sender email: an address on the verified domain, for example `accounts@updates.curvi.ai`
   - Sender name: `Curvi`
   - Host `smtp.resend.com`, port `465`, username `resend`, password: the API key from 1.
3. Supabase, Authentication, Rate Limits: custom SMTP starts at "30 messages per hour". Raise the email limit to fit launch traffic (the founder picks the number).
4. Supabase, Authentication, URL Configuration: Site URL `https://curvi.ai`; the redirect URL list includes `https://curvi.ai/auth/callback` (signup and password reset both return there).
5. Keep email confirmation turned on for email signups.
6. Optional now, needed before scale: edit the confirm, reset and email change templates to plain spoken copy (rule 9).

**Verify:** sign up on https://curvi.ai/signup with a fresh address that is not on the Supabase team. The confirmation email arrives within a minute from the Curvi sender, and Gmail's Show original shows SPF, DKIM and DMARC PASS. The link lands signed in on curvi.ai. A password reset email also arrives. Resend, Emails, lists both as Delivered.

**Sources:** https://supabase.com/docs/guides/auth/auth-smtp, https://resend.com/docs/send-with-supabase-smtp (checked 2026-09-28).

## 4. Inbound mail for support@curvi.ai

support@curvi.ai appears across the site as the contact address, and DMARC reports need a mailbox.

**Who:** founder.

**Do:** Cloudflare dashboard, Compute, Email Service, Email Routing: onboard curvi.ai (Cloudflare adds its MX, SPF and DKIM records at the root), add the founder's inbox as a verified destination, and create routing rules for `hello` and `dmarc`. Resend's MX lives on `send.updates`, so the two do not collide; remove any other MX records on the root first.

**Verify:** mail sent from an outside account to support@curvi.ai and dmarc@curvi.ai reaches the founder's inbox.

**Source:** https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/ (checked 2026-09-28).

## 5. Render deploys only after CI passes

Today Render deploys every push to main whether CI is green or red.

**Who:** founder.

**Do:** Render dashboard, the Curviai service, Settings, Auto-Deploy: choose **After CI Checks Pass**. Render's description: "With each change to your linked branch, Render triggers a deploy only after all of your repo's CI checks pass." render.yaml already records the same setting as `autoDeployTrigger: checksPass` (the Blueprint field that replaces the deprecated `autoDeploy`), but the service was created by hand in the dashboard, so the dashboard setting is the one that counts.

How Render judges the checks: it reads GitHub Actions results for the commit. A check passes when its conclusion is success, neutral or skipped. Render does not deploy when any check fails, or when zero checks are found for the commit. Our workflow (.github/workflows/ci.yml) runs `checks` (lint, typecheck including the e2e specs, unit tests) and `e2e` on every push to main, and never cancels a run on main, so every commit on main gets a result.

**Verify:** the setting shows After CI Checks Pass. On the next push to main, the Render Events tab shows the deploy starting only after both CI jobs finish green on GitHub. If a commit on main ever fails CI, Render shows no deploy for it and the previous version keeps serving. Manual Deploy in the dashboard still works for emergencies.

**Sources:** https://render.com/docs/deploys (Automatic deploys), https://render.com/docs/blueprint-spec (checked 2026-09-28).

## 6. Apply migrations 0011 to 0013 to production, then run `pnpm db:seed`, before pushing main

Batch 1 code needs 0011 (tenant write lockdown), 0012 (signup grant on confirmed email) and 0013 (source media dedupe), and 0012 needs the seeded `free_signup_credits` setting. Main auto deploys, so the migrations and the seed go first.

**Who:** founder (an engineer can prepare and review the SQL with them).

**Do:**

1. Confirm production is at 0010: `select id, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1;` should return the `when` of `0010_spend_cap_counters` from `packages/db/migrations/meta/_journal.json`. The table exists since 2026-09-28 (docs/verification.md).
2. Use the **direct connection** string (Supabase, Connect, Direct connection, port 5432). Supabase recommends it for migrations; the transaction pooler (port 6543) does not support prepared statements. The direct host is IPv6 only without the IPv4 add on; from an IPv4 only network use the session pooler (also port 5432).
3. From a checkout of the merged batch, load the connection string without leaving the password in shell history (`read -s DATABASE_URL && export DATABASE_URL`, then paste), and run `pnpm db:migrate`. Drizzle applies only migrations newer than the newest recorded row, so it runs exactly 0011, 0012 and 0013 in order. (The by hand alternative used on 2026-09-28: run the three files in one transaction in the SQL editor, then record each in `drizzle.__drizzle_migrations` with the sha256 of the file and the journal `when`.)
4. Each migration must keep working with the code that is live right now, because the old instance keeps serving until the new deploy is healthy (expand first, contract in a later release).
5. Right after 3, in the same shell and checkout, run `pnpm db:seed`. It upserts the channel spec registry, the recipe rows and the platform settings (including `free_signup_credits`) from `packages/pipeline` seed data, then settles the signup grant of every confirmed user who has none yet. It is idempotent: run it again after every later migration or seed change. The code live before batch 1 does not read these rows, so seeding before the push is safe. It ends by printing `Seeded ... Settled N pending signup grants.`
6. Clear the variable when done: `unset DATABASE_URL`.

**Verify:** the query from 1 now returns the `when` of `0013_*`. `select value from platform_settings where key = 'free_signup_credits';` returns the free tier's one time grant from `packages/pipeline/src/seed/credits.ts`. The production spot checks each package recorded for its migration in docs/verification.md pass (for example, for 0012, a new confirmed signup gets exactly one grant). After step 7, `/api/health` reports `"schema":"current"`. Once step 8 is done, a build whose migrations are missing never receives traffic: its health check returns 503 with `"schema":"behind"` and Render cancels the deploy after 15 minutes while the old version keeps serving.

**Source:** https://supabase.com/docs/guides/database/connecting-to-postgres (checked 2026-09-28).

## 7. Add the batch 1 environment variables, then push main

**Who:** founder for Render; an engineer adds the same names to `.env.example` in the repo (CLAUDE.md rule 8).

**Do:**

1. Render, the Curviai service, Environment: add the variables from "Environment variables added in batch 1" at the end of this file that apply now. Choose **Save only**: Render then uses them from the next deploy, which is the push below, and the old code keeps running untouched. (Save and deploy would restart the old code for nothing.) Every one of them is optional: unset, the code uses the default in the table.
2. `.env.example`: add every name in that table, with an empty value or the default and a one line comment, in the same change as (or before) the merge.
3. Merge `full-stack-update` into main only after step 5, step 6 and the two items above. Then watch CI, and the Render deploy that follows it.

**Verify:** `curl -s https://curvi.ai/api/health` returns HTTP 200 with `"ok":true`, `"mode":"db"`, `"database":"ok"`, `"schema":"current"`, `"warnings":[]` and `"commit"` equal to the first seven characters of the pushed commit. A warning such as `storage_not_configured`, `no_llm_provider` or `no_image_provider` means a Render environment variable is missing; packs cannot be delivered until it is set. Render, Environment lists the new variables you set.

## 8. Render health check path and shutdown delay

**When:** only after step 7, once `curl -s https://curvi.ai/api/health` on production returns 200 with `"schema":"current"` and the pushed commit. Not before: the code live before batch 1 has no `/api/health`, and a path that returns 404 marks the instance unhealthy, so Render would stop routing to it after 15 seconds and restart it every minute. `render.yaml` already lists `healthCheckPath: /api/health`, but the live service was created by hand in the dashboard and does not follow render.yaml, so the dashboard setting below is the one that counts. Do not sync render.yaml as a Blueprint before step 7 either.

**Who:** founder.

**Do:**

1. Render, the Curviai service, Settings, Health Checks, Edit: path `/api/health`, Save Changes. Render then routes traffic to a new deploy only once every new instance passes, cancels a deploy that never passes within 15 minutes, stops routing to an instance after 15 seconds of failures and restarts it after 60 seconds. Checks time out after five seconds; the endpoint's database steps time out after two. Missing env values only show up as `warnings` and never fail the check.
2. Shutdown delay (not in the dashboard; Render documents it for render.yaml and the API): `PATCH https://api.render.com/v1/services/<service id>` with header `Authorization: Bearer <Render API key>` and body `{"serviceDetails":{"maxShutdownDelaySeconds":300}}`. Allowed range 1 to 300, default 30.
3. Environment: `CURVI_INLINE_PACK_CONCURRENCY` = `1` if step 7 did not add it (raise it in step 9).
4. Only after the API shows 300 in step 2: optionally set `CURVI_SHUTDOWN_GRACE_MS` = `240000`, so a deploy lets running packs finish for up to four minutes before settling them. Leave it unset otherwise; the default grace (20 seconds) fits inside Render's default 30.

When the check answers 503, and why a database outage does not restart the instance: `/api/health` answers 503 in three cases only. First, when the database does not answer and this instance has not yet passed a whole check (database answering, schema not behind, not draining) since it started: that is the boot readiness gate, so a new deploy that cannot reach the database never receives traffic and the old version keeps serving. Second, while the database is behind this build's migrations. Third, while the instance is draining for shutdown. Once a whole check has passed, a later database failure or a check slower than two seconds is reported in the body (`"ok":false`, `"database":"failed"`) but the endpoint still answers 200. A restart would not fix the database and would cost a lot: the shutdown drain fails the packs still running once the grace window ends, and the marketing site and the Stripe webhook go offline while the instance comes back. A slow but working database, or a busy instance, could otherwise trigger that restart with no real outage. Database outage alerts come from the uptime monitor in step 15, which checks the body for `"ok":true`.

What happens on a deploy or restart: Render sends SIGTERM to the old instance 60 seconds after the new one is live. The inline runner stops taking packs, marks every pack that had not started as failed and releases its credits, waits the grace window for running packs, then settles whatever is still running: failed, with the job error "The server restarted while this pack was running. Reserved credits were released, so you can run it again.", or done when its files were already delivered, in which case every delivered asset is charged and the rest of the hold is released. No job is left in a working state.

What happens to a pack that hangs: each inline pack run has a wall clock cap, `CURVI_INLINE_PACK_MAX_RUN_MS` (25 minutes unless set, always below the stale run reconciler's 30 minutes). When it passes, the runner settles the job the same way (failed, with the job error "This pack took longer than the time limit, so it was stopped. Reserved credits were released, so you can run it again.", or done and charged if its files were already delivered), frees the slot and starts the next waiting pack. `/api/health` counts runs past the cap under `packs.overdue`. A job that waits more than an hour for a slot stops heartbeating, so the stale run reconciler can fail it and release its credits if the queue is stuck.

**Verify:** the Health Checks section shows `/api/health`. `GET https://api.render.com/v1/services/<service id>` shows `serviceDetails.healthCheckPath` `/api/health` and `serviceDetails.maxShutdownDelaySeconds` 300. Drill: start a pack, then click Manual Deploy. The pack either finishes, or ends failed with its held credits back in the balance (the job board shows its generic failure line for these errors today). The old instance's log shows `[jobs] SIGTERM: inline runner drained (...)`.

**Sources:** https://render.com/docs/health-checks, https://render.com/docs/deploys (Graceful shutdown), https://render.com/docs/blueprint-spec, https://api-docs.render.com/reference/update-service, https://render.com/docs/configure-environment-variables (checked 2026-09-28).

## 9. Render plan upgrade

**Status (2026-10-01):** done. The Curviai web service runs on `1c-2g` (legacy name Standard): 1 CPU, 2 GB RAM, $25 a month as shown on the founder's Render dashboard. render.yaml says `plan: 1c-2g` and `CURVI_INLINE_PACK_CONCURRENCY` `"2"` to match. The live service was created by hand and does not follow render.yaml, so `CURVI_INLINE_PACK_CONCURRENCY` = `2` must also be set in the dashboard (Environment); until then the runner keeps its default of 1. Still to check from step 8: `maxShutdownDelaySeconds` 300 on the live service, then optionally `CURVI_SHUTDOWN_GRACE_MS` = `240000`.

Why it mattered: Render says of free instances: "Do not use them for production applications." They spin down after 15 minutes without traffic (about a minute to wake), run on 0.1 CPU and 512 MB, and cannot scale past one instance. A spin down or a deploy on the free plan killed running packs.

**Who:** founder.

**Do:** change the service's compute plan in the Render dashboard (or through the API: `serviceDetails.plan`). Plan IDs since August 2026 (old names still work): `0.5c-512mb` (Starter), `1c-2g` (Standard), `2c-4g` (Pro). Pack rendering is CPU and memory heavy: pick at least `1c-2g`, and `2c-4g` for launch traffic. Prices: https://render.com/pricing (not repeated here; check on the day). Then set `CURVI_INLINE_PACK_CONCURRENCY` to match memory: 1 on 512 MB, 2 on 2 GB, 3 on 4 GB, and raise only while Render's memory graph stays well below the limit with that many packs running. Optionally set `NODE_OPTIONS` to `--max-old-space-size=` about three quarters of the plan's memory in MB. Update `plan:` in render.yaml to match.

**Verify:** the dashboard shows the new plan. After 20 idle minutes the home page loads in under two seconds (no spin up). During a pack, the Metrics tab shows memory below the limit.

**Source:** https://render.com/docs/free, https://render.com/docs/compute-plans (checked 2026-09-28).

## 10. Stripe live mode

**Who:** founder.

**Do:** follow docs/STRIPE_SETUP.md (written by the billing package in this batch): live keys, products and prices, the webhook endpoint `https://curvi.ai/api/webhooks/stripe` and its signing secret, customer portal, tax and promotion settings, and the `STRIPE_PRICE_*` variables in Render.

**Verify:** the checks at the end of docs/STRIPE_SETUP.md, including one live purchase that grants credits exactly once and a refund that claws them back.

## 11. Upstash Redis

Without it, rate limits run in process (PHASE_10 decision 5): each instance counts separately and the counts reset on every deploy.

**Who:** founder.

**Do:** Upstash console, Redis, Create Database, in a US West region near Render's Oregon region. Copy the REST URL and token into Render as `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the names the `@upstash/redis` SDK reads; the Upstash getting started page did not show where the REST values sit in the console on 2026-09-28, so look on the database's details page).

**Verify:** after the redeploy, requests past a rate limit return 429, and the database's usage graph in Upstash shows commands arriving.

**Source:** https://upstash.com/docs/redis/overall/getstarted (checked 2026-09-28).

## 12. PostHog

**Who:** founder.

**Do:** create a PostHog project and set `NEXT_PUBLIC_POSTHOG_KEY` in Render. For an EU project also set `NEXT_PUBLIC_POSTHOG_HOST` to the EU host; the code defaults to `https://us.i.posthog.com` (`apps/web/src/components/analytics.tsx`). `NEXT_PUBLIC_*` values are compiled into the build, so deploy with a fresh build after setting them; a restart alone does not pick them up.

**Verify:** after visiting https://curvi.ai, PostHog's live events show `$pageview` from curvi.ai.

## 13. Sentry

**Status:** wired for the server and edge runtimes (docs/phases/PHASE_20.md P20-13, `@sentry/nextjs` 11.2.0): `apps/web/src/instrumentation.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts` and `lib/sentry/`. Without `SENTRY_DSN` nothing is initialized and nothing is sent. The browser side, `app/global-error.tsx` and the 404 page come with P20-14 (Release 3).

**Who:** founder.

**Do:**

1. Create a Sentry account on the free Developer plan (decision 13: 5k errors a month, one user, email alerts) and a Next.js project.
2. On Render, web service, Environment, Save only: `SENTRY_DSN` (the project's DSN), and for readable stack traces `SENTRY_AUTH_TOKEN` (an organization auth token with release and source map scopes; a secret), `SENTRY_ORG` and `SENTRY_PROJECT` (the slugs). The token is read only by `next build`; without it the build succeeds and stack traces stay minified (checked 2026-10-01). Render sets `RENDER_GIT_COMMIT`, which names the release.
3. In Sentry, add an issue alert rule that emails you on every new issue.
4. Deploy.

| Name | Read by | Unset means |
| --- | --- | --- |
| `SENTRY_DSN` | `apps/web/src/lib/sentry/options.ts` (server and edge) | No Sentry: nothing is initialized or sent, founder alerts go by email only. |
| `SENTRY_AUTH_TOKEN` | `apps/web/next.config.ts`, at build time only | Source maps are not uploaded and no release is created; stack traces stay minified. The build still succeeds. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | `apps/web/next.config.ts`, at build time only | Source maps cannot be uploaded. |
| `NEXT_PUBLIC_SENTRY_DSN` | P20-14 (browser errors, Release 3) | Not read yet. |

What it sends: server request errors, every `console.error` line (warnings stay in the log), pack crashes and time caps tagged with `job_id`, `workspace_id`, `run_key` and `run_kind`, and a copy of every founder alert. Request bodies, cookies, query strings, credential headers and link tokens are removed first. At most 20 events of one error an hour, 60 an hour and 150 a day per instance (seed `errorReporting`). docs/ops/ALERTS.md, "Sentry", has the details.

**Verify:** the first error after the deploy (any `console.error` line in Render's log) appears in Sentry with a readable stack trace, and the new issue email arrives. A pack error carries its job: search `job_id:<uuid>`. Nothing arrives at all: check `SENTRY_DSN` and look for the `sentry_event_dropped` warning in the log.

**Source:** https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/ and /configuration/options/ (checked 2026-10-01, docs/verification.md, PHASE_20).

## 14. Inline packs and the shared tick cron

PHASE_20 removes the Trigger.dev SDK and cloud task wrappers. Packs run inside the bounded web runner. Keep `TRIGGER_SECRET_KEY` unset and remove any retired dashboard value; it is no longer a worker-routing control. The `@curvi/trigger` workspace remains as shared tested pipeline code.

The production Blueprint describes one `curvi-tick` scheduler. The encrypted-backup scheduler plan was retired on 2026-10-03. See the combined production inventory below for the exact separation of environment variables and the safe adoption procedure. Do not create a new worker or duplicate existing cron services. First prove the tick, health heartbeat and per-job successes, then retire the old dashboard cron commands. The first real Monday report remains a live acceptance check.

## 15. Uptime monitor

**Who:** founder. The full list of alerts, what each means and the first action is docs/ops/ALERTS.md (docs/phases/PHASE_20.md P20-17).

**Do:**

1. **Monitor A**, UptimeRobot Free (decision 14; its terms allow commercial use): a Keyword monitor on `https://curvi.ai/api/health` every 5 minutes, keyword `"ok":true`, alert when the keyword does not exist, by push (the mobile app) and email. The body match is required, not optional: after an instance has started, a database outage answers 200 with `"ok":false` (step 8 explains why), so a monitor that only checks the status code never sees it.
2. **Monitor B:** a second keyword monitor on the same URL, keyword `"status":"ok"`, email. It also fires for degraded warnings that leave `ok` true: packs paused for a provider, a dead cron, high memory, a nearly full database (`status` and `degradedBy` in the body, P20-15).
3. **healthchecks.io:** configure the tick heartbeat with the approved monitor plan and verify that the actual check shows "up" after a scheduled run. No backup monitor is required.
4. **Render:** email notifications for failed deploys on.

**Verify** (both safe on production): a temporary UptimeRobot keyword monitor on `https://curvi.ai/api/health` with a keyword that never appears alerts within 10 minutes, then delete it; a temporary healthchecks.io check that is never pinged emails within 30 minutes, then delete it. Record both, dated, in docs/verification.md. The staging 503 drill (both monitors fire) joins the Release 4 gate.

## 16. Post deploy smoke test

Run the short version after every deploy of main, and the full version once before announcing paid plans. Record the full run in docs/verification.md (it is the Update.md Wave 0 gate).

**Who:** founder.

Short version:

1. `curl -s -w "\n%{http_code}\n" https://curvi.ai/api/health`: 200, `"ok":true`, `"mode":"db"`, `"database":"ok"`, `"schema":"current"`, `"warnings":[]`, and `"commit"` matching the deployed commit.
2. https://curvi.ai, /pricing and /login load quickly and look right.

Full version, in addition:

3. Sign up with a fresh address outside the Supabase team. The confirmation email arrives (step 3); after confirming, the dashboard shows the free signup credits exactly once.
4. Upload a real product photo, create a Listing Mode pack for one marketplace channel, and watch it move from queued to done.
5. Download the channel zip and the compliance report. The main image meets the channel spec, and the product looks exactly like the photo.
6. The credit balance shows charges only for delivered assets, and nothing is still held for the job.
7. Request a password reset; the email arrives and the link works.
8. Run the billing checks in docs/STRIPE_SETUP.md.
9. Render logs show no errors for the session (and Sentry no new issues, once step 13 is done).

## Environment variables added in batch 1

Set these in Render (the Curviai service, Environment, **Save only**, step 7) and list every name in `.env.example` (CLAUDE.md rule 8). None is needed to boot: unset, the code uses the default below. Packs run inline in the web service today, so these belong on the web service. The inline web runner owns these keys. The tick cron only calls the web route and does not receive provider or email keys.

| Name | Read by | Unset means | Meaning and when to set it |
|---|---|---|---|
| `STRIPE_TAX_ENABLED` | Checkout (`apps/web/src/lib/billing/stripe.ts`) | Tax off | Set to `1` only after Stripe Tax registrations exist (docs/STRIPE_SETUP.md). Turns on automatic tax, a required billing address and tax id collection in Checkout. Any other value leaves tax off. |
| `FOUNDER_ALERT_EMAIL` | Spend alerts (`trigger/src/spend-alerts.ts`) | Alerts only reach the server log | The founder address that gets the daily provider spend alert and the hard stop notice, once per day each. Needs `RESEND_API_KEY` as well. |
| `FOUNDER_ALERT_FROM` | Spend alerts | `Curvi Alerts <alerts@curvi.ai>` | Sender of those alerts. It must be an address on a domain verified in Resend. Step 2 verifies the `updates.curvi.ai` subdomain, so set something like `Curvi Alerts <alerts@updates.curvi.ai>`; the default sender needs `curvi.ai` itself verified. |
| `CURVI_INLINE_PACK_CONCURRENCY` | Inline pack runner | `1` | Packs one web instance runs at once; the rest wait in order. 1 on 512 MB, 2 on 2 GB, 3 on 4 GB (step 9). Production is on 2 GB (`1c-2g`), so set `2`. Clamped to 1 to 16. |
| `CURVI_SHUTDOWN_GRACE_MS` | Inline pack runner | `20000` | How long a deploy or restart lets running packs finish before settling them. Keep it below Render's shutdown delay: leave it unset while the delay is the default 30 seconds, and use `240000` only once `maxShutdownDelaySeconds` is 300 (step 8). Clamped to 0 to 290000. |
| `CURVI_INLINE_PACK_MAX_RUN_MS` | Inline pack runner | `1500000` (25 minutes) | Wall clock cap for one pack run. When it passes, the job is settled (failed, or done and charged if its files were delivered) and its slot goes to the next pack. Clamped to 60000 to 1740000 (1 to 29 minutes) so it always ends before the 30 minute stale run reconciler. |
| `UPSTASH_REDIS_REST_URL` | Rate limits (`apps/web/src/lib/rate-limit.ts`) | Each instance counts on its own | REST URL of the Upstash Redis database (step 11). Set both Upstash values or neither. |
| `UPSTASH_REDIS_REST_TOKEN` | Rate limits | Each instance counts on its own | REST token for that database. A secret: Render only, never in the repo. |

Lines for `.env.example` (values stay empty; the comments carry the defaults):

```
# Stripe Tax in Checkout: 1 turns it on, only after tax registrations exist in Stripe.
STRIPE_TAX_ENABLED=
# Founder spend alert email through Resend (needs RESEND_API_KEY). Unset: server log only.
FOUNDER_ALERT_EMAIL=
# Sender for those alerts, on a Resend verified domain. Default: Curvi Alerts <alerts@curvi.ai>
FOUNDER_ALERT_FROM=
# Inline pack runner (used while TRIGGER_SECRET_KEY is unset).
# Packs run at once per instance. Default 1.
CURVI_INLINE_PACK_CONCURRENCY=
# Milliseconds a shutdown waits for running packs. Default 20000; keep below Render's shutdown delay.
CURVI_SHUTDOWN_GRACE_MS=
# Wall clock cap per pack run in milliseconds. Default 1500000 (25 minutes), max 1740000.
CURVI_INLINE_PACK_MAX_RUN_MS=
# Shared rate limit counters. Unset: each instance counts on its own.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

`render.yaml` lists the same names. `CURVI_INLINE_PACK_CONCURRENCY` carries the value `1`; the others are `sync: false`, which Render reads only when a Blueprint first creates a service (it prompts for the values then) and ignores for a service that already exists, like the hand made Curviai service. So render.yaml documents them, and the dashboard is where they are set.

**Sources:** https://render.com/docs/blueprint-spec, https://render.com/docs/configure-environment-variables (checked 2026-09-28).

## Batch 2 trust: account deletion, data export, source purge, upload ingest, terms record

Written 2026-09-28 for branch b2/trust (docs/phases/PHASE_11.md). The code is in `apps/web/src/lib/trust/` and `packages/pipeline/src/ingest/`.

### Apply migration 0015_trust

**Who:** founder, with the same process as step 6 (Supabase SQL editor, direct connection, founder approval).

**Do:** run `packages/db/migrations/0015_trust.sql`. It creates `terms_acceptances` (RLS on, members read their own rows, no write policy) and the `source_media_created_at_idx` index the purge uses. It changes no existing rows.

**Verify:** `select relrowsecurity from pg_class where relname = 'terms_acceptances'` returns true; after the deploy, sign in and check that one row for your user appears in `terms_acceptances` with your IP.

### Schedule the 30 day source purge

What it does: once a day, `POST /api/cron/purge-source-media` deletes source uploads (and their masks) older than 30 days whose product had no pack in the last 30 days, never while a pack for that product is running and never a photo a share link shows as its "before" image. It also deletes orphan uploads under `ws/{id}/src/` older than 30 days that no row and no brand kit logo points at. Delivered pack files are not touched. Each run handles at most 500 source rows and lists at most 5000 objects for the orphan sweep; the next run carries on. The settings page tells sellers about this retention.

**Who:** founder.

**Do:**

1. Generate a long random secret (for example `openssl rand -hex 32`) and set it as `CRON_SECRET` on the Curviai web service in Render (Save only; it applies with the next deploy).
2. After the deploy, run a dry run by hand and read the report: `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "https://curvi.ai/api/cron/purge-source-media?dryRun=1"`. `rowsMatched` and `orphansDeleted` show what a real run would delete.
3. Create a Render Cron Job service with the schedule `30 3 * * *` (Render cron schedules run in UTC, so this is 03:30 UTC daily), any small instance, the same `CRON_SECRET` value, and the command `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/cron/purge-source-media`. Render charges a minimum of $1 per month for each cron job service. Any other scheduler that can send that request daily works too (the route also accepts the secret in an `x-cron-secret` header).

**Verify:** the cron job's first run exits 0, and the Render web logs show `[purge] source media purge finished` with the report. Without `CRON_SECRET` the route answers 503 and does nothing; with a wrong secret it answers 401, the same as the stale job sweep.

**Sources:** https://render.com/docs/cronjobs (checked 2026-09-28).

### Let account deletion remove the sign in

Account deletion (Settings, Your data) deletes the workspace rows and every object under `ws/{workspace_id}/` in R2, then signs the user out. Removing the Supabase auth user needs the service role key. Without it the data is still gone, the user is sent to `/account-deleted?signin=pending`, and the server log names the auth user to remove by hand in the Supabase dashboard (Authentication, Users).

**Who:** founder.

**Do:** copy the `service_role` key from the Supabase dashboard (the project's API keys settings) into `SUPABASE_SERVICE_ROLE_KEY` on the Render web service only. Never in the repo, never in a `NEXT_PUBLIC_` variable, never in Trigger.dev.

**Verify:** make a throwaway account, delete it from Settings, and check that it disappears from Supabase Authentication, Users, and that you land on `/account-deleted` without the "by hand" line.

Deletion is refused while a pack is running, while a Stripe subscription is still open (the seller cancels in Billing first) and when the workspace has other members (ownership moves by email for now). The `signup_grants` row is kept on purpose so a new signup with the same email gets no second free grant.

**Sources:** https://supabase.com/docs/reference/javascript/auth-admin-deleteuser (checked 2026-09-28).

### Environment variables added in batch 2 trust

| Name | Read by | Unset means | Meaning and when to set it |
|---|---|---|---|
| `CRON_SECRET` | Cron routes (`apps/web/src/lib/trust/cron-secret.ts`) | Cron routes answer 503 and do nothing | Shared secret the scheduler sends as `Authorization: Bearer` or `x-cron-secret`. A secret: Render only. |
| `SUPABASE_SERVICE_ROLE_KEY` | Account deletion (`apps/web/src/lib/trust/auth-admin.ts`) | Deleted accounts keep their sign in until removed by hand | Supabase service role key, used only to delete the auth user of a deleted account. A secret: Render web service only. |

Lines for `.env.example`:

```
# Shared secret for cron routes (Authorization: Bearer or x-cron-secret). Unset: cron routes answer 503.
CRON_SECRET=
# Supabase service role key, server only, used to remove the sign in of a deleted account.
SUPABASE_SERVICE_ROLE_KEY=
```

## Batch 2, b2/growth: share pages, gallery and leads

No new environment variables. Before this goes live:

1. Apply migration `0016_growth.sql` through the Supabase SQL editor with the founder's approval (the PHASE_10.md process). It adds the `leads` table (RLS on, no client privileges), five columns on `share_links`, two partial unique indexes, and drops the anonymous `share_links_public_read` policy so link only share pages cannot be listed with the anon key.
2. Share page images are served through `/s/{slug}/image/{ref}`, which reads R2 (the same `R2_*` variables as downloads). Without R2 the page renders but its images answer 404.
3. Leads are stored in the `leads` table only. Nothing is sent to Loops yet; import the table once Loops exists (docs/PENDING.md, Hosting and messaging).
4. A gallery entry goes live as soon as its owner opts in. There is no moderation queue; to pull one by hand, set `gallery_items.published = false` for its `share_slug`.
5. Free plan packs draw a small "Made with Curvi" badge on Meta social files (seed `socialBadgeByTier`, packages/pipeline/src/seed/credits.ts). Paid plans ship clean files, and marketplace files never carry it.

## Batch 2 platform (b2/platform)

Runtime recipes with A/B splits and model failover, the scheduled stale job sweep, a report only Content Security Policy, and cookie consent for analytics (docs/phases/PHASE_11.md).

1. **Migration 0017** (`packages/db/migrations/0017_platform_runtime.sql`): adds `recipes.fallback_models`, `generation_jobs.recipe_variants` and the `generation_jobs (status, updated_at)` index. Apply it through the Supabase SQL editor with the founder's approval, like the batch 1 migrations, then run `pnpm db:seed` so the recipe rows gain their seeded fallback models. Until 0017 is applied the worker's recipe read fails and every pack runs on the compiled seed recipes (logged, not fatal); the stale job sweep route still works, just without the index.
2. **Recipes are read at runtime.** The worker reads active `recipes` rows at most once a minute per process. To test a new prompt, insert a new `version` of the same `key` with `active = true` and a `traffic_pct` weight; each job is assigned one version per key from its id and the assignment lands in `generation_jobs.recipe_variants`. To swap or reorder models, update `model` and `fallback_models`. A model without a price in `packages/pipeline/src/seed/models.ts` (`llmModelPrices`) has no live provider and is skipped, so a brand new model still needs its price added there and a deploy. A row whose `key` is not the stage's seeded key is ignored.
3. **Schedule the stale job sweep.** Set `CRON_SECRET` (below) on the Curviai web service, then have a scheduler call `POST https://curvi.ai/api/cron/stale-jobs` every 10 to 15 minutes with the header `Authorization: Bearer <CRON_SECRET>` (or `x-cron-secret: <CRON_SECRET>`). Any scheduler that can send a header works, for example a Render cron job running `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/cron/stale-jobs`. Picking and paying for the scheduler is the founder's call; nothing is scheduled by this branch. Without `CRON_SECRET` the route answers 503 to everyone. **Verify:** a manual call with the secret returns 200 with `"reconciled"`; one without it returns 401.
4. **Watch the CSP reports.** Every response now carries `Content-Security-Policy-Report-Only` plus `Reporting-Endpoints`, built at build time from `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_POSTHOG_HOST`. Nothing is blocked. Violations show up in the Render log as `"event":"csp_violation"` lines (at most 100 a minute per instance). After a week of real traffic, fix or allow what shows up, then switch the header to an enforced `Content-Security-Policy`.
5. **Cookie consent.** With `NEXT_PUBLIC_POSTHOG_KEY` set, visitors get a banner with equal Accept analytics and Decline buttons, and PostHog loads only after Accept. The footer's Cookie settings link reopens it. **Verify:** in a private window, decline, reload and confirm no request goes to `*.posthog.com`; accept and confirm `$pageview` events arrive (step 12). The privacy page has a new Cookies and analytics section; include it in the legal review (step 1).
6. **Unsubscribe links.** No marketing email template exists yet: the only emails the code sends are the founder's spend alerts and metrics digest, which go to the founder alone. The first marketing or lifecycle email (Loops or Resend) must carry an unsubscribe link and a `List-Unsubscribe` header.

### Environment variables added in batch 2 platform

| Name | Read by | Unset means | Meaning and when to set it |
|---|---|---|---|
| `CRON_SECRET` | Scheduled routes (`apps/web/src/lib/cron-auth.ts`, `/api/cron/stale-jobs`) | Every scheduled route answers 503 | A long random value (for example `openssl rand -hex 32`) shared with the scheduler. A secret: Render and the scheduler only, never in the repo. |

Line for `.env.example`:

```
# Shared secret for /api/cron/* (Authorization: Bearer or x-cron-secret). Unset: those routes answer 503.
CRON_SECRET=
```

## Batch 2 retention (b2/retention)

No new environment variables. What the founder does outside the repo:

1. **Apply migration 0018 (`cancel_flows`) to production** in the Supabase SQL editor, in journal order with the other batch 2 migrations, before the code that writes the table goes live. It creates the table, enables row level security and adds one read policy for owners, admins and editors. Until it is applied, the billing page still loads, but the cancel flow records nothing, so the reasons are lost and a pause or discount can be taken more than once (Stripe still refuses a second pause or cancellation on the same subscription).
2. **Stripe (only once step 10 is done).** Nothing to create by hand: the first subscriber who takes the discount creates the coupon `curvi_save_30pct_3mo` (30 percent off, repeating for 3 months, from `retentionOffers` in packages/pipeline/src/seed/retention.ts). If the terms in the seed change, a new coupon id is made; delete the old coupon in the Dashboard if it should no longer be offered. The downgrade offer needs the smaller plan's price id env var (`STRIPE_PRICE_<TIER>_<CADENCE>`, already listed for checkout). Cancellation now happens in the app, so consider turning off "Cancel subscriptions" in the Customer Portal configuration so every cancellation passes through the save offers (docs/STRIPE_SETUP.md, portal settings). In test mode, run each offer once: pause (the subscription shows "collection paused" until the resume date), downgrade (the next invoice is at the smaller price), discount (the subscription shows the coupon), and cancel (the subscription shows "cancels on" the period end), then check the webhook synced the plan.
3. **Bundled brand fonts.** The inline web runner reads the five packaged TTF families. Keep those font packages in the web deployment. A missing selected font falls back to Inter; missing Inter sends text templates to review.

## Phase 12 health (p12/health)

No new environment variables and no migration. Two existing ones gain a use:

| Name | Now also used by | Unset means |
| --- | --- | --- |
| `CRON_SECRET` | The detailed `/api/health` report and the `/api/health/providers` key probe (`Authorization: Bearer <CRON_SECRET>`). | `/api/health` gives only the public body; `/api/health/providers` answers 404. |
| `CURVI_SHOT_CONCURRENCY` | Reported by the detailed health report next to the container memory limit and current RSS. A value that is not a whole number raises `shot_concurrency_invalid`. | The runner default of 2 shots at once. |

What changes for the founder:

1. **`/api/health` warnings now cover drift.** Besides `storage_not_configured`, `no_llm_provider` and `no_image_provider`, it can list `no_cutout_provider`, `recipe_drift` (the recipes table differs from the seed in the deployed build, so production runs other prompts or models), `recipe_check_failed`, `cron_never_ran:<name>`, `cron_overdue:<name>` (last success older than twice the interval: stale-jobs every 10 minutes, purge-source-media daily, billing-reconcile every `billingReconcile.everyMinutes`), `cron_check_failed`, `shot_concurrency_invalid` and `memory_high` (RSS at 85 percent of the container limit or more). Warnings never change `ok` or the status code, but since PHASE_20 P20-15 they set `status` to `degraded` (a `cron_never_ran` or `cron_overdue` warning among them; docs/ops/ALERTS.md lists each code's severity). Confirm every enabled registered job has an observed success. Missing required cron successes keep health degraded; retired backup/drill monitoring is not a current requirement. Other warnings must be evaluated individually, so a successful cron run alone does not establish `"warnings":[]`.
2. **Read the detail:** `curl -s -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/health` adds `details`: each warning in plain words, the recipe differences (model ids and body hashes, never prompts), key presence per stage (env var names only), each cron's last success, shot concurrency and memory. A wrong secret gets the public body.
3. **Probe the provider keys after each deploy:** `curl -s -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/health/providers`. Each configured provider gets one free metadata call (model lookup for Anthropic, Gemini and OpenAI, the credit balance for BFL; the fal cutout has no free probe and shows as skipped), and the reply lists `ok`, the HTTP status and the latency per provider; the top level `ok` is true only when every configured key was accepted. A 401 means the key was refused; a 403 usually means the key is not allowed or has no credit left. Nothing is generated and nothing is spent. This route used to be public; if an uptime monitor polled it, point that monitor at `/api/health` instead.
4. **Clear a recipe drift warning** by running `pnpm db:seed` against the database from the deployed commit (it upserts the seed rows), or, when a table edit was deliberate, by moving the same change into packages/pipeline/src/seed/recipes.ts.

## Web route hardening (fix/web-routes)

No migration. One new environment variable, which must **never** be set in production:

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `ALLOW_DEMO_MODE` | `apps/web/src/lib/services/demo-mode.ts` | In production, a server missing `DATABASE_URL` or the Supabase env vars refuses to serve: API routes answer 503 with plain copy and app pages show the error page. | `1` lets a production build (`next start`) fall back to the in memory demo, where every visitor is the owner of one shared workspace. Only the e2e server sets it (playwright.config.ts). **Must not be set on Render or any production host.** Leave it out of the Render dashboard and out of `render.yaml`. |

What changes for the founder:

1. **Check Render does not have `ALLOW_DEMO_MODE`.** Environment tab of the Curviai service: the name must not be there. If `/api/*` routes ever answer 503 "Curvi is not available right now", the server lost `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`; the Render log says "refusing demo mode in production". Restore the variable; do not set `ALLOW_DEMO_MODE` to get the site back.
2. **Cross site posts are refused.** Signed in routes that change state (packs, cancel, retry, add photo, share, uploads, products, imports, billing, sign out) answer 403 when the request carries an `Origin` header from another site. The site origin is `NEXT_PUBLIC_SITE_URL`, so it must match the address sellers use (for example `https://curvi.ai`); a request addressed to the host it came from also passes. Webhooks, the CSP report, cron and leads are not affected.
3. **Body caps.** JSON posts are capped at 16 KB (64 KB for creating a pack) and answer 413 past that. The all files zip (`/api/jobs/:id/pack`) is limited to 30 downloads an hour per user and per IP.

## Phase 14 provider resilience (p14/provider-resilience)

No migration. Cutouts moved from Photoroom (a competitor) to BiRefNet on fal.ai, so **`FAL_KEY` is now the required cutout key**: without it no pack can deliver anything, since every shot starts from the cutout.

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `FAL_KEY` | Cutout chain (`trigger/src/live-runtime.ts`, `packages/ai/src/adapters/falCutout.ts`) | No live cutout provider: `/api/health` warns `no_cutout_provider` and every shot of a real pack goes to review | fal.ai API key. Required. A secret: the Render web service only, never in the repo. Model and price come from `cutoutModelSeedRows` (packages/pipeline/src/seed/models.ts). |
| `PHOTOROOM_API_KEY` | Nothing any more | Nothing | Remove it from Render and from `.env.example`; no code reads it. Cancel the Photoroom plan once packs run on fal. |

What changes for the founder:

1. **Set `FAL_KEY` on Render before this deploys** (Save only, then deploy), and top up the fal balance. Verify: `/api/health` has no `no_cutout_provider` warning, then run one pack.
2. **Out of quota is now loud and contained.** A provider answering 402 or an out of credit message (fal "Exhausted balance", BFL "Insufficient credits", OpenAI `insufficient_quota`, Gemini `RESOURCE_EXHAUSTED` on a billing or daily quota, Anthropic "credit balance is too low") is never retried: its breaker opens for 30 minutes, the Render log gets an error line `"event":"provider_quota_exhausted"`, an `events` row with that name (provider and task) is written at most once an hour per provider, and `/api/health` lists `provider_quota:<provider>` while the breaker is open. Fix: top up that account. The breaker lives in the web process, so a deploy or restart clears it at once after a top up.
3. **Scenes degrade instead of failing the pack.** When every image provider is down, packs still deliver the white background, alternate angle, cutout and sweep files, and each lifestyle scene is marked "Paused, the scene service is unavailable, not charged". Only delivered files are charged.
4. **One automatic retry.** Shots that fail on a timeout, 429, 5xx or network error run once more 30 seconds later in the same run (not for quota answers, safety refusals or other 4xx).
5. **Preflight on the new pack page.** While the cutout service is down the page says "Packs are paused for a few minutes while an image service recovers. Nothing will be charged." and Create pack is disabled; while only scenes are down a softer banner says white background and cutout files still work.

## PHASE_19 site: support page, policy text and the domain token (p19/site)

The code is on `p19/site` (PHASE_19 P19-22 to P19-24); there is no migration. It adds https://curvi.ai/support (the support URL the plugin listing names), a privacy section on ChatGPT and other assistants with retention timelines, a "Connected assistants" clause in the terms, the `/.well-known/openai-apps-challenge` route for OpenAI's domain check, the `chatgptPlugin` flag (coming soon), and help and llms.txt copy for ChatGPT and Codex.

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `OPENAI_APPS_CHALLENGE_TOKEN` | `apps/web/src/app/.well-known/openai-apps-challenge/route.ts` | `/.well-known/openai-apps-challenge` answers a plain 404, as before. | The domain verification token from OpenAI's plugin submission page (PHASE_19 runbook E3). Served as plain text, exactly, with surrounding whitespace removed. Server only. |

What changes for the founder:

1. **Add `OPENAI_APPS_CHALLENGE_TOKEN=` to .env.example by hand,** with the comment `# OpenAI plugin domain verification token (PHASE_19 runbook E3). Server only. Unset: the challenge path answers 404.` (env files are blocked for the agents).
2. **Confirm the retention defaults before the privacy update ships** (PHASE_19 decision 10). Request logs: "kept for up to 30 days" (Render keeps service logs 7, 14 or 30 days by workspace plan, docs/verification.md, so 30 is the ceiling; also confirm the logs you keep, Render's, Cloudflare's or the app's, are the ones that carry IP addresses). Connection records: "stay until you close your account, including after you disconnect", because a disconnect marks the record revoked instead of deleting it (PHASE_19 "Revocation"); the plan's draft said "until you disconnect or close your account". Original uploads: 30 days, as today. To change a number, edit `REQUEST_LOG_RETENTION_DAYS` and the text in `apps/web/src/app/(marketing)/privacy/privacy-copy.ts`.
3. **Confirm the support response time,** "two business days" (`SUPPORT_RESPONSE_TIME` in `apps/web/src/components/marketing/support-copy.ts`), and that mail to support@curvi.ai reaches you (step 4).
4. **Approve the privacy and terms text** (step 1's legal review covers it). The terms now say "Last updated October 1, 2026", so `TERMS_VERSION` is 2026-10-01: new signups record that version, and existing users keep their 2026-09-28 record (lib/trust/terms.ts records only a first acceptance).
5. **At submission (runbook E3),** paste the token from the OpenAI dashboard into Render as `OPENAI_APPS_CHALLENGE_TOKEN`, Save, and wait for the restart. Open https://curvi.ai/.well-known/openai-apps-challenge and check that it shows exactly the token and nothing else, then press Verify Domain. Cloudflare must let OpenAI reach `/.well-known/*` (runbook B0).
6. **After the plugin is published (runbook E8),** the agent flips `FEATURES.chatgptPlugin` to live and sets `CHATGPT_LISTING_URL` in `apps/web/src/components/marketing/help-articles.ts`; the help article, llms.txt and the API keys page then say ChatGPT works without a key. Until then they say it is coming soon.

## Site visitor count (site-visitors)

Migration 0027 and new server only environment variables. Render's dashboard reports no visitors, and PostHog loads only after cookie consent, so neither counts everyone. The site now counts page views itself, the way Plausible documents it: no cookies and nothing stored on the device, so no consent banner change. A small script on every page (components/visit-beacon.tsx) posts the page path, the UTM tags and, on the first page only, the referrer to `POST /api/visits`; it also counts a page the browser brings back from its back and forward cache. The server skips bots, prefetches, other sites and the operator pages under `/app/ops`, hashes the client IP and user agent with a salt that changes every UTC day under a secret key (`VISITS_HASH_KEY`, an HMAC), and stores only that code (`site_visits`) with the UTC day and no time of day. Neither the IP nor the user agent is stored. The key lives only in the server's environment, so database contents alone (which hold the salts, and the IP and user agent of each terms acceptance) cannot recompute a code. Salts older than yesterday are deleted by the stale-jobs cron, by the first page view of a new day and whenever `/app/ops/visitors` opens. At most 500 page views are stored per code and day.

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `OPS_EMAILS` | `apps/web/src/lib/ops.ts` | `OPS_EMAIL` is read instead; with neither, nobody can open `/app/ops/visitors` (it answers 404 for everyone). | Comma separated sign in emails, compared without regard to case, whose confirmed accounts may open the operator pages. Server only. |
| `OPS_EMAIL` | `apps/web/src/lib/ops.ts` | Nothing, as long as `OPS_EMAILS` is set. | Alias for `OPS_EMAILS`, read the same way (one email or several, comma separated) only while `OPS_EMAILS` is unset or empty, because the singular name is an easy slip. When both are set `OPS_EMAILS` wins. Prefer `OPS_EMAILS`. Server only. |
| `VISITS_HASH_KEY` | `apps/web/src/lib/visits/key.ts` | Nothing is counted; the beacon still answers 204 and `/app/ops/visitors` says counting is off. A value shorter than 32 characters counts as unset. | A long random value, for example the output of `openssl rand -hex 32`. A secret: Render only, never in the repo or the database, never a `NEXT_PUBLIC_` name. Changing it changes every visitor code from then on, so visitors on the day of the change count about twice; stored rows are not touched. |

What changes for the founder:

1. **Apply migration 0027** (pnpm db:migrate, staging first). Additive; RLS on both tables with no policies, and anon and authenticated lose every privilege on them and on the `site_visits_daily` view.
2. **Set `OPS_EMAILS` on Render,** Save only. If `OPS_EMAIL` (singular) is already set there, it works as it is; rename it to `OPS_EMAILS` when convenient.
3. **Set `VISITS_HASH_KEY` on Render,** Save only, then deploy. Without it nothing is counted.
4. **Schedule the stale job sweep** if it is not scheduled yet (item 3 of "Batch 2 platform" above, every 10 to 15 minutes, with `CRON_SECRET`). It now also deletes the visitor salts on time when the site is quiet; without it they still go on the first page view of a new day or when the dashboard opens.
5. **Open `/app/ops/visitors`** signed in with a listed email: unique visitors and page views for today, yesterday, the last 7 and 30 days, a 30 day daily chart, top pages, the sites that sent visitors, UTM sources and campaigns, and phones against computers. A person who visits on two days counts on each day, so totals over several days, and every top table, are daily visitors added up, and the page says so. Your own visits to `/app/ops` are not counted; the rest of the site, `/app` included, is.
6. **Read the count as close, not exact.** People who block scripts are missed, and people sharing one address with the same browser count once. A client that sends a different user agent, or a forged IP header, on every request makes a new visitor each time; that is bounded by 300 counted page views and 30 new visitors an hour per IP (`visits.record` and `visits.newVisitor` in lib/rate-limit.ts, shared across instances only with Upstash), 3 beacons worked on at once per instance (the rest are answered 204 and not counted, which keeps the count to at most 3 of the 10 database connections), 500 page views per visitor code a day, and 100,000 stored page views a day per instance. The per IP bounds hold only once `clientIp()` trusts nothing but edge set headers (docs/verification.md, "Site visitor count"); until then a script that forges the IP header gets past them, and the in flight bound and the daily ceiling are what hold. Browsers driven by automation, headless browsers and known crawlers are not counted. An iPad on iPadOS 13 or later reports a Mac user agent and counts as a computer.

## PHASE_19 sign in for ChatGPT and Codex (p19/auth)

Migration 0028 and four new server only environment variables (docs/phases/PHASE_19.md, P19-04 to P19-08 and P19-11, runbook B). Everything ships dark: with `MCP_OAUTH_ENABLED` unset or `0`, `/api/mcp` behaves exactly as before (API keys only, discovery open, `Bearer realm="curvi"`), and both `/.well-known/oauth-protected-resource` paths answer 404.

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `MCP_OAUTH_ENABLED` | `apps/web/src/lib/mcp-auth/config.ts` | Off: today's behavior, the rollback | `1` turns on OAuth sign in at `/api/mcp`: `initialize`, `tools/list` and `tools/call` without a credential answer 401 with `WWW-Authenticate: Bearer resource_metadata=...`, ChatGPT tokens are accepted beside API keys, and the metadata documents are served. Any other value is off. Changing it restarts the service, which settles running packs, so flip it at a quiet time. |
| `MCP_RESOURCE_URL` | same | `${NEXT_PUBLIC_SITE_URL}/api/mcp` | The MCP URL users paste, byte for byte (no www, no trailing slash). Leave unset on production; it is permanent (decision 9). |
| `SUPABASE_AUTH_ISSUER` | same | `${NEXT_PUBLIC_SUPABASE_URL}/auth/v1` | Must equal the `issuer` in Supabase's `/.well-known/oauth-authorization-server/auth/v1` byte for byte. Leave unset unless they differ. |
| `MCP_OAUTH_CLIENT_IDS` | `apps/web/src/lib/mcp-auth/verify.ts` | Every ChatGPT token is refused (`unknown_client`) | Comma separated Supabase OAuth client ids allowed to call the MCP server: the "ChatGPT developer" client (runbook B5) and later the "ChatGPT" client (E3). Not secret, but only these clients may act for a user. |

Lines for `.env.example` (an engineer adds them; values stay empty or default):

```
# PHASE_19 OAuth sign in at /api/mcp: 1 turns it on; anything else keeps API keys only (the rollback).
MCP_OAUTH_ENABLED=0
# Canonical MCP resource. Default: ${NEXT_PUBLIC_SITE_URL}/api/mcp
MCP_RESOURCE_URL=
# Supabase Auth issuer. Default: ${NEXT_PUBLIC_SUPABASE_URL}/auth/v1
SUPABASE_AUTH_ISSUER=
# Comma separated Supabase OAuth client ids for ChatGPT (runbook B5, E3). Empty: no ChatGPT token is accepted.
MCP_OAUTH_CLIENT_IDS=
```

What the founder does, in this order:

1. **Apply migration 0028** (runbook B1: the Supabase SQL editor or `pnpm db:migrate`, after 0027). It is additive: it creates `mcp_connections` with row level security (the row's user and the workspace's owners and admins read; no client role writes), adds a restrictive `no_oauth_clients` policy to every public table so a token from Supabase's OAuth server reads and writes nothing through the Data API (web sessions carry no `client_id` and are unaffected), and creates `public.curvi_access_token_hook`, executable only by `supabase_auth_admin`. Nothing changes for users until the hook is switched on. **Verify:** sign in to curvi.ai in a private window and open /app; the workspace and packs load.
2. **Deploy main with `MCP_OAUTH_ENABLED` unset or `0`.** Verify: `https://curvi.ai/.well-known/oauth-protected-resource/api/mcp` answers 404, and an API key still lists and runs the tools.
3. **Runbook A2 and A3** (ES256 signing keys, OAuth server on with authorization path `/oauth/consent`, dynamic registration off, Secure password and email change on).
4. **Runbook B2: Authentication, Hooks, Custom Access Token,** pick `public.curvi_access_token_hook`. Sign in to curvi.ai in a private window and open /app at once. If sign in fails, switch the hook off and tell the engineer.
5. **Runbook B4 and B5,** then set `MCP_OAUTH_CLIENT_IDS` to the developer client's id (Save only).
6. **Runbook B3: set `MCP_OAUTH_ENABLED=1`** and deploy or restart at a quiet time. **Verify:** `https://curvi.ai/.well-known/oauth-protected-resource/api/mcp` returns JSON whose `resource` is `https://curvi.ai/api/mcp` and whose `authorization_servers` holds Supabase's issuer, and an `initialize` POST to `/api/mcp` without a token answers 401 with `www-authenticate: Bearer resource_metadata="https://curvi.ai/.well-known/oauth-protected-resource/api/mcp", scope="openid email"`.

Rollback, fastest first: `MCP_OAUTH_ENABLED=0` (ChatGPT connections stop, links they were given stop serving files, the consent page connects nothing, and API keys keep working with today's links); switch the hook off (OAuth tokens then fail the audience check; web sign in unaffected); switch the OAuth server off.

For engineers: a later migration that adds a table to `public` must give it the same `no_oauth_clients` policy; `packages/db/src/mcp-connections.test.ts` fails until it does. The Render log carries `[mcp]` lines (event, reason, method, tool, status, auth kind and protocol only; never a token, link, tool argument or client hint) for refused sign ins, challenges and tool errors. If `auth.sessions` is not readable by the database user, the log says once that sessions are checked through the Auth API, and session checks go to Supabase's `GET /auth/v1/user` instead; that is expected until P19-12 settles it.

## PHASE_19 tools: credits before spending (p19/tools)

No migration. The MCP tools now answer ChatGPT and other assistants with short chat views instead of the REST bodies, a new read only `estimate_pack` tool says how many credits a pack will hold before anything is spent and returns a signed quote, and `create_pack` refuses an OAuth caller's pack without a matching quote and `max_credits`, or one that would hold more than either. Every refusal an assistant can read is plain and never names a plan, a top up or an API key. The REST API v1 and the web app are unchanged.

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `MCP_LINK_KEYS` | `apps/web/src/lib/api-v1/pack-quote.ts` (quotes) and P19-17's link tokens, through `apps/web/src/lib/mcp-signing.ts` | In production, `estimate_pack` answers that it cannot count credits for every caller (API keys included), and an OAuth `create_pack` (which needs a quote) cannot start a pack. An API key `create_pack` still works without a quote. get_pack falls back to today's 15 minute storage links with no previews (next section). Outside production a random key per process signs quotes. | Comma separated `kid:secret` pairs, newest first; the first signs, all verify. Each secret at least 32 characters (for example `openssl rand -base64 32`). To rotate, put the new pair first and keep the old one for 24 hours. Server only, never committed. Add it to `.env.example` as `MCP_LINK_KEYS=` when merging (the integrator does this once for both lanes that read it). |

What changes for the founder:

1. **Set `MCP_LINK_KEYS` on Render** before `MCP_OAUTH_ENABLED` goes to "1" (runbook step 6 of "Rollout"), Save only, then deploy. One pair is enough to start, for example `k1:<32 or more random characters>`.
2. **Nothing changes for API key users.** A key caller of `/api/mcp` may still send its own `idempotency_key`; it may now leave it out, and the server derives one so a repeat within 10 minutes returns the same pack.

## PHASE_19 chat photos, lasting links and caller rate limits (p19/files)

No migration. One new server only environment variable, shared with the estimate quotes from p19/tools (P19-16).

| Name | Read by | Unset means | Meaning and when to set it |
| --- | --- | --- | --- |
| `MCP_LINK_KEYS` | `apps/web/src/lib/mcp-links.ts` through `lib/mcp-signing.ts` (and the estimate quotes, P19-16) | get_pack falls back to the REST API's 15 minute storage download links with no previews, for every caller, so no caller loses its download links; every `/api/mcp/files/...` and `/api/mcp/preview/...` link answers 404. A malformed value counts as unset and logs one warning that never shows the secret. With `MCP_OAUTH_ENABLED` off (the rollback), API key callers get the 15 minute links even when the keys are set, exactly as before PHASE_19, and links an OAuth connection made answer 410. | Comma separated `kid:secret` pairs, newest first. A kid is 1 to 32 letters, digits, `_` or `-`; a secret is at least 32 characters (for example `openssl rand -hex 32`). The first pair signs, every pair verifies. A secret: Render only, never in the repo. |

Line for `.env.example` (this lane could not open `.env.example`, which the sandbox keeps unreadable, so the integrator adds it):

```
# Signing keys for the lasting MCP preview and download links and the estimate quotes: kid:secret pairs, newest first, each secret 32 characters or more. Unset: no links.
MCP_LINK_KEYS=
```

What changes for the founder:

1. **Set `MCP_LINK_KEYS` on Render** before the production deploy that carries the plugin (rollout step 6), Save only, then deploy. Example value: `k1:` followed by the output of `openssl rand -hex 32`.
2. **Rotating the key.** Put a new pair first and keep the old pair after it, for example `k2:<new>,k1:<old>`; deploy; after 24 hours (the link lifetime) remove `k1`. Links made with a removed key stop working at once, and so do unexpired quotes.
3. **What a link checks on every click.** The token is sealed (AES-256-GCM under a key derived from `MCP_LINK_KEYS`), so the chat sees only the key id, never a workspace, connection, pack or file id or the expiry. Each click checks the seal and its 24 hour expiry, that `MCP_OAUTH_ENABLED` is on for a connection's link, that the ChatGPT connection is still live (or the API key not revoked), that its member is still in the workspace, and that the file still belongs to that pack. A disconnect or a removed member stops that connection's links within a minute. Expired links answer 410, anything else 404, both with "This link expired. Ask ChatGPT for the pack's files again."
4. **Cloudflare.** The links live under `/api/mcp/files/` and `/api/mcp/preview/`, so the `/api/mcp/*` skip rule in runbook B0 covers them. Link paths reach Cloudflare and Render request logs; that is why they are tied to a live connection and expire.
5. **Rate limits.** ChatGPT callers (OAuth) are counted per user and per workspace, never per IP, because every ChatGPT call comes from OpenAI's shared addresses. API key callers keep the IP and user rules. New policies: `mcp.read` (get_pack, list_channels, get_profile: 1,200 an hour per user, 2,400 per IP or workspace) and `mcp.links` (600 an hour per IP and 600 per connection or key). estimate_pack counts against `imports.photo` per user. With Upstash configured (step 11) these are shared across instances.
6. **Photos attached in ChatGPT** are read through the same safe link fetch as photo links, three at a time under one 30 second deadline for the whole set. HEIC photos are refused with a plain message; nothing about the attachment link is stored or logged.

## PHASE_19 consent page, Connected apps and the MCP origin list (p19/consent)

No migration and no new environment variable (docs/phases/PHASE_19.md, P19-09, P19-10 and P19-20). It adds the page ChatGPT's sign in lands on, `https://curvi.ai/oauth/consent?authorization_id=...` (Supabase's authorization path, runbook A3), with its own minimal layout (no marketing header, no pricing link, not indexed), sign in and sign up inside that page, Settings, Connected apps at `/app/settings/connections` with a Disconnect button, and lets `https://chatgpt.com` and `https://platform.openai.com` call `/api/mcp` from a browser (an `OPTIONS` preflight and CORS headers; every other site still gets 403).

What the founder does or decides:

1. **Supabase, Authentication, URL Configuration: Redirect URLs** must allow `https://curvi.ai/auth/callback` with a query string (for example `https://curvi.ai/**`), as the signup confirmation link already uses. A new account made on the consent page confirms its email through that link and goes straight back to the consent page instead of /welcome. Terms acceptance is recorded at that link as for any signup, and again (only if missing) the first time the consent page sees the user; the free signup grant is paid by the database when the email is confirmed, as on the web.
2. **Decide how Sign out on curvi.ai should behave** (new finding, docs/verification.md, p19/consent rows). Today the web Sign out ends every session of the user on every device, and that now includes ChatGPT's: after a seller signs out of curvi.ai anywhere, ChatGPT has to sign in to Curvi again (silently, while the connection in Connected apps is live). Option A, keep it: nothing to do. Option B, sign out only the current browser: one line in `apps/web/src/app/auth/signout/route.ts` (`signOut({ scope: "local" })`), with the trade off that signing out on one device no longer signs out the others. The consent page's "Use another account" already signs out only that browser.
3. **P19-12 probe additions** (runbook B6): check that the database user can read `auth.oauth_authorizations` and `auth.oauth_clients` and delete from `auth.sessions`. If it cannot, the consent page still works on the fresh path, but a ChatGPT sign in for a seller who consented before shows "Curvi could not open this connection request right now" instead of connecting (the page fails closed rather than follow a link it cannot check), and an owner's Disconnect of a member's connection still stops every call at once (the row is revoked) while their token lives until it expires.
4. **Verify after deploy:** `https://curvi.ai/oauth/consent` with no id shows "This connection request expired. Go back to ChatGPT and press Connect again."; signed in, Settings shows a "Connected apps" card and its page says nothing is connected yet. Once the OAuth server and `MCP_OAUTH_ENABLED` are on (p19/auth steps above), connecting from ChatGPT developer mode shows the permissions list, the workspace picker for an account in two workspaces, and returns to chatgpt.com.

For engineers: the consent decisions are in `apps/web/src/lib/mcp-auth/consent.ts`, the Supabase and database calls in `consent-backend.ts`, Disconnect in `connected-apps.ts`, the copy in `consent-copy.ts`, the origin list and CORS in `apps/web/src/lib/api-v1/mcp-cors.ts`. Without Supabase (local and e2e) a demo backend serves three fixed requests (`demo-fresh`, `demo-consented`, `demo-unknown-client`) and a `curvi_demo_consent_user` cookie (`teammate`, `signed_out`) picks the demo person; it refuses production like the rest of demo mode.

## PHASE_19 pack viewer in ChatGPT (p19/ui)

No migration and no environment variable. The branch `p19/ui` (PHASE_19 P19-19) adds a small viewer that ChatGPT shows under a `create_pack` call: "Waiting for your go ahead" until you confirm, then "Making your images" with a progress bar, then the finished images with a Download button each and "See all N files" for the zip and the report. It checks the pack by itself every 5 seconds for up to 30 minutes. Every tool result still carries its links as text, so the plugin works the same without it.

What changes for the founder:

1. **When it ships.** Decision 6: merge and deploy it after the plugin is approved and published (runbook E8), then press **Rescan** in the plugin dashboard. No new ZIP and no new review: OpenAI checks the viewer and its content security policy in its continuous review. On `p19/integration` the viewer is merged but switched off: `PACK_VIEWER_LIVE` is `false` in `apps/web/src/lib/mcp-ui/pack-viewer/resource.ts`, and that one switch removes the viewer and the reference to it. To ship it, the agent sets it to `true` and you deploy.
2. **What the viewer may load.** Only images from `https://curvi.ai` (the site address, `NEXT_PUBLIC_SITE_URL`). It fetches nothing else, embeds nothing, and opens only curvi.ai download links and the pack's page in Curvi. Its declared origin (`_meta.ui.domain`) is `https://curvi.ai`; if ChatGPT's developer mode or the Rescan reports a domain problem, record the value it asks for in docs/verification.md ("p19/ui: pack viewer") and change `packViewerMeta` in the same file.
3. **Manual check after the deploy**, on desktop web and in the ChatGPT desktop app, and on iOS and Android once the plugin is installable there: run positive case 4 (a listing pack). The viewer shows "Waiting for your go ahead" before you confirm, then progress, then the images; Download saves a file; "See all" opens every file, including the zip and the report; the product looks exactly as photographed. Record the result in docs/verification.md with the date.
4. **Changing it later.** ChatGPT caches the viewer by its address, `ui://curvi/pack-viewer/v1.html`. A change that would break an older copy needs a new address (`v2`), changed in `resource.ts`.

## PHASE_19 plugin ZIP (p19/integration, wave 4)

No migration and no environment variable. `pnpm plugin:zip` checks the plugin folder `packages/openai-plugin/package/` against OpenAI's submission rules (docs/phases/PHASE_19.md, P19-25) and writes `packages/openai-plugin/dist/curvi-1.0.0.zip` (the file to upload at platform.openai.com/plugins, runbook E1) and the folder `dist/curvi-1.0.0/` (for the local marketplace install, runbook C3b). It uploads nothing.

What the founder does:

1. **The developer name.** Once identity verification is done (runbook A4), either replace `SET TO THE VERIFIED DEVELOPER NAME` in `packages/openai-plugin/package/plugin.json` (both `author.name` and `interface.developerName`) with the verified name, or build with `pnpm plugin:zip --developer-name "Your verified name"`. The build refuses the placeholder.
2. **The demo recording.** After runbook C4, add `"demo_recording_url": "https://..."` under `extensions["com.openai"].review` in plugin.json and rebuild. Until then the build warns that MCP review needs it.
3. **Reviewer access never goes in the ZIP.** The reviewer email, password and instructions go in the dashboard (runbook E5); the build refuses `test_credentials` and `reviewer_instructions`.
4. **The review photo** is `https://curvi.ai/review/sample-product.jpg` (the home page's product photo). Keep that address working while a review is open.
5. **Manual runs** in developer mode use `packages/openai-plugin/fixtures/golden-prompts.json` (checklist step 4): the 5 positive and 3 negative review prompts, 10 more phrasings and the prohibited goods negatives.

## Phase 18 measure (p18/measure): signup attribution and the weekly funnel

docs/phases/PHASE_18.md P18-01 and P18-02. Migration `attribution_and_funnel` (its number is set when the Phase 18 lanes are combined, after `0027_site_visits` and PHASE_19's `mcp_connections`). No new environment variable: it uses `CRON_SECRET`, `RESEND_API_KEY`, `FOUNDER_ALERT_EMAIL` (and optional `FOUNDER_ALERT_FROM`) and `OPS_EMAILS`, which already exist.

What it does:

- **Every signup carries its source.** Every Start free link on the marketing site goes through `signupHref` and `SignupLink` with the page's seeded source key (`home`, `header`, `pillar`, `compare`, `channel` with the channel, `category` with the category, `help`, `gallery`, `share`, `tools`, `email_capture`), and once in the browser it adds the UTM tags, `ref` and share slug of the page the visitor is on. Nothing is stored for that. The signup form adds an optional "How did you hear about Curvi?" field (choices in `signupSourceChoices`, packages/pipeline/src/seed/growth.ts).
- **First touch cookie, only after consent.** When a visitor accepts cookies, `curvi_ft` (first party, 90 days, under 1 KB) keeps the first page they opened, the site that sent them and its UTM tags. It is never overwritten, and declining deletes it. The privacy page says so.
- **One attribution row per signup.** The signup form puts the hint in the signup metadata; on a fresh verification `/auth/callback` checks it again and writes one `signup_attributions` row (owners and admins can read their own; only the server writes), then the `funnel.signup_confirmed` event, both once per user.
- **Server side funnel in `events`.** `funnel.signup_confirmed`, `funnel.pack_started` (createJob), `funnel.pack_done` (the runner, with the job id), `funnel.download` (pack zip, one file, API links), `funnel.checkout_completed` and `funnel.payment` (Stripe webhook, payments only when a paid grant was applied), `funnel.share_published` and `funnel.lead_captured`, plus `funnel.first_<step>` once per workspace for pack started, pack done, download and payment. Client roles can no longer insert `funnel.%` or `billing:%` event names.
- **Weekly funnel email.** `POST /api/cron/funnel-digest` sends the founder a plain text email once per ISO week, on the first call on or after Monday 13:00 UTC: signups by self reported source, utm_source and page; activation; first downloads; payments; repeat use; leads; share pages; site visitors; and the dated gates of docs/marketing.md section 5.5 (`validationGates` in growth.ts). Workspaces owned by an `OPS_EMAILS` account are left out. `/app/ops/funnel` shows the same counts by week and source to operators.

What changes for the founder:

1. **Apply the `attribution_and_funnel` migration** (pnpm db:migrate, staging first, after any earlier migration production does not have yet). Additive: a new table with RLS, a partial unique index on `events`, and the `events_insert_member` policy recreated so client roles cannot write `funnel.%` or `billing:%` names (no app code ever did).
2. **Deploy, then dry run the email:** `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "https://curvi.ai/api/cron/funnel-digest?dryRun=1"`. The answer holds the email's subject and text; nothing is sent and the week is not claimed.
3. **Add the route to the daily purge cron command** so no new cron service is needed. Change that Render Cron Job's command to
   `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/cron/purge-source-media && curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/cron/funnel-digest`.
   The purge runs at 03:30 UTC, so the email goes out on Tuesday's run (the first call after Monday 13:00 UTC). To get it on Monday instead, move the schedule to after 13:00 UTC, for example `30 13 * * *`. If a scheduler cannot chain two calls, one more Render cron service costs $1 a month at least.
4. **Check that `RESEND_API_KEY` and `FOUNDER_ALERT_EMAIL` are set** (they also carry the spend alerts). Without them the route answers 200 with `skipped` and tries again the next day.
5. **Open `/app/ops/funnel`** signed in with an `OPS_EMAILS` address.
6. **Smoke test (Release 1):** open `https://curvi.ai/?utm_source=test&utm_campaign=smoke`, click Start free, sign up a test address with an answer to "How did you hear about Curvi?", confirm it, then run the first query below and see one row with `utm_source = test`, `utm_campaign = smoke`, `source = home` and your answer.

**Verify:** `/api/health` lists `cron_never_ran:funnel-digest` until the first scheduled call, then nothing for it. Without `CRON_SECRET` the route answers 503; with a wrong secret 401.

### Saved funnel SQL (Supabase SQL editor, read only)

Replace the dates before running. They read the same rows as the weekly email; the email also leaves out workspaces owned by an `OPS_EMAILS` account, so add `and workspace_id not in (...)` with those workspace ids to match it exactly.

```sql
-- F1: how each confirmed signup found Curvi (one row per user).
select a.created_at, a.method, a.source, a.self_reported, a.self_reported_other,
       a.utm_source, a.utm_medium, a.utm_campaign, a.ref, a.share_slug, a.referrer_host, a.landing_path, a.consent
from signup_attributions a
where a.created_at >= timestamptz '2026-10-01 00:00Z'
order by a.created_at desc;
```

```sql
-- F2: confirmed signups by self reported answer, utm_source and page, with first packs done.
with params as (select timestamptz '2026-10-01 00:00Z' as start_at, now() as end_at),
signups as (
  select e.workspace_id, e.props
  from events e, params p
  where e.name = 'funnel.signup_confirmed' and e.at >= p.start_at and e.at < p.end_at
)
select coalesce(props ->> 'self_reported', 'not answered') as self_reported,
       coalesce(props ->> 'utm_source', 'none') as utm_source,
       coalesce(props ->> 'source', 'none') as page,
       count(*) as signups,
       count(*) filter (where exists (
         select 1 from events f where f.workspace_id = s.workspace_id and f.name = 'funnel.first_pack_done')) as activated
from signups s
group by 1, 2, 3
order by signups desc;
```

```sql
-- F3: the funnel steps by ISO week (Monday, UTC).
select to_char(date_trunc('week', at at time zone 'UTC'), 'YYYY-MM-DD') as week,
  count(*) filter (where name = 'funnel.signup_confirmed') as signups,
  count(*) filter (where name = 'funnel.first_pack_started') as first_pack_started,
  count(*) filter (where name = 'funnel.first_pack_done') as first_pack_done,
  count(*) filter (where name = 'funnel.first_download') as first_download,
  count(*) filter (where name = 'funnel.payment') as payments,
  count(*) filter (where name = 'funnel.first_payment') as first_payments,
  count(*) filter (where name = 'funnel.share_published') as shares,
  count(*) filter (where name = 'funnel.lead_captured') as leads
from events
where name like 'funnel.%' and at >= timestamptz '2026-10-01 00:00Z'
group by 1
order by 1 desc;
```

```sql
-- F4: repeat use, a second pack done within 30 days of the first.
select f.workspace_id, f.at as first_done,
  (select count(distinct e.props ->> 'job_id') from events e
    where e.workspace_id = f.workspace_id and e.name = 'funnel.pack_done'
      and e.at < f.at + interval '30 days') as packs_in_30_days
from events f
where f.name = 'funnel.first_pack_done'
order by f.at desc;
```

```sql
-- F5: payments with their plan, amount and promotion code id.
select at, workspace_id, props ->> 'kind' as kind, props ->> 'plan' as plan, props ->> 'cadence' as cadence,
       props ->> 'amount_usd' as amount_usd, props ->> 'billing_reason' as billing_reason
from events where name = 'funnel.payment' order by at desc limit 50;

select at, workspace_id, props ->> 'plan' as plan, props ->> 'checkout_source' as checkout_source,
       props ->> 'discounted' as discounted, props ->> 'promotion_code' as promotion_code
from events where name = 'funnel.checkout_completed' order by at desc limit 50;
```

## Phase 18 resilience (p18/resilience)

P18-03 adds the acquisition gate, the fal balance probe and low balance alerts (docs/phases/PHASE_18.md). No migration for P18-03.

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `FAL_ADMIN_KEY` | `trigger/src/provider-balance.ts` through `POST /api/cron/provider-balance`; `apps/web/src/lib/config-health.ts` | No balance check for the `FAL_KEY` account: no low balance email, the gate never closes on that balance (it still closes when packs are paused or by hand), and `/api/health` warns `fal_admin_key_missing`. | A fal Admin API key. It only reads the account's credit balance (`GET https://api.fal.ai/v1/account/billing?expand=credits`). A secret: Render only, never in the repo, never a `NEXT_PUBLIC_` name. |
| `FAL_ADMIN_KEY_BACKUP` | same | No balance check for the `FAL_KEY_BACKUP` account; health warns while `FAL_KEY_BACKUP` is set. | The Admin API key of the backup fal account. Optional. |
| `CURVI_DEMO_ACQUISITION` | `apps/web/src/lib/acquisition.ts` | The gate is open in demo mode. | Tests only: `waitlist` closes the gate in demo mode. Ignored when a database is configured. |

Existing variables this needs: `CRON_SECRET` (the new cron route), `RESEND_API_KEY` and `FOUNDER_ALERT_EMAIL` (the alerts).

What changes for the founder:

1. **The gate.** Every Start free button wrapped by the gate (the home hero today; every `SignupLink` once Lane 1 sweeps the links) turns into "Get notified when packs are back" while any of these holds: `platform_settings.acquisition_paused` is true; the new pack preflight says packs are paused (every cutout account out of credit or failing); or every configured fal account's newest balance (younger than 90 minutes) is below $3. The button opens a dialog that stores the email in `leads` with source `packs-paused`. `/signup` shows "Packs are paused right now..." and stays open. The free checkers never need fal and keep working. `GET /api/status` answers only `{"acquisition":"open"}` or `{"acquisition":"waitlist"}`, cached 30 seconds, so a change reaches every page within a minute.
2. **Pause by hand** with `insert into platform_settings (key, value) values ('ops:acquisition_paused', 'true'::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now();` (and `'false'::jsonb` to open). No row means not paused; `pnpm db:seed` never writes an `ops:` row (P20-20).
3. **Balance check.** Add `POST /api/cron/provider-balance` to the stale-jobs cron command (docs/PENDING.md, "Phase 18 founder steps, Lane 2 Resilience", step 2). Each run reads each account with an admin key, stores the reading (platform_settings `fal_balance:<provider>`), writes a `provider_balance` events row at most once an hour, and emails you once per UTC day per account below $15 ("Curvi: the fal balance is low ($x left)"), and at once below $3 with the pause note and the manual ChatGPT ads step. The lines live in `packages/pipeline/src/seed/monitoring.ts` (`falBalanceLines`).
4. **Other emails.** When the gate closes because packs cannot run, you get "Curvi: acquisition is paused because packs cannot run" (once per UTC day and reason). A cutout or image provider that answers out of quota now also emails you, once per provider per UTC hour. Every gate change is a `funnel.acquisition_paused` or `funnel.acquisition_resumed` events row.
5. **Health.** `/api/health` warns `fal_admin_key_missing` and `cron_never_ran:provider-balance` until both are set up; the detailed view (with `CRON_SECRET`) lists `falBalances`, the newest reading per account.

**Verify:** with `FAL_ADMIN_KEY` set, a manual call of the cron route returns 200 with `"probed":true` and the balance; `curl -s https://curvi.ai/api/status` returns `{"acquisition":"open"}`; set `acquisition_paused` to true, wait a minute, and the home page's Start free reads "Get notified when packs are back"; set it back.

P18-23 adds deploy restarts: a pack a deploy stops starts again on the new instance instead of failing. Migration `deploy_restarts` (its number is set when the Phase 18 lanes are combined) adds `generation_jobs.restart_count` and `generation_jobs.restart_payload`, with a trigger that lets only the server write them. No new environment variable. **It ships switched off:** `ops:deploy_restarts_enabled` is off while no row says otherwise (an operator switch the seed never writes, P20-20), and while it is off a deploy settles packs exactly as before. Turn it on when its gate is met (PHASE_18 Release 5) with `insert into platform_settings (key, value) values ('ops:deploy_restarts_enabled', 'true'::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now();` (it applies within 30 seconds; `'false'::jsonb` turns it off again, and any restart already queued is then failed by the stale reconciler with its hold released).

1. **What happens on a deploy.** On SIGTERM the inline runner offers every pack it stops to start again. A pack that had not started keeps its hold and stays queued under a `restart:` run key, with its worker payload saved on the job. A pack still running when the grace window ends (and with no delivered files) has its abort signal fired first, so it starts no new generation; then its hold is released, the files it made are marked superseded (never charged or delivered), its progress rows are cleared and the estimate is reserved again, at most once per pack (`deployRestarts.max` in packages/pipeline/src/seed/growth.ts). Anything else, or a balance that no longer covers the estimate, is settled as before.
2. **Who runs it.** The new instance claims each restarted pack (one conditional update, so exactly one instance runs it) from the health poll, the stale-jobs cron or any new pack, at most every 30 seconds per instance, and runs it after the response. The cutout comes from the R2 cache, so the rerun pays again only for scenes. The pack page shows "We restarted the server while your pack was running, so it started again. You are charged only once." Each restart writes a `funnel.pack_restarted` events row.
3. **Keep `maxShutdownDelaySeconds` at 300 and `CURVI_INLINE_PACK_CONCURRENCY` at 2** on the live service (steps 8 and 9 above), so most packs finish inside the grace window and fewer need a restart.

**Verify:** start a pack, deploy while it runs, and watch the pack page: it goes back to queued, then running, then done, with the restart line, and the credits charged equal the files delivered. Logs show `pack_restart_queued` on the old instance and `pack_restarts_claimed` on the new one.

## Phase 18 activation (p18/activation)

Google sign in (P18-13), the first run questions (P18-20) and the free white main image before signup (P18-12, switched off). The founder steps, in order, are in docs/PENDING.md, "Phase 18 activation founder steps".

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_GOOGLE_AUTH` | `apps/web/src/lib/google-sign-in.ts` | No Google button on /signup or /login. | `1` shows "Continue with Google" once the Google provider is on in Supabase. Public and inlined at build time, so a change needs a deploy. |
| `NEXT_PUBLIC_FREE_PREVIEW` | `apps/web/src/lib/free-preview/copy.ts` `freePreviewOn`, `gate.ts` `previewSetupGaps` | No preview box on the home page; `/api/preview` answers 503 closed and the auth callback claims nothing. | `1` turns on the free white main image before signup (P18-12) once fal is funded and Upstash is set. Public and inlined at build time. The server also needs `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, `DATABASE_URL` with Supabase, the R2 keys, `FAL_KEY` (or `FAL_KEY_BACKUP`) and `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, and stays closed without any of them. |

## Phase 18 email (p18/email)

Lifecycle email (docs/phases/PHASE_18.md P18-06 and P18-07) over Resend directly (founder decision 3). Migration `lifecycle_email` (its number is set when the Phase 18 lanes are combined) adds the platform tables `email_sends` (one row per dedupe key, the address only as its sha256 key) and `email_suppressions`, and `leads.marketing_consent_at` and `leads.consent_source`. **It ships switched off:** `ops:lifecycle_email_enabled` is off while no row says otherwise (an operator switch the seed never writes, P20-20); nothing is sent until the founder steps in docs/PENDING.md, "Phase 18 founder steps, Lane 3 Email", are done and the switch is turned on.

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `LIFECYCLE_EMAIL_FROM` | `packages/email/src/config.ts` | No customer email is sent (each attempt is logged `disabled` and tried again once set). | Sender on the Resend verified `updates.curvi.ai` subdomain, for example `Curvi <hello@updates.curvi.ai>`. |
| `LIFECYCLE_REPLY_TO` | same | No customer email is sent. | Reply-To of every lifecycle email (the founder's inbox); also the mailto in `List-Unsubscribe`. |
| `CURVI_LINK_SECRET` | same; `apps/web/src/lib/email/config.ts` | No marketing email is sent (it would have no working unsubscribe); transactional email still goes. In db mode no unsubscribe link verifies. | HMAC secret for signed links (the unsubscribe links now; P18-05 feedback and P18-12 download links later). A secret: Render only. Never rotate it while email is on. |
| `CURVI_POSTAL_ADDRESS` | `packages/email/src/config.ts` `usablePostalAddress` | Marketing email waits; transactional email still goes. A placeholder such as `[postal address]` or `TODO` counts as unset. | The CAN-SPAM postal address in the marketing footer (decision 4); a registered PO box or private mailbox is fine. |
| `LIFECYCLE_FOUNDER_NAME` | same | Emails are signed "Curvi" and the welcome email does not name the founder. | Optional first name. |
| `RESEND_WEBHOOK_SECRET` | `apps/web/src/app/api/webhooks/resend/route.ts` | `/api/webhooks/resend` answers 503; bounces are checked by hand in Resend. | The webhook's `whsec_...` signing secret from Resend. |

1. **What is sent.** Transactional mail (welcome, pack ready, packs back to an account) goes to anyone not suppressed for all mail. Marketing mail (the first pack nudges, the feedback ask, out of credits, win back, and every email to a lead: the tool link, packs back, tips and offers) also needs no marketing unsubscribe, `CURVI_LINK_SECRET`, a real `CURVI_POSTAL_ADDRESS` and an https `NEXT_PUBLIC_SITE_URL`. It carries `List-Unsubscribe` (https and mailto) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and a footer that says it is a marketing email, why the reader gets it, the one click unsubscribe link and the postal address. Leads get the tool link, tips and offers only if they ticked the new consent box on the free tool email gate or the packs paused waitlist; every lead captured before that box has none. A visitor who joined the packs paused waitlist gets the packs back email because they asked for it, as marketing mail. Someone who asks to unsubscribe by replying (the mailto in the header goes to `LIFECYCLE_REPLY_TO`) is added by hand within 10 business days (docs/PENDING.md, "Phase 18 founder steps, Lane 3 Email", step 14).
2. **Unsubscribe.** `/email/unsubscribe?t=<token>` asks once ("Stop tips and offers from Curvi?") and posts to `/api/email/unsubscribe`, which also takes a mail app's one click POST and answers 200 with no redirect. The settings page has "Emails from Curvi with listing image tips and offers". Both write or clear a `marketing` suppression; a bounce, a complaint or a Resend suppression (the webhook) stops all mail and is never lifted from settings.
3. **Limits.** At most 25 lifecycle emails per cron run and 60 per UTC day (seed `emailLimits` in packages/pipeline/src/seed/growth.ts), inside Resend's free 100 a day and 3,000 a month with room for the Supabase auth mail and founder alerts on the same account. A failed send is tried again up to 3 times; Resend's `Idempotency-Key` (the dedupe key) stops a second delivery.
4. **Health.** `/api/health` warns `lifecycle_email_not_configured` while the switch is on and a variable above is missing, naming the variables.

**Verify** after switching email on: open `/api/health` (no `lifecycle_email_not_configured`), then in the SQL editor `select template, status, error, created_at from email_sends order by created_at desc limit 20;` shows the newest attempts without any address.

**P18-07, the lifecycle emails.** `POST /api/cron/lifecycle` (CRON_SECRET; `?dryRun=1` lists what is due by template and sends nothing) joins the stale-jobs cron command after `/api/cron/provider-balance`, so it runs every 10 to 15 minutes with no new cron service. Each run reads the server side funnel (P18-02), jobs, the ledger balance, leads and the send log, picks what is due (`dueEmails` in packages/email/src/due.ts, timings in `lifecycleSchedule`, packages/pipeline/src/seed/growth.ts) and sends at most one email per person per run, transactional first, with no marketing email within 20 hours of another email to the same person:

| Email | When | Kind |
| --- | --- | --- |
| welcome | at confirmation (within 48 hours) | transactional |
| first_pack_nudge_1, first_pack_nudge_2 | 1 and 3 days after confirmation with no pack started, free plan only | marketing, held while packs are paused |
| pack_ready | a pack is done with at least one passed file, once per pack, with the measured color check (P18-08) | transactional |
| feedback_ask | 2 days after the first pack, until answered (off until P18-05) | marketing |
| out_of_credits | after a pack leaves a free or Starter balance below the next pack, at most once in 30 days, not after a purchase | marketing, held while paused |
| win_back | 21 days after the last pack, once ever | marketing, held while paused |
| packs_back | when the acquisition gate reopens, once per pause, to waitlist leads and to signups of the pause who made no pack | transactional to an account, marketing to a waitlist lead |
| lead_results | a lead from the checker, fixer, resizer or store audit who ticked the consent box, once per lead and tool | marketing |
| lead_tip, lead_offer | 3 and 10 days after a lead ticked the consent box, until they sign up | marketing, held while paused |

Every link carries `utm_source=curvi_email&utm_medium=email&utm_campaign=<template>`, so a returning signup is credited to the email; there are no open tracking pixels. Each send writes `funnel.email_sent { template }`, and the weekly funnel email shows "Lifecycle emails sent by template". An email is dropped, not sent late, once it is past its window, so switching email on never mails old signups. Workspaces owned by an `OPS_EMAILS` address get no lifecycle email, so prospect and test packs never mail the founder.

## Phase 18 concierge (p18/concierge)

Pack feedback and testimonials (P18-05), the share loop and gallery labels (P18-14) and the prospect makeover tool (P18-04). The founder steps, in order, are in docs/PENDING.md, "Phase 18 concierge founder steps".

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `CURVI_LINK_SECRET` | `apps/web/src/lib/feedback/link.ts` | No signed feedback link is made; `/feedback/<token>` says links are not available. The card on the pack page still works. | Server only. At least 32 characters. Signs the pack feedback link (one pack, one person, `packFeedback.linkDays` days) for the day 2 email (P18-07). Changing it ends every link already sent. |

**P18-05, pack feedback.** Migration `pack_feedback` (a tenant table: members read, the server writes). Once a pack is done, its page asks "Would you use these files in a live listing?" ("Yes, as they are", "Some of them", "Not yet"), then "What would make them better?", "Would you pay for packs like this?" and the quote consent with an empty name field. One answer per pack and person; "Not now" hides the card in that browser. Each answer writes `funnel.feedback_submitted` with `usable`, so the weekly funnel email shows the usable share against the day 14 gate, and the email lists the week's new consented quotes word for word. `feedbackLinkPath({ jobId, userId })` in `apps/web/src/lib/feedback/link.ts` is the link the day 2 email puts in (Lane 3).

**Verify:** finish a pack, answer the card with the consent box ticked, and check `select usable, quote_consent, display_name from pack_feedback order by created_at desc limit 1;` and `select props from events where name = 'funnel.feedback_submitted' order by at desc limit 1;`. The next funnel digest dry run (`POST /api/cron/funnel-digest?dryRun=1`) lists the quote.

**P18-14, the share loop.** No migration and no new variable. A published share page's panel gets "Post on X", "Share on LinkedIn", "Save to Pinterest" and "Post on Reddit" (and "Share from this phone" on phones); every link carries `utm_source=<network>&utm_medium=share&utm_campaign=pack_share`, and Make mine sends `source=share` and the page's slug to `/signup`, so a share driven signup lands in `signup_attributions` with `source = share`, `share_slug` and the network. Gallery listed share pages join `/sitemap.xml` within an hour. Gallery entries from a workspace owned by an `OPS_EMAILS` account read "Made by the Curvi team"; seller entries show a consented quote when there is one.

**Verify:** publish a pack page, click "Post on Reddit" and check that the link and title are filled in (the one share format not read on Reddit's own page, docs/verification.md); open the page with `?utm_source=x`, click Make mine and sign up, then `select source, share_slug, utm_source from signup_attributions order by created_at desc limit 1;`. Then unpublish "Blue Car 1", "Blue Gatorade v2" and "Blue Gatorade v4" from the gallery (docs/marketing.md MKT-009).

**P18-04, the prospect makeover tool.** Migration `pack_claims` (a platform table: no client access; only the sha256 of a claim token is stored). No new variable: it uses `OPS_EMAILS` (the operator allowlist from the site visitor count), the R2 keys and the database. `/app/ops/prospects` and `/api/ops/prospects/*` answer 404 to anyone whose confirmed email is not in `OPS_EMAILS`.

1. **Credits.** "Add prospect credits" adds credits to your own workspace as a `grant` ledger row with source `system`, at most `staffMonthlyCreditCap` (400) per UTC calendar month, counted from `ops:prospect_credits` events rows, which no client role can write (`events_insert_member` refuses `ops:%`). Packs then spend them like any pack.
2. **Make a pack.** Store name, product link (Shopify or Amazon, imported through the existing import routes) or the listing photo, channels and a note. The pack runs through the normal pack path. When it is done, the list publishes its share page once: the whole pack, link only (never in the gallery, so never indexed), with the measured checks on.
3. **Send it.** "Make the claim link" makes a fresh link (the previous one stops working) that works for 30 days, with the outreach kit: the link, the Amazon checker's rows for their current listing photo, the color check summary, and a draft note under 80 words with the outreach signature under it (postal address placeholder, "This is a promotional email from Curvi.", the opt out line). Check the do not contact list, replace the address placeholder and send it from the outreach domain. "Show the outreach kit" shows the kit again later without a new token; with `CURVI_LINK_SECRET` set (at least 32 characters) it also shows the live link, because claim tokens are then derived from the claim and its expiry, so the link the prospect has keeps working.
4. **The prospect's side.** The page is titled "{store} listing pack, made by Curvi" and, with the link, offers "Make it yours". Signing up from it attributes the account to `concierge` with the store as `utm_campaign`, copies the listing photo into their new workspace as a product, opens `/app/new` on it, and adds no extra credits (the 15 credit signup grant pays the first pack). "Take it down here" in the footer makes the page private at once.

**Verify:** docs/PENDING.md, "Phase 18 concierge founder steps", step 7. The weekly funnel email shows "Prospect packs made", "Prospect claims" and the claims by store.

## Phase 18 search: the URL import claim gate (P18-11)

`FEATURES.urlImport` stays `coming_soon` on the branch, so no page promises the Shopify or Amazon product link import yet; the import itself works in the new pack form. Before the copy goes live:

1. In production, start one pack from a Shopify product link and one from an Amazon product link. Both must import the photo and title into a pack.
2. Record both, with the date and the two links, in docs/verification.md.
3. Then flip the one line in `apps/web/src/lib/marketing-facts.ts` (`urlImport` status `live`) in its own commit and deploy. Help, llms.txt and the site features gain the product link sentence; `apps/web/src/lib/url-import/live-copy.test.ts` checks whichever state the flag is in.

If either import fails, leave the flag as it is.

## Phase 18 offer (p18/offer)

The founding member offer and per pack price framing (P18-21) and referral give and get credits (P18-24). No new environment variable: the banner reads Stripe with `STRIPE_SECRET_KEY`. The founder steps, in order, are in docs/PENDING.md, "Phase 18 founder steps, Lane 9 Offer".

1. **Live with the deploy:** each paid plan on /pricing shows "About $x per listing pack." and the intro shows the dated soona price. Nothing to set.
2. **Founding banner, switched off.** `ops:founding_offer_enabled` is off while no row says otherwise (an operator switch the seed never writes, P20-20). With it on, `GET /api/offer` answers the banner only while the offer is open (through `foundingMemberOffer.endsOn`, UTC), packs run, the `FOUNDING` promotion code is active in Stripe and seats are left; otherwise `{ "founding": null }`. Stripe is read at most once every 5 minutes per instance.
3. **Referral rewards, switched off.** Migration `referrals` (its number is set when the Phase 18 lanes are combined) adds `referral_codes` and reworks `referrals` (it refuses a table that is not empty, and no client role reads it: the settings page shows counts through the server), plus a unique index that keeps each referral ledger row to one. A referral whose first payment used a card that also paid for the referrer is rejected (`same_card`, read from Stripe's charge list), and a referral step that fails answers the Stripe webhook with 500 so Stripe delivers it again. `ops:referrals_enabled` is off while no row says otherwise (an operator switch the seed never writes, P20-20). While off: no invite codes, `/r/<code>` goes to the plain home page, `/app/settings/referrals` answers 404, and no referral is recorded.

**Verify (after decision 18 and the switches):** /pricing shows the banner with the seats left; a test checkout with `FOUNDING` costs $19. Open Settings, Invite a seller, sign up a second test account from the link, buy a top up there in test mode: both balances rise by 50 and `select status from referrals` says rewarded; refund it in Stripe and both fall back.

## Phase 20 billing core (p20/billing-core)

No migration and no new variable on Render. What changes before live Stripe keys (docs/phases/PHASE_20.md P20-01 to P20-04):

1. **Checkout opens only when Stripe can grant credits** (P20-01). `STRIPE_SECRET_KEY` alone no longer opens checkout; it needs `STRIPE_WEBHOOK_SECRET` and every self serve `STRIPE_PRICE_*` too, in a key mode that fits the site (docs/STRIPE_SETUP.md section 2). **Verify:** `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/health/providers` shows the `stripe` service with `"checkoutOpen"` and the `problems` keeping it closed; `/api/health` lists only the codes. Keep Stripe keys out of Render until the Release 2 gate (PHASE_20 decision 1).
2. **Schedule the billing reconcile** (P20-02), until the one tick cron exists (P20-38), by adding it to the existing `curvi-stale-jobs` cron command so both run every 10 to 15 minutes:

   ```
   curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/cron/stale-jobs; curl -fsS --max-time 600 -X POST -H "Authorization: Bearer $CRON_SECRET" https://curvi.ai/api/cron/billing-reconcile
   ```

   It replays the handled Stripe events of the last `billingReconcile.lookbackHours` (seed 72) through the webhook handler, at most `maxEventsPerRun` (seed 1,000) a run, so a payment whose webhook never landed still grants its credits exactly once. Replays never refund, cancel or change anything in Stripe. Without a Stripe key it answers `skipped` and still counts as a run, so `/api/health` does not report `cron_never_ran:billing-reconcile` while billing is off. When a run applies anything, or an event newly fails, the founder gets one email through the existing founder alert path (`RESEND_API_KEY`, `FOUNDER_ALERT_EMAIL`): "Billing check: {n} payments were missing credits. They are granted now." A failure that stays failed is emailed once, then retried silently each run while it is in the window. **Verify:** after setting the Stripe test keys locally, `curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/billing-reconcile?dryRun=1"` lists what it would write and writes nothing.
3. **Webhook endpoint check** (P20-02). Each run lists the Stripe webhook endpoints and warns `stripe_webhook_endpoint_mismatch` on `/api/health` unless an enabled endpoint at `NEXT_PUBLIC_SITE_URL` plus `/api/webhooks/stripe` sends every handled event on API version `2025-08-27.basil`. The signing secret cannot be checked through the API; `stripe_webhook_quiet` covers it (a checkout opened in the last 7 days and no webhook succeeded since).
4. **Test mode run and `pnpm billing:verify`** (P20-03): see docs/STRIPE_SETUP.md section 8.
5. **Unit economics** (P20-04): `pnpm report:unit-economics --days 30` with `DATABASE_URL` set, read only. Record the generative still price decision in docs/phases/PHASE_20.md before live keys (decision 2).

## Phase 20 billing terms (P20-05 to P20-08)

Migration `billing_terms` was part of the historical billing rollout. Preserve its applied journal entry; do not replay it. For pending migrations, review data effects and writer compatibility, then use the guarded migration process before the compatible web deploy. No backup prerequisite remains. What changes before live Stripe keys (docs/phases/PHASE_20.md P20-05 to P20-08):

1. **Credits never expire** (P20-05): one credit sentence everywhere; the migration clears the unused top up expiry.
2. **Plan cards list only what runs; Agency off self serve** (P20-08): do not create Agency prices (docs/STRIPE_SETUP.md section 1).
3. **Downgrades by email** (P20-06 stopgap): turn Switch plan off in the default portal configuration and create the two upgrade only configurations of docs/STRIPE_SETUP.md section 5.
4. **Renewal terms, consent record, activation email and cancel flow** (P20-07): keep Stripe's "Send emails about upcoming renewals" off (section 6), and set the billing sender.

| Name | Read by | Unset means | Meaning |
| --- | --- | --- | --- |
| `STRIPE_PORTAL_UPGRADE_CONFIG_STARTER`, `_STARTER_ANNUAL`, `_GROWTH`, `_GROWTH_ANNUAL`, `_PRO` | web (checkout route) | Those subscribers get the default configuration (Switch plan off) and cannot upgrade online; `/api/health` warns `stripe_portal_upgrade_config_missing` once checkout is open. | The `bpc_...` ids of the five upgrade only portal configurations (docs/STRIPE_SETUP.md section 5). |
| `BILLING_EMAIL_FROM` | web (Stripe webhook, billing reconcile) | Checkout stays closed (with `RESEND_API_KEY`, it is a readiness requirement); `/api/health` warns `billing_email_not_configured` (info until billing is meant to be live, degraded after). | The sender of billing emails, an address on the verified `updates.curvi.ai`, for example `Curvi Billing <billing@updates.curvi.ai>`. Needs `RESEND_API_KEY`. |

## Retired backup planning

On 2026-10-03 the user removed encrypted-backup planning and release gates. P20-10 and P20-11 are retired; no bucket, age recipient, backup cron, monitor or restore drill must be provisioned. Local disk and GitHub preserve code only, not live database rows or stored objects. Existing backup data and unrelated security controls remain untouched. See [current policy and historical reference](ops/BACKUP_RESTORE.md).

Migrations retain their own checks for target identity, exact journal, compatible app/workers, old-writer isolation and reversibility. Report irreversible data effects before executing them. Do not upload live database dumps or secrets to GitHub.

## Production environment inventory

Authoritative combined inventory for PHASE_18 through PHASE_20, checked 2026-10-02. It supersedes older batch notes about Trigger.dev and cron deployment. Secrets have service-level `sync: false`; optional values can remain unset. Render only prompts for these on initial creation and ignores them on an existing Blueprint, so a new declaration does not install a live value. No secret values are recorded here.

The `curvi-common` group contains only the site URL, `NODE_ENV` and `CRON_SECRET`. Render does not support `sync: false` inside environment groups; the Blueprint uses `generateValue: true` for the cron capability. Before adopting existing services, precreate or verify the group with the **existing** cron secret through the founder's secure dashboard flow, and verify that every service resolves that same value. Do not blindly rotate it or remove service overrides. `generateValue` keeps an existing group value; a new installation creates a new capability. No credential was created during this repository work.

Production automatic deploys remain `autoDeployTrigger: checksPass`, matching the latest authorized workflow. The guarded `pnpm release` CLI is available for a future explicit release policy choice; do not assume its pre-deploy drain runs on an automatic Render deploy. Before first Blueprint sync: set Blueprint Auto Sync to No, compare Generate Blueprint with this file, match service names/types, and inspect the preview. Proceed only when it adopts the existing services without new or suffixed copies and without overwriting environment values. Applying this Blueprint or provisioning cron resources requires the separate founder operation.

`curvi-tick` calls `/api/cron/tick` every ten minutes, with a start/success/failure heartbeat, and replaces the two legacy dashboard scheduler services only after its first live success and job freshness are verified. It holds no database, Stripe or provider credentials. The retired backup plan does not authorize deleting existing services/data or widening web-service access.

**Founder verification required:** `.env.example` was not read or changed because it is protected in this task. Copy the inventory names and safe empty/default placeholders to it by hand, then enable a separate hard completeness check. The repository test deliberately verifies the source/Blueprint/checklist inventory without opening that protected file. Live adoption, current dashboard values, cron provisioning and heartbeat delivery remain unverified.

Official syntax and behavior: [Render Blueprint reference](https://render.com/docs/blueprint-spec), [Render cron jobs](https://render.com/docs/cronjobs), [Healthchecks ping API](https://healthchecks.io/docs/http_api/), retrieved 2026-10-02.

| Variable | Scope | Purpose and behavior when unset |
| --- | --- | --- |
| `CRON_SECRET` | common group | Shared random bearer capability for cron HTTP routes. Preserve the existing value during adoption. |
| `NEXT_PUBLIC_SITE_URL` | common group | Canonical https://curvi.ai origin for both web and cron callbacks. |
| `NODE_ENV` | common group | production on all three services. |
| `ANTHROPIC_API_KEY` | web only | Optional configured LLM provider; absent providers are skipped. |
| `BFL_API_KEY` | web only | Configured BFL image provider; absent provider is skipped. |
| `BILLING_EMAIL_FROM` | web only | Verified transactional sender; missing blocks billing communications/readiness. |
| `CLIENT_IP_HEADER` | web only | Explicit trusted proxy address header; unset uses the conservative untrusted path. |
| `CLIENT_IP_PROXY_SECRET` | web only | Shared trusted proxy proof; missing never grants trusted-IP status. |
| `CSP_ENFORCE` | web only | Unset/0 keeps the policy report-only. Enable enforcement only after the CSP proof gate. |
| `CURVI_ALLOW_DEMO_GENERATION` | web only | Leave unset in production. Explicit development escape hatch for synthetic generation. |
| `CURVI_INLINE_PACK_CONCURRENCY` | web only | Existing production default 2; confirm measured memory before changing. |
| `CURVI_INLINE_PACK_MAX_RUN_MS` | web only | Optional bounded per-pack run limit; unset uses the runner default. |
| `CURVI_LINK_SECRET` | web only | Signing key for email/prospect/feedback links; missing blocks signed link features and marketing mail. |
| `CURVI_POSTAL_ADDRESS` | web only | Real postal address required for marketing email; unset/placeholder blocks marketing mail. |
| `CURVI_PROVIDER_CANARY_ENABLED` | web only | Unset/0 keeps paid periodic canaries off. Enable only after the authorized provider/budget gate. |
| `CURVI_SHOT_CONCURRENCY` | web only | Optional per-pack shot concurrency. Unset uses seeded policy; memory health checks warn on unsafe settings. |
| `CURVI_SHUTDOWN_GRACE_MS` | web only | Optional drain grace; must stay below Render maxShutdownDelaySeconds (300). |
| `CURVI_TEMPLATE_FONT_FILE` | web only | Optional server font path; unset uses bundled fonts. |
| `DAILY_SPEND_HARD_STOP_USD` | web only | Optional spend hard-stop override; unset uses seeded policy. |
| `DATABASE_URL` | web only | Supabase transaction pooler URL. Required for database mode; missing production config fails closed. |
| `FAL_ADMIN_KEY` | web only | Primary fal account balance read key; missing makes balance health unknown. |
| `FAL_ADMIN_KEY_BACKUP` | web only | Backup fal account balance read key; missing makes balance health unknown. |
| `FAL_KEY` | web only | Primary fal inference/cutout key; absent provider is skipped. |
| `FAL_KEY_BACKUP` | web only | Optional independent backup fal inference account. |
| `FOUNDER_ALERT_EMAIL` | web only | Destination for operational alerts and weekly report; missing logs/drops configured email alerts. |
| `FOUNDER_ALERT_FROM` | web only | Verified operational sender; unset uses Curvi Alerts at alerts@curvi.ai. |
| `GEMINI_API_KEY` | web only | Configured Gemini image provider; absent provider is skipped. |
| `INDEXNOW_KEY` | web and manual operator tool | Optional approved public IndexNow ownership proof, never a Bing account API secret. Unset returns 404 for proof files and blocks submissions. Configure only through the approved secure flow; no value is generated by the Blueprint. See [IndexNow operations](ops/INDEXNOW.md). |
| `LIFECYCLE_EMAIL_FROM` | web only | Verified lifecycle sender; missing blocks lifecycle and configured support mail. |
| `LIFECYCLE_FOUNDER_NAME` | web only | Optional welcome/signature display name; omitted when unset. |
| `LIFECYCLE_REPLY_TO` | web only | Reply-to inbox for lifecycle mail; missing blocks lifecycle sending. |
| `MCP_LINK_KEYS` | web only | Versioned signing keys for MCP delivery links and quotes; absent blocks signed links in production. |
| `MCP_OAUTH_CLIENT_IDS` | web only | Approved OAuth client IDs; required by the release auth gate. |
| `MCP_OAUTH_ENABLED` | web only | Unset/0 keeps OAuth authentication/discovery disabled; API keys keep working. |
| `MCP_REGISTRY_AUTH` | web only | Optional public MCP Registry domain-auth proof; unset endpoint404. Not a private signing key. |
| `MCP_RESOURCE_URL` | web only | OAuth protected resource URL; unset uses the canonical configured MCP endpoint. |
| `NEXT_PUBLIC_FREE_PREVIEW` | web only | Set1 only after the preview readiness gate; unset disables free preview. |
| `NEXT_PUBLIC_GOOGLE_AUTH` | web only | Set1 to show Google sign-in after provider configuration; unset hides it. |
| `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID` | web only | Public Ads pixel ID/disable control; unset follows the existing consent-gated default. |
| `NEXT_PUBLIC_OUTPUT_OPTIONS` | web only | Optional output-option feature flag; unset follows the current feature default and ops switch. |
| `NEXT_PUBLIC_POSTHOG_HOST` | web only | Optional analytics host; unset uses the SDK default. |
| `NEXT_PUBLIC_POSTHOG_KEY` | web only | Public analytics key; absent disables PostHog. |
| `NEXT_PUBLIC_SENTRY_DSN` | web only | Browser error reporting DSN; absent disables browser capture and tunnel. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | web only | Optional public Stripe key used for environment consistency checks. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web only | Public Supabase client key. Required for production sign in. |
| `NEXT_PUBLIC_SUPABASE_URL` | web only | Supabase project URL. Required for production sign in. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | web only | Public widget key; pair with secret and configure Supabase CAPTCHA. Unset leaves widget off. |
| `NODE_OPTIONS` | web only | Optional Node heap options; unset uses Node defaults. Do not raise beyond the service memory limit. |
| `NODE_VERSION` | web only | 22 for the supported runtime; keep aligned with package.json. |
| `OPENAI_ADS_CONVERSIONS_KEY` | web only | Server Ads conversions key; absent disables server conversion forwarding. |
| `OPENAI_API_KEY` | web only | Configured OpenAI LLM/image provider; absent provider is skipped. |
| `OPENAI_APPS_CHALLENGE_TOKEN` | web only | Optional public application verification challenge; unset endpoint404. |
| `OPS_EMAIL` | web only | Legacy single-operator fallback; prefer OPS_EMAILS. |
| `OPS_EMAILS` | web only | Comma-separated operator allowlist; missing denies operator access. |
| `OPS_RELEASE_TOKEN` | web only | Scoped deploy-pending capability shared only with founder release CLI; unset endpoint returns404. |
| `PHOTOROOM_API_KEY` | web only | Optional legacy adapter key; no active seed route requires it. Leave unset unless explicitly configured. |
| `R2_ACCESS_KEY_ID` | web only | Private product bucket access key; scoped only to the intended asset bucket. |
| `R2_ACCOUNT_ID` | web only | Private object store account. Required for real file delivery. |
| `R2_BUCKET_PRIVATE` | web only | Private product bucket; unset defaults to curvi-private. |
| `R2_SECRET_ACCESS_KEY` | web only | Private product bucket secret; missing disables real file delivery. |
| `RESEND_API_KEY` | web only | Transactional and lifecycle mail transport; missing sends no mail. |
| `RESEND_WEBHOOK_SECRET` | web only | Resend signed bounce/complaint webhook secret; missing rejects webhook writes. |
| `SENTRY_AUTH_TOKEN` | web only | Build-only source-map upload credential; absent still builds with minified stacks. |
| `SENTRY_DSN` | web only | Server/edge error reporting DSN; absent disables capture. |
| `SENTRY_ORG` | web only | Sentry organization slug for source maps and operator issue links. |
| `SENTRY_PROJECT` | web only | Sentry project slug for source maps. |
| `SHOPIFY_API_SECRET` | web only | Webhook signature secret; absent rejects Shopify webhook writes. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_AGENCY` | web only | Scoped Stripe portal upgrade configuration for this source plan/cadence; missing forbids that portal update. Gated plans stay gated. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_AGENCY_ANNUAL` | web only | Scoped Stripe portal upgrade configuration for this source plan/cadence; missing forbids that portal update. Gated plans stay gated. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH` | web only | Scoped Stripe portal upgrade configuration for this source plan/cadence; missing forbids that portal update. Gated plans stay gated. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_GROWTH_ANNUAL` | web only | Scoped Stripe portal upgrade configuration for this source plan/cadence; missing forbids that portal update. Gated plans stay gated. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_PRO` | web only | Scoped Stripe portal upgrade configuration for this source plan/cadence; missing forbids that portal update. Gated plans stay gated. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_PRO_ANNUAL` | web only | Scoped Stripe portal upgrade configuration for this source plan/cadence; missing forbids that portal update. Gated plans stay gated. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_STARTER` | web only | Scoped Stripe portal upgrade configuration for this source plan/cadence; missing forbids that portal update. Gated plans stay gated. |
| `STRIPE_PORTAL_UPGRADE_CONFIG_STARTER_ANNUAL` | web only | Scoped Stripe portal upgrade configuration for this source plan/cadence; missing forbids that portal update. Gated plans stay gated. |
| `STRIPE_PRICE_AGENCY_ANNUAL` | web only | Matching Stripe price ID from seeded tier/cadence; missing price is unavailable. Agency stays gated by product policy. |
| `STRIPE_PRICE_AGENCY_MONTHLY` | web only | Matching Stripe price ID from seeded tier/cadence; missing price is unavailable. Agency stays gated by product policy. |
| `STRIPE_PRICE_GROWTH_ANNUAL` | web only | Matching Stripe price ID from seeded tier/cadence; missing price is unavailable. Agency stays gated by product policy. |
| `STRIPE_PRICE_GROWTH_MONTHLY` | web only | Matching Stripe price ID from seeded tier/cadence; missing price is unavailable. Agency stays gated by product policy. |
| `STRIPE_PRICE_PRO_ANNUAL` | web only | Matching Stripe price ID from seeded tier/cadence; missing price is unavailable. Agency stays gated by product policy. |
| `STRIPE_PRICE_PRO_MONTHLY` | web only | Matching Stripe price ID from seeded tier/cadence; missing price is unavailable. Agency stays gated by product policy. |
| `STRIPE_PRICE_STARTER_ANNUAL` | web only | Matching Stripe price ID from seeded tier/cadence; missing price is unavailable. Agency stays gated by product policy. |
| `STRIPE_PRICE_STARTER_MONTHLY` | web only | Matching Stripe price ID from seeded tier/cadence; missing price is unavailable. Agency stays gated by product policy. |
| `STRIPE_PRICE_TOPUP_100` | web only | Matching Stripe top-up price ID; missing top-up is unavailable. |
| `STRIPE_PRICE_TOPUP_500` | web only | Matching Stripe top-up price ID; missing top-up is unavailable. |
| `STRIPE_SECRET_KEY` | web only | Stripe server key for the selected environment; missing keeps purchasing closed. |
| `STRIPE_TAX_ENABLED` | web only | Set1 only after Stripe tax registrations are ready; unset leaves Stripe Tax off. |
| `STRIPE_WEBHOOK_SECRET` | web only | Stripe webhook signing secret; missing rejects webhook writes. |
| `SUPABASE_AUTH_ISSUER` | web only | Optional explicit issuer; unset derives the issuer from the Supabase URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | web only | Server-only auth administration key; missing disables account deletion/admin operations. |
| `SUPPORT_INBOX` | web only | Support destination; unset uses support@curvi.ai. |
| `TURNSTILE_SECRET_KEY` | web only | Server Turnstile verifier secret; partial configuration fails closed, absent pair uses strict anonymous fallback caps. |
| `UPSTASH_REDIS_REST_TOKEN` | web only | Rate-limit backend token; keep paired with its URL. |
| `UPSTASH_REDIS_REST_URL` | web only | Optional shared rate-limit backend URL; absent uses supported database/local fallbacks. |
| `VISITS_HASH_KEY` | web only | Server-only visit hashing key; missing disables durable visitor hashing/counts. |
| `HEALTHCHECKS_TICK_URL` | tick cron only | Optional private tick heartbeat URL; missing leaves external tick monitoring disabled. |
| `ALLOW_DEMO_MODE` | local/test only | Never set on production. Allows explicit test demo mode. |
| `APPDATA` | CLI host supplied | Windows CLI config root; unset uses the OS home fallback. |
| `CI` | CI/platform supplied | Build/test quiet and concurrency behavior; never a secret. |
| `CURVI_API_KEY` | customer CLI only | CLI credential; never configure as a web-service tenant key. |
| `CURVI_API_URL` | customer CLI only | Optional CLI target; unset uses canonical API URL. |
| `CURVI_CONFIG_DIR` | customer CLI only | Optional isolated CLI config directory. |
| `CURVI_DEMO_ACQUISITION` | local/demo only | Demo acquisition state fixture; never set on production. |
| `CURVI_RSS_TEST` | local test only | Memory-test opt-in; never set on production. |
| `GITHUB_RUN_ID` | GitHub supplied | Smoke test unique run identifier. |
| `INIT_CWD` | package manager supplied | Restore CLI starting directory; no Render configuration needed. |
| `NEXT_MANUAL_SIG_HANDLE` | Next runtime supplied | Internal signal integration flag; application sets it for inline draining. |
| `NEXT_PUBLIC_ENV_LABEL` | staging only | Visible staging label/noindex. Do not put it on production. |
| `NEXT_RUNTIME` | Next build supplied | Runtime selection by Next; no manual configuration. |
| `OPS_OPERATOR_EMAIL` | founder machine only | Grant CLI operator identity, must be in allowlist. |
| `OPS_RELEASE_EMAIL` | founder machine only | Audited deploy CLI operator identity. |
| `OPS_SITE_URL` | founder machine only | Canonical HTTP target for guarded migration/release scripts. |
| `PORT` | Render supplied | Web server listening port; local start defaults3000. |
| `RENDER_API_KEY` | founder machine only | Render control-plane credential; never in web/cron env. |
| `RENDER_GIT_COMMIT` | Render supplied | Deploy commit used by health and Sentry releases. |
| `RENDER_SERVICE_ID` | founder machine only | Existing web service ID for guarded release CLI. |
| `SMOKE_ALLOW_PACKS` | GitHub/local smoke only | Explicit paid staging pack opt-in; unset keeps generation off. |
| `SMOKE_ALLOW_PRODUCTION_PACK` | GitHub/local smoke only | Separate explicit production synthetic pack opt-in. |
| `SMOKE_API_KEY` | GitHub/local smoke only | Excluded operator-workspace API key only when its synthetic test is explicitly enabled. |
| `SMOKE_BASE_URL` | GitHub/local smoke only | Explicit smoke target origin; no default live target. |
| `SMOKE_EXPECTED_SHA` | GitHub/local smoke only | Optional deployed commit expectation. |
| `SMOKE_MODE` | GitHub/local smoke only | demo, staging, production or separately authorized synthetic mode. |
| `SMOKE_USER_EMAIL` | GitHub/local smoke only | Staging login fixture only; never production customer credentials. |
| `SMOKE_USER_PASSWORD` | GitHub/local smoke only | Staging login fixture password only. |
| `SMOKE_WORKSPACE_EXCLUDED` | GitHub/local smoke only | Required operator-workspace exclusion proof for production synthetic packs. |
| `STAGING_DATABASE_URL` | founder staging tools only | Separate staging database identity; never a production deployment credential. |
| `STAGING_SUPABASE_URL` | founder staging tools only | Separate staging project identity; retained restore tooling also refuses this target. |
| `STRIPE_E2E` | local test only | Explicit Stripe test-mode E2E opt-in; unset skips real-stack test. |
| `TEST_DATABASE_URL` | isolated test/CI only | Disposable PostgreSQL race-test target; never production. |
| `TRIGGER_SECRET_KEY` | retired | Ignored diagnostic only; remove from Render. No Trigger.dev worker is deployed. |
| `XDG_CONFIG_HOME` | CLI host supplied | Unix CLI config root; unset uses ~/.config. |
| `STAGING_OPS_SITE_URL` | founder/local or host supplied only | Staging origin for guarded operator CLI commands. |
| `STAGING_CRON_SECRET` | founder/local or host supplied only | Staging-only cron HTTP capability for CLI health and migrations. |
| `STAGING_OPS_RELEASE_TOKEN` | founder/local or host supplied only | Staging-only deploy-pending capability. |
| `STAGING_OPS_RELEASE_EMAIL` | founder/local or host supplied only | Audited operator identity for staging releases. |
| `STAGING_RENDER_API_KEY` | founder/local or host supplied only | Render control-plane key used only by the founder staging CLI. |
| `STAGING_RENDER_SERVICE_ID` | founder/local or host supplied only | Existing staging web service ID. |
| `TMPDIR` | founder/local or host supplied only | Host temporary directory; cron scripts default to /tmp. |

### Retired tooling environment names

These names remain in legacy scripts/tests for older-release compatibility. They are excluded from the active deployment plan; do not create keys, request a public age recipient, provision storage or transmit a backup to fill them.

| Variable | Scope | Status |
| --- | --- | --- |
| `BACKUP_AGE_RECIPIENT` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `BACKUP_DATABASE_URL` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `BACKUP_R2_ACCESS_KEY_ID` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `BACKUP_R2_ACCOUNT_ID` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `BACKUP_R2_BUCKET` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `BACKUP_R2_SECRET_ACCESS_KEY` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `HEALTHCHECKS_BACKUP_URL` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `RENDER_BACKUP_CRON_ID` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `STAGING_RENDER_BACKUP_CRON_ID` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
| `BACKUP_TIMESTAMP` | retired tooling only | Optional archival compatibility reference; not required or provisioned for the current rollout. |
