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
| 6 | Apply migrations 0011 to 0013 to production | Founder | Step 7 |
| 7 | Push main (batch 1 goes live) | Founder | Steps 8 to 13 |
| 8 | Render health check path and shutdown delay | Founder | Safe deploys |
| 9 | Render plan upgrade | Founder (costs money) | Paid launch |
| 10 | Stripe live mode | Founder | First dollar |
| 11 | Upstash Redis | Founder | Shared rate limits |
| 12 | PostHog | Founder | Funnel data |
| 13 | Sentry | Engineer, then founder | Error alerts |
| 14 | Trigger.dev v4 and Cloud | Engineer, then founder | Durable packs, scheduled jobs |
| 15 | Uptime monitor | Founder | Outage alerts |
| 16 | Post deploy smoke test | Founder | Announcing paid plans |

## 1. Legal review of terms and privacy (start early)

**Who:** founder, with a lawyer.

**Do:** have counsel review the live pages at https://curvi.ai/terms and https://curvi.ai/privacy (source: `apps/web/src/app/(marketing)/terms/page.tsx` and `privacy/page.tsx`). Points to cover:

- The legal entity name, address, contact (hello@curvi.ai) and governing law.
- Credits, subscriptions and refunds as the product actually works: credits are held when a pack starts, charged only for delivered assets, and released otherwise; a refund or dispute claws back the credits that invoice granted (PHASE_10 decision 3); annual plans grant the year of credits on the paid invoice (decision 2).
- Uploaded content: the license customers grant to process their photos, retention and deletion.
- AI generated output: Concept Mode images are generated and labeled as such; Listing Mode keeps the real product pixels. Acceptable use, and the moderation gate that holds flagged uploads.
- Subprocessors: Render (hosting), Supabase (database and auth), Cloudflare (R2 storage, DNS, email routing), Stripe, Resend, PostHog, Sentry, Upstash, Trigger.dev, and the model providers Anthropic, Google (Gemini), Black Forest Labs, OpenAI, Photoroom and fal.
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

## 6. Apply migrations 0011 to 0013 to production, before pushing main

Batch 1 code needs 0011 (tenant write lockdown), 0012 (signup grant on confirmed email) and 0013 (source media dedupe). Main auto deploys, so the migrations go first.

**Who:** founder (an engineer can prepare and review the SQL with them).

**Do:**

1. Confirm production is at 0010: `select id, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1;` should return the `when` of `0010_spend_cap_counters` from `packages/db/migrations/meta/_journal.json`. The table exists since 2026-09-28 (docs/verification.md).
2. Use the **direct connection** string (Supabase, Connect, Direct connection, port 5432). Supabase recommends it for migrations; the transaction pooler (port 6543) does not support prepared statements. The direct host is IPv6 only without the IPv4 add on; from an IPv4 only network use the session pooler (also port 5432).
3. From a checkout of the merged batch, load the connection string without leaving the password in shell history (`read -s DATABASE_URL && export DATABASE_URL`, then paste), and run `pnpm db:migrate`. Drizzle applies only migrations newer than the newest recorded row, so it runs exactly 0011, 0012 and 0013 in order. (The by hand alternative used on 2026-09-28: run the three files in one transaction in the SQL editor, then record each in `drizzle.__drizzle_migrations` with the sha256 of the file and the journal `when`.)
4. Each migration must keep working with the code that is live right now, because the old instance keeps serving until the new deploy is healthy (expand first, contract in a later release).

**Verify:** the query from 1 now returns the `when` of `0013_*`. The production spot checks each package recorded for its migration in docs/verification.md pass (for example, for 0012, a new confirmed signup gets exactly one grant). After step 7, `/api/health` reports `"schema":"current"`. Once step 8 is done, a build whose migrations are missing never receives traffic: its health check returns 503 with `"schema":"behind"` and Render cancels the deploy while the old version keeps serving.

**Source:** https://supabase.com/docs/guides/database/connecting-to-postgres (checked 2026-09-28).

## 7. Push main

**Who:** founder.

**Do:** merge `full-stack-update` into main only after steps 5 and 6. Then watch CI, and the Render deploy that follows it.

**Verify:** `curl -s https://curvi.ai/api/health` returns HTTP 200 with `"ok":true`, `"mode":"db"`, `"database":"ok"`, `"schema":"current"`, `"warnings":[]` and `"commit"` equal to the first seven characters of the pushed commit. A warning such as `storage_not_configured`, `no_llm_provider` or `no_image_provider` means a Render environment variable is missing; packs cannot be delivered until it is set.

## 8. Render health check path and shutdown delay

Do this only after step 7. The code live before batch 1 has no `/api/health`; pointing Render at a path that returns 404 would mark the instance unhealthy and restart it every minute.

**Who:** founder.

**Do:**

1. Render, the Curviai service, Settings, Health Checks, Edit: path `/api/health`, Save Changes. Render then routes traffic to a new deploy only once every new instance passes, cancels a deploy that never passes within 15 minutes, stops routing to an instance after 15 seconds of failures and restarts it after 60 seconds. Checks time out after five seconds; the endpoint's database steps time out after two. Trade off to know: a database outage longer than a minute makes Render restart the instance (a restart cannot fix it, but it does no extra harm, since packs cannot progress without the database either). Missing env values only show up as `warnings` and never fail the check.
2. Shutdown delay (not in the dashboard; Render documents it for render.yaml and the API): `PATCH https://api.render.com/v1/services/<service id>` with header `Authorization: Bearer <Render API key>` and body `{"serviceDetails":{"maxShutdownDelaySeconds":300}}`. Allowed range 1 to 300, default 30.
3. Environment, add `CURVI_INLINE_PACK_CONCURRENCY` = `1` (raise it in step 9).
4. Only after the API shows 300 in step 2: optionally add `CURVI_SHUTDOWN_GRACE_MS` = `240000`, so a deploy lets running packs finish for up to four minutes before settling them. Leave it unset otherwise; the default grace (20 seconds) fits inside Render's default 30.

What happens on a deploy or restart: Render sends SIGTERM to the old instance 60 seconds after the new one is live. The inline runner stops taking packs, marks every pack that had not started as failed and releases its credits, waits the grace window for running packs, then settles whatever is still running: failed with "The server restarted while this pack was running. Reserved credits were released, so you can run it again.", or done when its files were already delivered. No job is left in a working state.

**Verify:** the Health Checks section shows `/api/health`. `GET https://api.render.com/v1/services/<service id>` shows `serviceDetails.healthCheckPath` `/api/health` and `serviceDetails.maxShutdownDelaySeconds` 300. Drill: start a pack, then click Manual Deploy. The pack either finishes, or ends failed with the restart message and its held credits back in the balance. The old instance's log shows `[jobs] SIGTERM: inline runner drained (...)`.

**Sources:** https://render.com/docs/health-checks, https://render.com/docs/deploys (Graceful shutdown), https://render.com/docs/blueprint-spec, https://api-docs.render.com/reference/update-service (checked 2026-09-28).

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

Until then, packs run on the inline runner: limited by `CURVI_INLINE_PACK_CONCURRENCY` and drained on SIGTERM (step 8). A hard crash or out of memory kill still loses the running packs; the stale run reconciler fails them and releases their credits after 30 minutes.

**Who:** an engineer upgrades the code, then the founder sets up the account.

**Do:**

1. Engineer: `npx trigger.dev@latest update` (moves `@trigger.dev/*` to 4.x), change imports to `@trigger.dev/sdk`, define queues ahead of time with `queue()`, switch lifecycle hooks to the single object parameter, and apply both items in Update.md "Before moving pack jobs to Trigger.dev cloud" (ship the template font, keep the cutout to one per job).
2. Founder: create the Trigger.dev Cloud project, set the production environment variables there (database, R2, provider keys, Resend), and deploy the tasks (`pnpm --filter @curvi/trigger run deploy`; the `run` matters, since `pnpm deploy` is a different built in command).
3. Founder: set `TRIGGER_SECRET_KEY` (the production secret key) in Render and redeploy.

**Verify:** a pack created on curvi.ai appears as a run in the Trigger.dev dashboard and reaches done; the Schedules page lists the three scheduled tasks with their next run times; the first Monday digest arrives.

**Sources:** https://trigger.dev/docs/migrating-from-v3, https://trigger.dev/docs/upgrade-to-v4 (checked 2026-09-28).

## 15. Uptime monitor

**Who:** founder.

**Do:** point an external uptime monitor (for example Better Stack or UptimeRobot; pick any) at `https://curvi.ai/api/health`, expecting HTTP 200 and a body containing `"ok":true`, plus a second check on `https://curvi.ai/`. Alert the founder by email and phone.

**Verify:** a test alert from the monitor arrives.

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
