# Launch checklist: external steps before paid launch

Written 2026-09-28 for Phase 10 batch 1 (docs/phases/PHASE_10.md). Every step here happens outside the repo: in a dashboard, a DNS zone, a contract, or a production database. The code side of each step is already in the repo unless the step says otherwise.

How to use it: work top to bottom. Steps marked "start early" only take calendar time (DNS, review, account activation), so begin them on day one and finish them in order. Each step says who does it, what to do, and how to know it worked. When a step is done, record it with the date in docs/verification.md (CLAUDE.md rule 7).

Every external setting name, value and limit below was checked against the linked official page on 2026-09-28. Anything that could not be confirmed says so.

| # | Step | Who | Blocks |
|---|---|---|---|
| 1 | Legal review of terms and privacy (start early) | Founder with a lawyer | Paid launch |
| 2 | Resend sending domain with SPF, DKIM and DMARC (start early) | Founder | Step 3 |
| 3 | Supabase custom SMTP through Resend | Founder | Signups outside the team |
| 4 | Inbound mail for hello@curvi.ai | Founder | Support replies |
| 5 | Render deploys only after CI passes | Founder | Step 7 |
| 6 | Apply migrations 0011 to 0013 to production, then run `pnpm db:seed` | Founder | Step 7 |
| 7 | Add the batch 1 environment variables, then push main (batch 1 goes live) | Founder, engineer for `.env.example` | Steps 8 to 13 |
| 8 | Render health check path and shutdown delay | Founder | Safe deploys |
| 9 | Render plan upgrade | Founder (costs money) | Paid launch |
| 10 | Stripe live mode | Founder | First dollar |
| 11 | Upstash Redis | Founder | Shared rate limits |
| 12 | PostHog | Founder | Funnel data |
| 13 | Sentry | Engineer, then founder | Error alerts |
| 14 | Trigger.dev v4 and Cloud | Engineer, then founder | Durable packs, scheduled jobs |
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

**Do:** have counsel review the live pages at https://curvi.ai/terms and https://curvi.ai/privacy (source: `apps/web/src/app/(marketing)/terms/page.tsx` and `privacy/page.tsx`). Points to cover:

- The legal entity name, address, contact (hello@curvi.ai) and governing law.
- Credits, subscriptions and refunds as the product actually works: credits are held when a pack starts, charged only for delivered assets, and released otherwise; a refund or dispute claws back the credits that invoice granted (PHASE_10 decision 3); annual plans grant the year of credits on the paid invoice (decision 2).
- Uploaded content: the license customers grant to process their photos, retention and deletion.
- AI generated output: Concept Mode images are generated and labeled as such; Listing Mode keeps the real product pixels. Acceptable use, and the moderation gate that holds flagged uploads.
- Subprocessors: Render (hosting), Supabase (database and auth), Cloudflare (R2 storage, DNS, email routing), Stripe, Resend, PostHog, Sentry, Upstash, Trigger.dev, and the model providers Anthropic, Google (Gemini), Black Forest Labs, OpenAI and fal (fal also runs the cutouts; Photoroom is no longer used since Phase 14).
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

## 4. Inbound mail for hello@curvi.ai

hello@curvi.ai appears across the site as the contact address, and DMARC reports need a mailbox.

**Who:** founder.

**Do:** Cloudflare dashboard, Compute, Email Service, Email Routing: onboard curvi.ai (Cloudflare adds its MX, SPF and DKIM records at the root), add the founder's inbox as a verified destination, and create routing rules for `hello` and `dmarc`. Resend's MX lives on `send.updates`, so the two do not collide; remove any other MX records on the root first.

**Verify:** mail sent from an outside account to hello@curvi.ai and dmarc@curvi.ai reaches the founder's inbox.

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

When the check answers 503, and why a database outage does not restart the instance: `/api/health` answers 503 in three cases only. First, when the database does not answer and this instance has not yet passed a whole check (database answering, schema not behind, not draining) since it started: that is the boot readiness gate, so a new deploy that cannot reach the database never receives traffic and the old version keeps serving. Second, while the database is behind this build's migrations. Third, while the instance is draining for shutdown. Once a whole check has passed, a later database failure or a check slower than two seconds is reported in the body (`"ok":false`, `"database":"failed"`) but the endpoint still answers 200. A restart would not fix the database and would cost a lot: the shutdown drain fails the packs still running once the grace window ends, and the marketing site and the Stripe webhook go offline while the instance comes back. A slow but working database, or a busy 0.1 CPU free instance, could otherwise trigger that restart with no real outage. Database outage alerts come from the uptime monitor in step 15, which checks the body for `"ok":true`.

What happens on a deploy or restart: Render sends SIGTERM to the old instance 60 seconds after the new one is live. The inline runner stops taking packs, marks every pack that had not started as failed and releases its credits, waits the grace window for running packs, then settles whatever is still running: failed, with the job error "The server restarted while this pack was running. Reserved credits were released, so you can run it again.", or done when its files were already delivered, in which case every delivered asset is charged and the rest of the hold is released. No job is left in a working state.

What happens to a pack that hangs: each inline pack run has a wall clock cap, `CURVI_INLINE_PACK_MAX_RUN_MS` (25 minutes unless set, always below the stale run reconciler's 30 minutes). When it passes, the runner settles the job the same way (failed, with the job error "This pack took longer than the time limit, so it was stopped. Reserved credits were released, so you can run it again.", or done and charged if its files were already delivered), frees the slot and starts the next waiting pack. `/api/health` counts runs past the cap under `packs.overdue`. A job that waits more than an hour for a slot stops heartbeating, so the stale run reconciler can fail it and release its credits if the queue is stuck.

**Verify:** the Health Checks section shows `/api/health`. `GET https://api.render.com/v1/services/<service id>` shows `serviceDetails.healthCheckPath` `/api/health` and `serviceDetails.maxShutdownDelaySeconds` 300. Drill: start a pack, then click Manual Deploy. The pack either finishes, or ends failed with its held credits back in the balance (the job board shows its generic failure line for these errors today). The old instance's log shows `[jobs] SIGTERM: inline runner drained (...)`.

**Sources:** https://render.com/docs/health-checks, https://render.com/docs/deploys (Graceful shutdown), https://render.com/docs/blueprint-spec, https://api-docs.render.com/reference/update-service, https://render.com/docs/configure-environment-variables (checked 2026-09-28).

## 9. Render plan upgrade

Costs money, so it is the founder's call; render.yaml still says `plan: free` on purpose. Render says of free instances: "Do not use them for production applications." They spin down after 15 minutes without traffic (about a minute to wake), run on 0.1 CPU and 512 MB, and cannot scale past one instance.

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

**Status:** not wired. The repo has no Sentry SDK (no `@sentry/nextjs` dependency), so the `SENTRY_DSN` variable in render.yaml does nothing today.

**Who:** an engineer adds the SDK in its own change (it is a new dependency), then the founder sets the variables.

**Do:** run `npx @sentry/wizard@latest -i nextjs` in `apps/web`. It adds `instrumentation.ts`, `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts` and `app/global-error.tsx`. Keep the user facing error copy plain (rule 9). The founder sets `SENTRY_DSN` (and `NEXT_PUBLIC_SENTRY_DSN` for the browser) and `SENTRY_AUTH_TOKEN` for source maps in Render, and adds an alert rule that emails them on new issues.

**Verify:** a deliberate test error shows up in Sentry with a readable stack trace, and the alert email arrives.

**Source:** https://docs.sentry.io/platforms/javascript/guides/nextjs/ (checked 2026-09-28).

## 14. Trigger.dev v4 and Cloud (durable packs and scheduled jobs)

**Status:** the code pins `@trigger.dev/sdk` 3.x and imports `@trigger.dev/sdk/v3`. Trigger.dev Cloud has shut v3 down: "v3 triggers and deploys no longer run."

**Keep `TRIGGER_SECRET_KEY` unset on Render until this step is finished.** With the key set, every pack is sent to Trigger.dev instead of the inline runner and fails to queue ("The pack could not be queued.", credits released). The scheduled jobs (metrics digest Mondays 08:00 New York time, churn scoring daily 07:00, the weekly creative drop) run only on Trigger.dev, so none of them run in production today.

Until then, packs run on the inline runner: limited by `CURVI_INLINE_PACK_CONCURRENCY`, capped per run by `CURVI_INLINE_PACK_MAX_RUN_MS` and drained on SIGTERM (step 8). A hard crash or out of memory kill still loses the running packs; the stale run reconciler fails them and releases their credits after 30 minutes.

**Who:** an engineer upgrades the code, then the founder sets up the account.

**Do:**

1. Engineer: `npx trigger.dev@latest update` (moves `@trigger.dev/*` to 4.x), change imports to `@trigger.dev/sdk`, define queues ahead of time with `queue()`, switch lifecycle hooks to the single object parameter, and apply both items in Update.md "Before moving pack jobs to Trigger.dev cloud" (ship the template font, keep the cutout to one per job).
2. Founder: create the Trigger.dev Cloud project, set the production environment variables there (database, R2, provider keys, Resend), and deploy the tasks (`pnpm --filter @curvi/trigger run deploy`; the `run` matters, since `pnpm deploy` is a different built in command).
3. Founder: set `TRIGGER_SECRET_KEY` (the production secret key) in Render and redeploy.

**Verify:** a pack created on curvi.ai appears as a run in the Trigger.dev dashboard and reaches done; the Schedules page lists the three scheduled tasks with their next run times; the first Monday digest arrives.

**Sources:** https://trigger.dev/docs/migrating-from-v3, https://trigger.dev/docs/upgrade-to-v4 (checked 2026-09-28).

## 15. Uptime monitor

**Who:** founder.

**Do:** point an external uptime monitor (for example Better Stack or UptimeRobot; pick any) at `https://curvi.ai/api/health`, expecting HTTP 200 **and** a body containing `"ok":true`, plus a second check on `https://curvi.ai/`. Alert the founder by email and phone. The body match is required, not optional: after an instance has started, a database outage answers 200 with `"ok":false` (step 8 explains why), so a monitor that only checks the status code never sees it.

**Verify:** a test alert from the monitor arrives. The monitor's settings show the keyword or body check for `"ok":true`.

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

Set these in Render (the Curviai service, Environment, **Save only**, step 7) and list every name in `.env.example` (CLAUDE.md rule 8). None is needed to boot: unset, the code uses the default below. Packs run inline in the web service today, so these belong on the web service. Once packs move to Trigger.dev Cloud (step 14), also set `FOUNDER_ALERT_EMAIL`, `FOUNDER_ALERT_FROM` and `RESEND_API_KEY` in the Trigger.dev production environment; the three `CURVI_*` runner variables apply to the inline runner only.

| Name | Read by | Unset means | Meaning and when to set it |
|---|---|---|---|
| `STRIPE_TAX_ENABLED` | Checkout (`apps/web/src/lib/billing/stripe.ts`) | Tax off | Set to `1` only after Stripe Tax registrations exist (docs/STRIPE_SETUP.md). Turns on automatic tax, a required billing address and tax id collection in Checkout. Any other value leaves tax off. |
| `FOUNDER_ALERT_EMAIL` | Spend alerts (`trigger/src/spend-alerts.ts`) | Alerts only reach the server log | The founder address that gets the daily provider spend alert and the hard stop notice, once per day each. Needs `RESEND_API_KEY` as well. |
| `FOUNDER_ALERT_FROM` | Spend alerts | `Curvi Alerts <alerts@curvi.ai>` | Sender of those alerts. It must be an address on a domain verified in Resend. Step 2 verifies the `updates.curvi.ai` subdomain, so set something like `Curvi Alerts <alerts@updates.curvi.ai>`; the default sender needs `curvi.ai` itself verified. |
| `CURVI_INLINE_PACK_CONCURRENCY` | Inline pack runner | `1` | Packs one web instance runs at once; the rest wait in order. 1 on 512 MB, 2 on 2 GB, 3 on 4 GB (step 9). Clamped to 1 to 16. |
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
3. **Brand fonts on Trigger.dev Cloud (step 14).** Template text now reads one of five bundled TTFs (Inter, Montserrat, Playfair Display, Lora, Roboto Slab) from the `@expo-google-fonts/*` packages. The web inline runner finds them in node_modules. A Trigger.dev Cloud build must ship these packages too (keep them external, or add the TTF files to the build); a brand font that cannot be found falls back to Inter, and only a missing Inter sends text templates to needs review, as before.

## Phase 12 health (p12/health)

No new environment variables and no migration. Two existing ones gain a use:

| Name | Now also used by | Unset means |
| --- | --- | --- |
| `CRON_SECRET` | The detailed `/api/health` report and the `/api/health/providers` key probe (`Authorization: Bearer <CRON_SECRET>`). | `/api/health` gives only the public body; `/api/health/providers` answers 404. |
| `CURVI_SHOT_CONCURRENCY` | Reported by the detailed health report next to the container memory limit and current RSS. A value that is not a whole number raises `shot_concurrency_invalid`. | The runner default of 2 shots at once. |

What changes for the founder:

1. **`/api/health` warnings now cover drift.** Besides `storage_not_configured`, `no_llm_provider` and `no_image_provider`, it can list `no_cutout_provider`, `recipe_drift` (the recipes table differs from the seed in the deployed build, so production runs other prompts or models), `recipe_check_failed`, `cron_never_ran:<name>`, `cron_overdue:<name>` (last success older than twice the interval: stale-jobs every 10 minutes, purge-source-media daily), `cron_check_failed`, `shot_concurrency_invalid` and `memory_high` (RSS at 85 percent of the container limit or more). Warnings never change `ok` or the status code. Until both crons are scheduled (Phase 12 A4), the two `cron_never_ran` warnings are expected, so the short smoke test in step 16 reads `"warnings":[]` only after that.
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
| `FAL_KEY` | Cutout chain (`trigger/src/live-runtime.ts`, `packages/ai/src/adapters/falCutout.ts`) | No live cutout provider: `/api/health` warns `no_cutout_provider` and every shot of a real pack goes to review | fal.ai API key. Required. A secret: Render (and Trigger.dev once step 14 is done) only, never in the repo. Model and price come from `cutoutModelSeedRows` (packages/pipeline/src/seed/models.ts). |
| `PHOTOROOM_API_KEY` | Nothing any more | Nothing | Remove it from Render and from `.env.example`; no code reads it. Cancel the Photoroom plan once packs run on fal. |

What changes for the founder:

1. **Set `FAL_KEY` on Render before this deploys** (Save only, then deploy), and top up the fal balance. Verify: `/api/health` has no `no_cutout_provider` warning, then run one pack.
2. **Out of quota is now loud and contained.** A provider answering 402 or an out of credit message (fal "Exhausted balance", BFL "Insufficient credits", OpenAI `insufficient_quota`, Gemini `RESOURCE_EXHAUSTED` on a billing or daily quota, Anthropic "credit balance is too low") is never retried: its breaker opens for 30 minutes, the Render log gets an error line `"event":"provider_quota_exhausted"`, an `events` row with that name (provider and task) is written at most once an hour per provider, and `/api/health` lists `provider_quota:<provider>` while the breaker is open. Fix: top up that account. The breaker lives in the web process, so a deploy or restart clears it at once after a top up.
3. **Scenes degrade instead of failing the pack.** When every image provider is down, packs still deliver the white background, alternate angle, cutout and sweep files, and each lifestyle scene is marked "Paused, the scene service is unavailable, not charged". Only delivered files are charged.
4. **One automatic retry.** Shots that fail on a timeout, 429, 5xx or network error run once more 30 seconds later in the same run (not for quota answers, safety refusals or other 4xx).
5. **Preflight on the new pack page.** While the cutout service is down the page says "Packs are paused for a few minutes while an image service recovers. Nothing will be charged." and Create pack is disabled; while only scenes are down a softer banner says white background and cutout files still work.

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
