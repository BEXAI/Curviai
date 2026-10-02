
# Phase 20: take money safely, notice when production breaks, and keep the first customers

Date: 2026-10-01. Source: the founder's request for a robust PHASE_20 covering everything the website still needs to succeed with customers and to operate correctly, the approved outline for this phase, three read only audits and two design passes, and three dated verification notes. Release 2 (the money gate) depends only on main and this phase's own items, so it can ship before PHASE_18 and PHASE_19 are built (neither has started: PHASE_18.md "Not started", p18/integration at its contract commit, p19/integration at wave 0). Releases 3 and later assume docs/phases/PHASE_18.md and docs/phases/PHASE_19.md (both finished and reviewed on 2026-10-01) are integrated, and that the `site-visitors` branch (head 32928fa, already merged into `p18/integration`) is merged with them; an item that extends a PHASE_18 or PHASE_19 piece names it and waits for it.

This file is written for the AI developer who will build it. Read it in full before the first change (CLAUDE.md rule 1). Every "today" claim below was checked in the code on main at ccbd555, in the 2026-10-01 working tree (render.yaml, .gitignore and three docs changed, uncommitted), on `site-visitors` and on `seed-openai-serving` (f909043). Every external fact was read on 2026-10-01 and must be checked again and dated in docs/verification.md before code relies on it (rule 7); "External facts" below lists each row the build adds.

Short names for the evidence used throughout (all under `research_notes/Curvi phase 20 readiness/`):

| Short name | File |
| --- | --- |
| OD | operations_workstreams_design.md |
| CD | customer_workstreams_design.md |
| OA | operations_audit.md |
| CA | customer_journey_audit.md |
| INV | planned_and_deferred_inventory.md |
| V-ops | verify_ops_vendors.md (Sentry, monitors, Upstash, GitHub, Turnstile, fal) |
| V-data | verify_data_and_hosting.md (Supabase, Render, R2) |
| V-bill | verify_billing_and_legal.md (Stripe, US renewal law, CAN-SPAM) |

OD numbered its items P20-O01 to P20-O44 and CD numbered its own P20-01 to P20-28. This file merges both into one series, P20-01 to P20-65, plus P20-66 added by the review; the old numbers appear only in the "From" line of each item.

## Goal

1. A payment can never leave a customer without credits, and every statement about credits, renewal, refunds and retention matches what the code does.
2. When production breaks, the founder hears about it within minutes from a channel that does not depend on the broken part, not when a seller emails.
3. Data loss has a tested way back: a nightly off platform backup and a recorded restore drill.
4. A customer can sign up on any device, reach a person from inside the app, see where their credits went, make another version of a scene, and see their place in the queue.
5. The founder can see and steer production from one page (switches, jobs and alerts), with margins in the weekly report until volume earns the economics page.
6. The basics a public, paid product needs: shared rate limits, dependency and secret scanning, an enforced CSP, a staging stack and a real smoke test.

## Why now

- **Money.** docs/marketing.md task MKT-006 (gate G3) buys a real plan within days. Today checkout opens whenever `STRIPE_SECRET_KEY` alone is set (apps/web/src/lib/env.ts line 24, read by nine selling surfaces), while the webhook answers 503 without `STRIPE_WEBHOOK_SECRET` (apps/web/src/app/api/webhooks/stripe/route.ts lines 48 to 57). The only Stripe readiness signal is `{ name: "stripe", configured }` in the `services` list of the CRON_SECRET protected `/api/health/providers` (apps/web/src/lib/health.ts line 79, app/api/health/providers/route.ts lines 70 to 78); the public `/api/health` body has no services key (lib/service-health.ts lines 280 to 294). A half configured Stripe takes a card and grants nothing, with no warning (CA section 0).
- **Data.** Supabase Free keeps no automatic backups ("We automatically back up all Pro, Team, and Enterprise Plan projects", V-data section 1). Migrations are applied by hand, and PHASE_18 and PHASE_19 add ten more (eleven counting `0027_site_visits`).
- **Seeing failures.** No Sentry SDK is installed, and health warnings never change `ok` (apps/web/src/lib/service-health.ts line 260). Only OpenAI LLM quota answers (`llmQuotaAlertFamilies = ["openai"]`, packages/pipeline/src/seed/monitoring.ts line 55) and the daily spend alerts reach the founder today; PHASE_18's P18-03 adds cutout and image quota emails.
- **A re-seed undoes the founder.** `loadPlatformSettings` upserts every seeded row (trigger/src/platform-settings.ts lines 22 to 28), so each `pnpm db:seed` resets `output_options_enabled` and every switch PHASE_18 seeds (`acquisition_paused`, `free_preview_enabled`, `lifecycle_email_enabled`, `referrals_enabled`). The same pattern let the recipe seed drift from production after the 2026-10-01 SQL switch to OpenAI (docs/phases/PHASE_17.md, known gaps).
- **Law.** California's amended automatic renewal law applies to contracts from 2025-07-01, and Virginia's 2026 text counts small businesses as consumers (V-bill section 9). Curvi's cancel flow requires a reason before it continues and shows save offers without a cancel button beside them (apps/web/src/components/app/cancel-flow.tsx lines 183 and 218).
- **Price.** A generative still may sell below cost: docs/PENDING.md line 101 estimates about $0.17 a still against $0.08 to $0.145 of revenue per credit. Repricing after customers hold credits is harder than before.
- **Packs.** The founder chose to keep the inline pack runner. It shares one 2 GB instance with the site, sign in and the Stripe webhook; an out of memory crash orphans packs for 30 minutes (apps/web/src/lib/services/reconcile.ts line 27). PHASE_18's P18-23 requeues on a clean drain only. This phase hardens the runner instead of replacing it.

Corrections carried forward (do not repeat these errors):

- Seller credits do not expire on 2026-12-31. That date is the founder's OpenAI provider credit (docs/phases/PHASE_17.md decision 4). Today subscription grants never expire and top ups write an `expires_at` 12 months out (apps/web/src/lib/billing/db-store.ts line 160) that nothing reads (the only reference is the column, packages/db/src/schema.ts line 520). P20-05 settles the wording.
- The FTC's 2024 "click to cancel" amendments are not in force: the Eighth Circuit vacated them on 2025-07-08 and the FTC recodified the 1973 rule effective 2026-02-12 (V-bill section 8). ROSCA plus the state laws set the rules here.
- Haiku 4.5 is not retiring on 2026-10-15. Anthropic's deprecations page lists it as active with retirement "not sooner than" that date and promises 60 days' notice. `seed-openai-serving` removes it from every active chain anyway ("Do before the phase", item 1).
- The Phase 15 follow up gaps (added overlays ignored by follow ups, per photo background ignored by replay) were fixed in commit 1e87799. They are not in this phase.
- fal's balance endpoint needs an Admin scope key, and fal documents no auto top up (V-ops section 7). PHASE_18's P18-03 already adds the balance probe with `FAL_ADMIN_KEY`.
- Better Stack's free plan is labeled "Free for personal projects" and does not list keyword checks; UptimeRobot's terms allow commercial use (V-ops section 3). The default monitor is UptimeRobot.
- A Render native cron cannot back up a Postgres 17 server: Render's native runtimes ship `postgresql-client` up to 14 and pg_dump refuses newer servers (V-data section 2). The backup cron runs on Docker.
- Deploying a commit or rolling back through Render's API does not turn auto deploy off (V-data section 7). The release script turns it off first.

## Scope

66 item IDs, P20-01 to P20-66, in nine workstreams and an optional Batch 5. 16 are P0, 40 are P1 and 10 are P2. Four items are split: P20-06 and P20-07 have a P0 part and a P1 part; P20-35 and P20-59 have a P1 part and a P2 part triggered by volume.

| Priority | Meaning |
| --- | --- |
| P0 | Release 2, the money gate. Only what protects a payment or recovers data; ships before live Stripe keys, and depends on no PHASE_18 or PHASE_19 work |
| P1 | Releases 3 and 4 |
| P2 | Release 5 or later; each item waits for its own condition: optional growth (Batch 5), or a volume trigger read from the weekly report (a second instance, a queue wait seen, the first team request, a workspace near a list limit) |

| # | Workstream | Items | Priority |
| --- | --- | --- | --- |
| W1 | Take money safely | P20-01 to P20-09, P20-66 | P0, except P20-09 (P1) and the P1 parts of P20-06 and P20-07 |
| W2 | Production safety net | P20-10 to P20-22 | P0 (P20-10, P20-11, P20-13, P20-15, P20-17, P20-20), P1 (P20-12, P20-14, P20-16, P20-18, P20-19, P20-21, P20-22) |
| W3 | Trust, legal and support | P20-23 to P20-27 | P0 (P20-23), P1 (P20-24 to P20-27) |
| W4 | Sign in | P20-28 to P20-31 | P1 |
| W5 | Keep packs flowing | P20-32 to P20-40 | P1, except P20-36 and the priority and fairness part of P20-35 (P2, triggered) |
| W6 | Pack experience | P20-41 to P20-44 | P1, except P20-43 (P2, triggered) |
| W7 | Founder cockpit | P20-45 to P20-50 | P1, except P20-48 (P2, triggered; P20-04's report covers it until then) |
| W8 | Security and delivery | P20-51 to P20-58 | P1, except P20-57 (P2, triggered) |
| W9 | Teams | P20-59 | P1 (member emails, billing roles, default workspace), P2 (invites and the switcher, triggered) |
| B5 | Optional growth | P20-60 to P20-65 | P2 |

The P0 set is deliberately small (review finding, 2026-10-01): every item moved out of it has a manual stopgap in "Do before the phase" that holds until its release.

## Non goals

- **No new runner.** The inline pack runner stays (founder decision recorded in the outline). No Trigger.dev v4, no Render Workflows or background worker in this phase.
- **Nothing PHASE_18 or PHASE_19 owns.** The table below lists each shared piece and what this phase adds to it. No marketing email (P18-06 and P18-07), no attribution or funnel work (P18-01, P18-02), no plugin, OAuth or MCP tool work (PHASE_19).
- **No change to how images are made.** Regenerate (P20-41) and Adjust (P20-62) reuse the runner, the composite step and the fidelity gate, so rule 3 holds by construction.
- **No trials and no price changes** beyond the one P20-04 decides from data.
- **No paid vendor without a founder decision.** Most defaults are free tiers, but not all: counsel review (decision 9), an accountant and Stripe Tax (decision 3), Supabase Pro (decision 11) and the healthchecks.io Supporter plan (decision 14) cost money. Each of those decisions gives a dollar estimate and a free or deferred alternative, and "Running cost after each release" below adds them up. PITR and Sentry Team stay out.
- **Explicitly later (PHASE_21 and up):** CSV and catalog runs on durable workers, Agency client workspaces, the Shopify app, video, i18n, and a free crop editor. See "Explicitly later and backlog".

## Boundary with PHASE_18 and PHASE_19

Each row is a piece one of those phases owns. PHASE_20 builds on it and never rebuilds it.

| Piece | Owner | What PHASE_20 adds |
| --- | --- | --- |
| Resend sender `sendEmail`, suppression list, `email_sends` (P18-06) | PHASE_18 | P20-07's P1 notices, P20-24 (support mail) and P20-59 (invites) send through it as `kind: "transactional"`, which a marketing unsubscribe never suppresses (V-bill section 10); bounce and complaint suppression still applies to every one of them. P20-07's P0 activation email ships before P18-06 exists: it goes through the Resend fetch path `sendFounderEmail` already uses (trigger/src/spend-alerts.ts), wrapped as `sendBillingEmail` with its own dedupe key, and moves onto `sendEmail` when P18-06 merges. P18-06's template lint (a ban on "expire" next to "credits") stays as written: P20-05's credit sentence never uses the word. |
| Lifecycle templates (P18-07) | PHASE_18 | P20-05 changes the `out_of_credits` line "Top ups start at ${topup} and last 12 months" to the single credit sentence, which avoids "expire" so the P18-06 lint passes unchanged. If P18-07 has not merged when P20-05 ships, P18-07 adopts the sentence when it lands. |
| Funnel events and the weekly funnel email (P18-02) | PHASE_18 | P20-38 adds "Money" and "Operations" sections to the same weekly email, built in apps/web next to P18-02's funnel-digest route and sent through the same `sendFounderEmail` to `FOUNDER_ALERT_EMAIL`, and runs that route from the tick. No second weekly email and no second send path: trigger/src/digest.ts's own sender and `METRICS_DIGEST_TO` go with P20-18. |
| fal balance probe, acquisition gate, quota emails for cutout and image providers, `GET /api/status` (P18-03) | PHASE_18 | P20-15 maps its states to `degraded`; P20-16 covers every other provider family, adds a canary, stores probe results and creates the `fal_balance_low` warning from P18-03's balance rows; P20-19 adds a `maintenance` reason to `acquisition.ts`; P20-20 moves its `acquisition_paused` switch to an `ops:` key; P20-27 reads `/api/status`. |
| Requeue on a deploy drain, `generation_jobs.restart_count`, seed `deployRestarts` (P18-23) | PHASE_18 | P20-32 finds jobs orphaned by a crash; P20-33 stores the run payload, makes boot pickup safe across two instances and fixes COGS across runs. If P18-23 has not shipped when P20-33 starts, P20-33 builds P18-23 as written first. P20-19's `ops:deploy_pending` waits for P18-23 or P20-33 to be live, because without a requeue the drain fails every pack that had not started (docs/LAUNCH_CHECKLIST.md line 165). |
| Pack feedback and quote consent (P18-05) | PHASE_18 | P20-25 alerts the founder on "Not yet" and links that answer to support. Testimonials are not rebuilt here. |
| Gallery labels and cleanup (P18-14) | PHASE_18 | P20-50 adds an approval queue before anything is public, enforced in the owner connection queries (`DbShareStore`, the share page's `inGallery`, P18-14's sitemap) as well as in the anonymous policy. |
| Growth API line "API keys for the Curvi API and MCP server" (P18-11, with P19-24's `agentApi` flip) | PHASE_18 | P20-08 does not add the line. Because the cards render from apps/web/src/lib/billing/plan-features.ts (pricing-tiers.tsx), not from the seed's `includeLines`, P20-08 only makes sure P18-11's line reaches plan-features.ts, gated by `agentApi`, when P18-11 lands. |
| Google sign in through /auth/callback (P18-13) | PHASE_18 | P20-28 moves the shared post sign in steps into one module both routes call. |
| Generative still price (P18 decision 18) | PHASE_18 decision | P20-04 provides the measurement and the seed change that settles it. |
| Referral reward expiry of 12 months (P18 decision 12) | PHASE_18 decision | Decision 10 here makes reward credits follow the no expiry rule. |
| Money back promise (P18 decision 14) | PHASE_18 decision | P20-23's refund section prints it once the legal review approves it. |
| Operator gate `isOperator` over `OPS_EMAILS` and /app/ops/visitors (`site-visitors`); /app/ops/prospects and /app/ops/funnel (P18-04, P18-02) | `site-visitors`, PHASE_18 | P20-45 adds the /app/ops layout and navigation; P20-49 requires a second factor on every operator page and action, these pages included. |
| Free preview (P18-12) and store audit (P18-18) | PHASE_18 | P20-29 adds Turnstile siteverify to both; P20-40 moves the cutout cache that P18-12's claim copies into, and its one lifecycle file carries P18-12's `anon/` rule beside `tmp/` (applying a lifecycle configuration replaces every rule); P20-23 states the preview window. |
| `/support` page (P19-23) | PHASE_19 | P20-24 adds the contact form. If PHASE_19 has not merged, P20-24 creates the page with P19-23's copy. |
| `listMemberships` and the consent page workspace picker (P19-09) | PHASE_19 | P20-59's workspace switcher reuses both. |
| Rate limits by caller, `ipExempt` (P19-21) | PHASE_19 | P20-51 adds the trusted IP header and Upstash for callers that are not IP exempt. |
| Restrictive `no_oauth_clients` policy on every public table, with a test that walks every table (P19-05) | PHASE_19 | Every new table in this phase gets the policy in its own migration; P19-05's walk test fails otherwise. |
| Assistant privacy section and the log retention number (P19-23, P19 decision 10) | PHASE_19 | P20-23 reads that number from one legal facts module. |
| Redacting MCP logger, signed link tokens in paths (P19-02, P19-08, P19-17) | PHASE_19 | P20-13's Sentry scrubber and P20-57's logger strip those tokens, plus PHASE_18's claim tokens (`/api/claims/[token]/...` and the claim share page, P18-04) and any P18-12 signed download path, from one shared constant `TOKEN_PATH_PREFIXES`. |
| Reviewer account with password login and no MFA (P19 decision 14) | PHASE_19 | P20-29 (Turnstile) and P20-63 (customer two step sign in) must not block that login. |
| Neutral MCP copy table `lib/api-v1/mcp-copy.ts` (P19-14) | PHASE_19 | P19-14's table has no row for the refusals this phase adds to createJob. P20-19 (packs paused), P20-37 (workspace day cap) and P20-42a (`empty_plan`) each add their row to `mcp-copy.ts`, extending P19-14, and P19-14's rule 9 and word list lint covers the new rows. |

## Do before the phase

Time critical steps that do not wait for any item. Founder steps need the founder's accounts, money or credentials; agents never log in to them.

| # | Action | Who | Why now |
| --- | --- | --- | --- |
| 1 | **Seed alignment and Haiku replacement.** Review and merge branch `seed-openai-serving` (f909043): every OpenAI recipe version at `trafficPct` 100, every Claude predecessor active at 0, `claude-sonnet-5` in place of Haiku 4.5 in every active chain, with seed tests for both. Copy the guarded SQL out of the session scratchpad now (`/private/tmp/claude-501/-Users-nathaniel-Developer-Curviai/b0ba12eb-ca89-476f-a31e-4ea9d12c6e89/scratchpad/seed-openai-serving.sql`; the scratchpad is deleted with the session) and keep it with the founder's notes. Take a pg_dump (item 2), then run that SQL in the Supabase SQL editor. Confirm `/api/health` details show no `recipe_drift`. | AGENT done; FOUNDER merges and runs the SQL | Until it runs, any re-seed from PHASE_18, PHASE_19 or this phase flips production LLM traffic back to Claude, and production still has Haiku in ten chains. |
| 2 | **Manual pg_dump before migration 0027 and before every migration applied by hand** until P20-12 exists. Run `SHOW server_version;` in the SQL editor first and record it. Use a pg_dump of that major version or newer (macOS: `brew install postgresql@17`), the session pooler connection string (`postgresql://postgres.[REF]:[PASSWORD]@aws-[INDEX]-[REGION].pooler.supabase.com:5432/postgres`; the direct host is IPv6 only on Free, V-data section 2), `--format=custom`. Encrypt the file and keep it off the laptop. | FOUNDER | Supabase Free keeps no restorable backup (V-data section 1). |
| 3 | **Render settings.** Read `maxShutdownDelaySeconds` on the live service (`GET https://api.render.com/v1/services/{id}`); the hand made service ignores render.yaml. Only when it is 300, set `CURVI_SHUTDOWN_GRACE_MS=240000`. Set `CURVI_INLINE_PACK_CONCURRENCY=2`. Confirm `TRIGGER_SECRET_KEY` is not set (setting it makes every pack fail to queue, apps/web/src/lib/jobs/enqueue.ts lines 41 to 47). Approve committing the working tree render.yaml (plan `1c-2g`, concurrency 2; PHASE_18 founder step 2). Until P20-19 ships, push to main only when `/api/health` shows `"running":0`, or turn auto deploy off. Before relying on concurrency 2, run two Everything packs at once and read Render's memory graph. | FOUNDER | A deploy kills running packs after the default 20 second grace (apps/web/src/lib/jobs/inline-runner.ts line 134). |
| 4 | **Public repo hygiene.** Commit the working tree .gitignore, which already ignores root images. Move `IMG_8958.JPG`, `IMG_9004.jpeg`, `Image 9-28-26 at 2.08 PM.png` and `google_merchant_lifestyle_01.jpg` out of the repository folder (ignored files can still be added by force). Secret scanning and push protection are already on (live check, V-ops section 5). Decide `reports/` and `research_notes/` (decision 25). | FOUNDER, AGENT XS | BEXAI/Curviai is public and owned by a user account. |
| 5 | **fal.** Top up the primary account. Open a second fal account with about $10 prepaid and set it as `FAL_KEY_BACKUP` (the seed already supports it, packages/pipeline/src/seed/models.ts lines 197 to 214). New accounts start at 2 concurrent requests and purchased credits expire after 365 days (V-ops section 7). Create an Admin scope key per account for P18-03 (`FAL_ADMIN_KEY`, `FAL_ADMIN_KEY_BACKUP`). Look for auto top up on fal.ai/dashboard/billing and record what is there (undocumented). After the top up, wait 30 minutes from the last quota answer (or until P20-16's canary clears it). Do not restart for this: provider preflight re-trips the cutout breakers from `provider_quota_exhausted` events younger than 30 minutes on every check (apps/web/src/lib/provider-preflight.ts lines 152 to 180 and 226 to 231), so a restart only kills running packs. | FOUNDER | Packs that need a cutout are paused. |
| 6 | **A founder alert that arrives.** Set `FOUNDER_ALERT_EMAIL`, `RESEND_API_KEY` and `FOUNDER_ALERT_FROM` on an address of the Resend verified `updates.curvi.ai` subdomain (the default `alerts@curvi.ai`, trigger/src/spend-alerts.ts line 84, needs `curvi.ai` itself verified). Send one test alert. Add a free UptimeRobot keyword monitor on `https://curvi.ai/api/health` matching `"ok":true`, and append a healthchecks.io ping to both existing cron commands (check the check shows "up" in its dashboard: a wrong check id still answers HTTP 200, V-ops section 2). | FOUNDER | Every founder alert falls back to a log line until this works. |
| 7 | **Spend guard.** Set `DAILY_SPEND_HARD_STOP_USD=25` (decision 8; a restart, so at a quiet time) and provider side limits: an OpenAI project budget, no unlimited fal recharge. | FOUNDER | The default hard stop is $150 a day across all tenants (packages/ai/src/caps.ts lines 17 to 25). |
| 8 | **Record the dashboard crons.** Copy the schedule and command of `curvi-stale-jobs` and `curvi-purge-media` from the Render dashboard into docs/LAUNCH_CHECKLIST.md. | AGENT XS (founder reads the values out) | They exist only in the dashboard. |
| 9 | **Stripe keys stay out.** Do not set `STRIPE_SECRET_KEY` in Render until the Release 2 gate (decision 1). If it is already set, set `STRIPE_WEBHOOK_SECRET` and every `STRIPE_PRICE_*` in the same change. | FOUNDER | Today the secret key alone opens checkout. |
| 10 | **Switches after every re-seed.** Until P20-20 is live, after each `pnpm db:seed` (this phase's or PHASE_18's), read every switch row (`select key, value from platform_settings`) and set back any the founder had changed: `output_options_enabled`, and once PHASE_18 seeds them `acquisition_paused`, `free_preview_enabled`, `lifecycle_email_enabled`, `referrals_enabled` and the background switch. Write the values down before seeding. | FOUNDER (the agent drafts the SQL) | `loadPlatformSettings` upserts every seeded row (trigger/src/platform-settings.ts lines 22 to 28), so a release silently un-pauses acquisition. PHASE_18's releases run `pnpm db:seed` before P20-20 can ship. |
| 11 | **Stripe test mode and fixtures.** Create the products, prices, webhook and portal of docs/STRIPE_SETUP.md sections 1 to 6 in test mode only. On the laptop, run `stripe listen --forward-to localhost:3000/api/webhooks/stripe` and the test checkouts P20-03 lists (monthly and annual start, renewal with a test clock, top up, upgrade, refunds, a won and a lost dispute), saving each event's JSON. Hand the files to the agent, who scrubs the ids into `lib/billing/fixtures/`. | FOUNDER | P20-03's flow tests replay these real payloads; agents never log in to Stripe. |

## Founder decisions

Open on 2026-10-01. Each has a recommended default that the builder uses unless the founder writes a different answer here. A changed number lands in the seed (rule 2), not in code.

**Money**

1. **When live Stripe keys go in.** Default: only after the Release 2 gate (every P0 item merged and live; a test mode run of docs/STRIPE_SETUP.md section 8 done locally with the Stripe CLI forwarding webhooks and checked by `pnpm billing:verify`). Release 2 depends on no PHASE_18 or PHASE_19 work and targets about day 10 to 14 (2026-10-11 to 2026-10-15); the live key also waits on Stripe's account review. What moves with it, each recorded by the operator agent as a dated changelog line in docs/marketing.md with the founder's approval:
   - MKT-006 (window 2026-10-03 to 2026-10-06) moves to the day after the gate.
   - MKT-015 (concierge packs, 2026-10-05 to 2026-10-07) does not wait: P20-66 grants the founder workspace its concierge credits before live keys.
   - The MCP client test before PHASE_19's `agentApi` flip, which MKT-006 step 2 meant to unlock with a Growth purchase, uses the founder workspace comped on Growth by SQL (the agent drafts it, the founder runs it), as PHASE_19 decision 14 comps the reviewer on Starter; the workspace goes into docs/marketing-ops/exclusions.md.
   - MKT-021 (founding code, 2026-10-15 to 2026-10-19), PHASE_18 founder step 4 (a live purchase) and P18-21's banner follow the gate.
   - If the gate slips past day 30 (2026-10-31), D-004's payment question cannot be measured on day 30; it is measured 30 days after live keys instead.
2. **Generative still price (answers PHASE_18 decision 18 if it is still open).** Default: set `creditCosts.generativeStill` from P20-04's rule at a 60 percent target margin against the lowest self serve revenue per credit, including every promotion code (today the founding annual price, about $0.079 a credit), rounded up to the next half credit. If live data is thin, 3 credits now (P20-04's worked example at a p90 of $0.08) and a re-check after 30 days of real packs. No grandfathering: no paying customer exists yet.
3. **Tax.** Default: Stripe Tax Basic (0.5 percent per transaction where registered, V-bill section 5) with threshold monitoring; register only where required, starting with the home state; US prices exclude tax. An accountant confirms (rough estimate, not a quote: $200 to $500 once for a sales tax nexus consult). Free alternative: Stripe Tax off (`STRIPE_TAX_ENABLED` unset), threshold tracking by the founder from Stripe's revenue reports, and the accountant only once sales near a state threshold. Revisit a merchant of record if consumer sales outside the US appear.
4. **Renewal law posture.** Default: build to the strictest common standard (California, Minnesota, New York, Virginia; V-bill section 9) instead of gating by state: the five offer terms beside the buy button, a required renewal checkbox, consent records kept 3 years, an activation email, a renewal reminder 30 to 45 days before each annual renewal, one yearly notice to monthly subscribers, price change notices 7 to 30 days ahead, and a cancel button always beside any save offer. Stripe's own renewal reminder emails stay off (one account wide timing for monthly and annual alike, V-bill section 6), which reverses docs/STRIPE_SETUP.md section 6 today (P20-07 edits it). The P0 part of P20-07 ships what applies at the first sale (disclosures, checkbox, consent record, activation email, cancel flow). The reminders and notices are its P1 part, each due before its first possible send: the annual reminder before the first annual subscription is 300 days old, the yearly notice before the first monthly subscription is 330 days old, and the price notice CLI before any price change for existing subscribers. Counsel confirms coverage of business buyers.
5. **Downgrades.** Default: take effect at the end of the period through a Stripe subscription schedule (P20-06's P1 part, before the first paying subscriber asks to downgrade or by Release 3, whichever comes first). Until then, P20-06's P0 stopgap: the portal offers only upgrades, and a downgrade is a short email that the founder schedules in the Stripe Dashboard for the period end. Alternative if declined: the stopgap disclosure in P20-06.
6. **Agency.** Default: off self serve until client workspaces exist (PHASE_21). Pricing shows "Need more than Pro? Email us and we will set up a larger plan." Pro gains the priority queue once P20-35's P2 part ships.
7. **Making another version of a scene.** Default: charged at the shot's seed price, and only if the new version passes its checks; nothing is charged for a version that fails.
8. **Daily hard stop.** Default: $25 a day until there is revenue, set as an operator setting after P20-37 (the env var until then).

**Credits and terms**

9. **Legal entity and governing law.** Default: the founder supplies the entity, postal address and governing law; counsel reviews terms and privacy before live keys (LAUNCH_CHECKLIST step 1). Rough estimate, not a quote: $500 to $1,500 for a fixed fee review of terms and privacy by a small business lawyer, with about 1 to 2 weeks of lead time, so the founder asks for quotes on day 1 of the phase. Deferred alternative if that does not fit the gate: go live with the founder approved text from P20-23 (the renewal disclosures follow the statutes V-bill section 9 cites) and finish counsel review within 30 days of live keys.
10. **Credit expiry.** Default: credits do not expire while the account is open. Top up `expires_at` is cleared, `rolloverPolicy` is deleted, and PHASE_18's referral reward credits (P18 decision 12, "expire after 12 months like top ups") follow the same rule. Choosing expiry instead needs credit lots (FIFO consumption, expiry ledger rows): an L item for a later phase, and until it ships no copy mentions expiry.

**Operations**

11. **Backups.** Default: nightly encrypted pg_dump to a separate R2 bucket now (about $1 a month). Supabase Pro ($25 a month, 7 days of daily backups, V-data section 1) is a separate founder decision, never an automatic trigger: the weekly report (P20-38) flags the first paying customer and a database past 300 MB as the points to decide. Free alternative: stay on Free with the nightly pg_dump as the only backup. If Pro is chosen, keep pg_dump as the off platform copy, and keep staging in a separate free organization (P20-54). No PITR (about $100 a month plus a Small compute add-on).
12. **Backup retention.** Default: daily copies 35 days, monthly copies 180 days, with the newest 7 days of daily copies locked against deletion (R2 bucket lock). Privacy copy states the longest window (P20-23).
13. **Error tracking.** Default: Sentry Developer, free (5k errors a month, one user, email alerts, 30 day lookback; V-ops section 1).
14. **Monitors.** Default: UptimeRobot Free (keyword monitors, 5 minute checks, commercial use allowed in its terms) plus healthchecks.io Hobbyist (20 checks; its FAQ allows company infrastructure). Optional: the $5 a month healthchecks.io Supporter plan, which V-ops section 2 suggests "to remove doubt" because the plan page says "free for hobby use". Better Stack only if the founder confirms its free plan allows a commercial keyword monitor.
15. **Rate limit store.** Default: Upstash Redis Free in AWS `us-west-2` (Oregon), with the limiter failing open when Upstash errors (it already does, lib/rate-limit.ts lines 150 to 167).
16. **Staging.** Default: a free stack with its own Supabase project in a separate free organization (needed for Turnstile's test keys, V-ops section 6, and so a Pro move under decision 11 never bills it), an R2 bucket and a free Render web service (verify the free instance type, rule 7). It is never a restore target (P20-11).
17. **Deploys.** Default: auto deploy off on production; releases go through `pnpm release` (P20-19).
18. **Canaries.** Default: one metered fixture cutout on the primary fal key every 6 hours and on the backup key once a day, plus an R2 round trip; about $1.50 a month.
19. **Daily synthetic production pack.** Default: yes, one main image only pack a day from an operator workspace excluded from every metric (about $0.02 a day).
20. **Automatic restarts of a pack.** Default: at most 1 per job (P18-23's `deployRestarts.max`), only while the job is under 60 minutes old, and only for packs a deploy drain interrupted or that never started. A pack orphaned while running by a crash (an out of memory kill or a hard stop, found by P20-32) is settled as failed and its hold released, because the same pack could crash the shared instance again.
21. **Retention windows.** Default: as in P20-39 and P20-40 (events 180 days with billing and funnel rows kept longer, the operator audit trail 400 days, job steps of finished jobs 180 days, temporary R2 objects 7 days).

**Trust, sign in and teams**

22. **Operator second factor.** Default: required for every /app/ops page and action, read from verified claims (P20-49). Only the first enrollment page works without it.
23. **Gallery.** Default: every gallery submission waits for operator approval before anyone sees it (P20-50).
24. **Support reply time.** Default: two business days; `SUPPORT_INBOX` is hello@curvi.ai (PHASE_19 decision 10 uses the same address).
25. **`reports/` and `research_notes/` in the public repo.** Default: keep both untracked and add them to .gitignore. They hold strategy and pricing analysis, not code; the plans cite them by path for the founder's local copy.
26. **Turnstile.** Default: on for sign up, password sign in, password reset and resend (through Supabase Auth CAPTCHA), and on PHASE_18's anonymous endpoints that spend money. This changes PHASE_18 decision 7 ("only if abuse shows") for those paths. Turn it on in Supabase only after PHASE_19's review closes, and check the reviewer login in a private window first. Without `TURNSTILE_SECRET_KEY` in production the spend endpoints run under stricter fallback limits, and with the site key set but no secret they refuse (P20-29).
27. **Team size and billing roles.** Default: up to 10 members per workspace counting open invites, no paid seats; accepting an invite requires signing in with the invited, confirmed email. Billing (checkout, the portal, the cancel flow and invoices) is for owners and admins only; editors and clients cannot change it. This narrows today's `canManageBilling` (apps/web/src/lib/billing/access.ts, every role but client) and is fixed in P20-59's P1 part, before any member can be added by invite.
28. **Status page.** Default: self hosted at /status.
29. **CLAUDE.md and PENDING stack lines.** Default: the founder approves removing Trigger.dev from the CLAUDE.md stack and commands lines (P20-18) and recording Resend over Loops (PHASE_18 decision 3). Agents never edit CLAUDE.md without that approval.

**Batch 5**

30. **Listing text.** Default: free and on by default (about $0.002 a pack).
31. **Customer two step sign in.** Default: optional for everyone; never required, so the PHASE_19 reviewer account stays without it.
32. **Several products at once.** Default: up to 10 products per batch, one running pack per workspace while others wait.

## Principles (apply to every item)

1. **Money first.** No live key before the Release 2 gate. Spending and billing fail closed; monitoring fails open and never breaks a request or a pack.
2. **Rule 2.** Thresholds, windows, budgets, prices, retention days, spend caps, breaker timings, reconcile windows, the disposable domain list and economics floors live in the seed and are injected, never kept as code literals; copy that states one of these numbers renders it from the seed. Values the founder sets at runtime live in `platform_settings` under an `ops:` prefix; the seed never writes an `ops:` row, and the default each one falls back to is the seed constant `opsSwitchDefaults` (P20-20). Read them through the 30 second cached reader pattern of apps/web/src/lib/features.ts (`OUTPUT_OPTIONS_SWITCH_CACHE_MS`, line 38).
3. **Rule 3.** New image paths (Regenerate, Adjust, batches, the canary) place the real cutout with the existing renderers and pass `fidelityReport` on the final bytes. A rule 3 test ships with each.
4. **Rule 4.** Canaries and probes go through packages/ai (caps, meter, breaker; the canary's one trial call skips the open breaker check for the provider under test only, P20-16). Stripe, Resend, Sentry and R2 are not AI providers and keep their existing SDK or fetch paths.
5. **Rule 5.** New tenant tables carry `workspace_id`, RLS and a test in packages/db/src. New platform tables have RLS on, no client policies, privileges revoked from anon and authenticated (the 0010 and 0027 pattern), and a test that client roles cannot read or write them. Every new table also gets PHASE_19's restrictive `no_oauth_clients` policy in its own migration.
6. **Rule 7.** Every row in "External facts" is dated in docs/verification.md before code uses it.
7. **Rule 8.** New variables go into render.yaml (P20-21) and docs/LAUNCH_CHECKLIST.md with what happens when unset; the founder adds them to `.env.example` by hand, because env files are blocked for agents.
8. **Rule 9.** Every user facing string (UI, email, page, API message, alert copy shown to sellers) is plain spoken with no emojis, no arrows and no dashes used as punctuation, and new copy modules get a lint test like apps/web/src/components/marketing/claims.test.ts. Copy goes through `unqualifiedClaims()` and never sells a feature whose flag is `coming_soon`.
9. **Operator actions.** Every ops mutation re-checks `isOperator` (and the second factor once P20-49 ships) on the server and writes an `ops_audit` row with the operator, the action, its target and any force flag. `ops_audit` is a platform table (migration `ops_switches_and_audit`, Release 2): RLS on, no client policies, privileges revoked from anon and authenticated, `no_oauth_clients`, and no foreign key that cascades, so deleting a workspace never deletes its audit trail. It is not the `events` table, which any workspace member can insert into (0002 `events_insert_member`) and which cascades on workspace delete.
10. **Migrations take the next free number at build time.** They are named here, never numbered, one named migration per lane. 0027 is `site_visits`; PHASE_18 adds up to nine named migrations and PHASE_19 one. A lane runs `pnpm db:generate` only after rebasing on the newest main; if another migration lands first it renumbers and regenerates the Drizzle journal and snapshot. Production applies them in numeric order, after a fresh backup (manual pg_dump until P20-12, then `pnpm ops:migrate`).
11. **Demo backends.** Every new service gets a demo implementation so `pnpm e2e` keeps running with no accounts.

## External facts and the docs/verification.md rows to add (rule 7)

Each row below was read on 2026-10-01 in the named note. The build re-reads the page on the day it relies on it and adds one dated row to docs/verification.md under a new heading "PHASE_20 (checked <date>)". UNVERIFIED items are settled by the test named in the item.

| Row | What it records | Note | Items |
| --- | --- | --- | --- |
| Sentry Next.js setup | `@sentry/nextjs` 11.2.0, peer `next` 14, 15 or 16 (installed Next 15.5.26); `instrumentation.ts` with `register()` and `export const onRequestError = Sentry.captureRequestError` (SDK 8.28.0 or later and Next 15); `instrumentation-client.ts`; `app/global-error.tsx`; `withSentryConfig` options `org`, `project`, `authToken`, `widenClientFileUpload`, `tunnelRoute` (a fixed string, excluded from the middleware matcher); source maps upload only on `next build`, client maps deleted after upload by default; `captureConsoleIntegration({ levels, handled })` in the Node and edge runtimes. UNVERIFIED: a build without `SENTRY_AUTH_TOKEN`, the `sendDefaultPii` default, behavior past the quota. | V-ops 1 | P20-13, P20-14 |
| Sentry Developer plan | Free; 5k errors, 1 user, email alerts, 30 day lookback, 1 cron and 1 uptime monitor. Team $26 a month for 50k errors. | V-ops 1 | P20-13, decision 13 |
| healthchecks.io | Hobbyist $0 for 20 checks and 100 log entries each; more than 5 pings a minute to one check may be rate limited; a wrong id answers 200; a Hobbyist account may monitor company infrastructure (FAQ). | V-ops 2 | P20-17, P20-10, P20-38 |
| UptimeRobot Free | 50 monitors, 5 minute interval, keyword monitors, commercial use allowed (terms, Fair Use Policy of 2026-05-26). UNVERIFIED: keyword matching on a JSON body; heartbeat monitors on Free. | V-ops 3 | P20-17 |
| Better Stack Free | 10 monitors and heartbeats, 3 minute checks; "Free for personal projects"; keyword checks listed only as paid. Recorded as the alternative not taken. | V-ops 3 | decision 14 |
| Upstash Redis Free | 1 database, 256 MB, 500K commands a month, 10 GB bandwidth; commands over the limit return errors; free databases archived after at least 30 days of inactivity; AWS `us-west-2` offered. UNVERIFIED: EVAL billing. | V-ops 4 | P20-51 |
| GitHub security for a public user owned repo | Code scanning, CodeQL, secret scanning and push protection free for public repos; Dependabot and private vulnerability reporting on all plans; Actions free for public repos; live state 2026-10-01 (secret scanning and push protection on; Dependabot, CodeQL default setup and private reporting off; no dependabot.yml). gitleaks-action v3.0.0 needs no license for personal accounts and is under an EULA that forbids modification; the gitleaks CLI is MIT. | V-ops 5 | P20-52 |
| Cloudflare Turnstile | Free plan: unlimited challenges, 20 widgets, 10 hostnames each; siteverify `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response`, `remoteip`, `idempotency_key`; to add before P20-29 relies on them: the response fields `success`, `hostname`, `action` and `error-codes`, and the `timeout-or-duplicate` code; tokens single use, 300 seconds, up to 2048 characters; test keys `1x00000000000000000000AA` and `1x0000000000000000000000000000000AA`; automated browsers are detected as bots; CSP needs `https://challenges.cloudflare.com` in `script-src` and `frame-src`. | V-ops 6 | P20-29, P20-53 |
| fal account billing | `GET https://api.fal.ai/v1/account/billing?expand=credits` with an Admin scope key returns `credits.current_balance`; new accounts start at 2 concurrent requests; purchased credits expire after 365 days; requests fail below an undocumented lock threshold. UNVERIFIED: auto top up. P18-03 records the endpoint row; this phase adds the concurrency and expiry facts. | V-ops 7 | P20-16, Do before 5 |
| Supabase backups and plan limits | No automatic backups on Free; Pro $25 with 7 days of daily backups; PITR $0.137 an hour for 7 days and needs a Small compute add-on; Free pauses after 1 week of inactivity and goes read only past 500 MB of database (SQLSTATE 25006). UNVERIFIED: what counts as inactivity. | V-data 1 | P20-10, P20-15, P20-54, decision 11 |
| Connecting pg_dump to Supabase | Direct host IPv6 only on Free; the session pooler (`postgres.[REF]` user, port 5432) is IPv4 on every plan and is the backup guide's default; pg_dump refuses newer server majors; Render native runtimes ship `postgresql-client` up to 14, so the cron runs on Docker. UNVERIFIED: Curvi's server version (`SHOW server_version;`). | V-data 2 | P20-10, P20-11, P20-12 |
| Supabase Auth CAPTCHA | Providers `hcaptcha` and `turnstile`; enforced on `/signup`, `/token` (password and web3 grants), `/recover`, `/otp`, `/magiclink`, `/resend`, SSO and passkey options; skipped for pkce, refresh_token and id_token grants, admin keys, `/verify` and MFA; `options.captchaToken` on signUp, signInWithPassword, signInWithOtp, resend; `resetPasswordForEmail(email, { captchaToken })`. | V-data 3 | P20-28, P20-29 |
| Supabase TOTP | Free and on by default; `mfa.enroll({ factorType: "totp" })`, `challenge`, `verify`, `getAuthenticatorAssuranceLevel()` with `aal1` and `aal2`; an RLS check that the JWT's `aal` claim equals `aal2`; recovery codes experimental behind a client flag. To add before P20-49: server code reads `aal` from verified claims (`getClaims()` or `getUser()`, the SSR guidance in V-data section 5), because `getAuthenticatorAssuranceLevel()` decodes the session without verifying it. | V-data 4 | P20-49, P20-63 |
| Supabase email links | `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next={{ .RedirectTo }}` with `verifyOtp({ type, token_hash })`; `type=recovery` for resets; `signup` and `magiclink` types deprecated; secure email change on by default, both addresses get the Change email template with `type=email_change` and their own TokenHash; link scanners can use up tokens. To add before P20-28: how `{{ .RedirectTo }}` is encoded inside the link, since `emailRedirectTo` is itself `/auth/callback?next=...`. | V-data 5 | P20-28, P20-31 |
| Render cron jobs | Billed per second, $1 a month minimum per cron service; UTC schedules; runs never overlap; a run stops after 12 hours; Docker crons run the image CMD or `dockerCommand`; Blueprint `type: cron` with `schedule`, `runtime: docker`, `dockerfilePath`; `POST /cron-jobs/{id}/runs` triggers a run and cancels any active run (so P20-12's `--backup-now` refuses while a backup is running). UNVERIFIED: minimum interval. | V-data 6 | P20-10, P20-12, P20-21, P20-38 |
| Render deploy and rollback API | `POST /v1/services/{id}/deploys` with `commitId`; `POST /v1/services/{id}/rollback` with `deployId`; neither disables auto deploy; `autoDeployTrigger` is `commit`, `checksPass` or `off`; `checksPass` never deploys a commit with zero checks. | V-data 7 | P20-19 |
| Render request id | `Rndr-Id` reaches the service and the client; documented beside HTTP request logs (Pro workspaces). UNVERIFIED on Hobby. | V-data 8 | P20-57 |
| Render shutdown | SIGTERM 60 seconds after traffic moves, then SIGKILL after `maxShutdownDelaySeconds` (1 to 300, default 30). | V-data 9 | P20-19, Do before 3 |
| Render Blueprint adoption | Add the existing service with every current setting; env values the Blueprint does not overwrite are kept; Auto Sync can be off; omitted fields fall back to defaults; a new Blueprint that matches existing resources may create copies with a suffix. UNVERIFIED: how the creation flow matches an existing service. To add before P20-21: Blueprint `envVarGroups` and `fromGroup`, and per service `envVars`. | V-data 10 | P20-21 |
| Supabase transaction pooler (Supavisor) | The app connects through the transaction mode pooler (apps/web/src/lib/services/db.ts line 182), which lends a server connection only for one transaction. To add before P20-38: that session level features (`pg_try_advisory_lock`, `SET`, `LISTEN`) are not safe through it, which is why the tick uses a lease row. | new read | P20-38 |
| R2 lifecycle, locks and pricing | Lifecycle filters by literal prefix only (no tagging); deletion usually within 24 hours of expiry; default multipart abort after 7 days; bucket locks by age, date or forever, which override lifecycle and block emptying a bucket; free tier 10 GB-month, 1M Class A, 10M Class B, Standard storage only; deletes free. | V-data 11 to 13 | P20-10, P20-40 |
| Stripe events and endpoints | `events.list` with `type` or `types` (up to 20), `created` gt, gte, lt, lte, `delivery_success`, `limit` 1 to 100, 30 days back; webhook endpoint fields (`url`, `enabled_events`, `status`, `api_version`) and `secret` only at creation. | V-bill 1, 2 | P20-02 |
| Stripe subscription schedules | Two calls (`from_subscription`, then an update with the current phase and a second phase), per phase `proration_behavior: "none"`, up to 10 phases, release, the portal cannot update or cancel a subscription with a schedule attached, `subscription_schedule.expiring` 7 days before; with a schedule attached, changes go through the Schedule API rather than the Subscriptions API. UNVERIFIED: annual downgrade phases; default `end_behavior`. To add before P20-06's P1 part: the `billing_reason` of the invoice at a phase transition (the renewal grant keys on it). | V-bill 3 | P20-06, P20-07 |
| Stripe portal configurations | Per configuration `features.subscription_update.products` (up to 10), `schedule_at_period_end.conditions`; a session takes `configuration`; `subscription_update_confirm` prices must be in that configuration; the portal defers only same product downgrades. | V-bill 4 | P20-06 |
| Stripe Tax pricing | Basic no code 0.5 percent per transaction where registered; API 50 cents; Complete from $90 a month on a 1 year contract. | V-bill 5 | P20-07, decision 3 |
| Stripe renewal reminder emails | Only `charge_automatically`; one account wide day setting shared with `invoice.upcoming`; content undocumented. | V-bill 6 | decision 4 |
| Stripe webhook test headers | `generateTestHeaderString({ payload, secret, timestamp? })` returns `t=<seconds>,v1=<hmac>`; `constructEvent` tolerance 300 seconds; the timestamp is in seconds (the type comment is wrong). | V-bill 7 | P20-03 |
| Stripe Checkout custom text | `custom_text.submit.message` and `custom_text.terms_of_service_acceptance.message` (up to 1200 characters each) with `consent_collection.terms_of_service = "required"`. To add before P20-07: the completed session's `consent.terms_of_service` field and its `accepted` value, and that session `metadata` set at creation comes back on `checkout.session.completed`. | V-bill 9 (inferences) | P20-07 |
| US subscription rules | FTC rule status (vacated, 1973 rule recodified 2026-02-12, new ANPRM 2026-03-13); ROSCA 15 U.S.C. 8403; California BPC 17600 to 17606 (AB 2863); Minnesota 325G.56 to 325G.62; Virginia 59.1-207.45 and 207.46 (small businesses are consumers); New York GBL 527-a (UNVERIFIED wording). Not legal advice; counsel confirms. | V-bill 8, 9 | P20-07, decision 4 |
| CAN-SPAM transactional mail | 16 CFR 316.3(c): activation, invoices, renewal and price change notices are transactional; no unsubscribe needed; no misleading routing; a promotional subject makes them commercial. | V-bill 10 | P20-07 |

Facts not covered by the notes, to read before the item that needs them: Render's free web service instance (P20-54); the disposable-email-domains list, its license (CC0) and the commit used (P20-30); `@axe-core/playwright` current version (P20-44); Stripe `invoices.list` fields `hosted_invoice_url` and `invoice_pdf` (P20-09); Supabase `auth.resend` parameters and the error code list (`invalid_credentials`, `user_already_exists`, `over_email_send_rate_limit`) (P20-28); the Supabase auth tables a restore needs (P20-10); whether the Supabase CLI's local stack runs the same Auth migrations as the hosted project, so a data only restore of the auth tables loads (P20-11); that a PUT of an R2 bucket's lifecycle configuration replaces every existing rule (P20-40); Cloudflare Transform Rules that add a request header, and whether curvi.ai traffic is proxied at all (P20-51); Stripe's US card fee for the economics seed (P20-04); each marketplace upload walkthrough (P20-26); whether Next.js keeps `after()` work alive through the whole shutdown grace (P20-19); the Resend rule for sending without a verified domain (P20-17).

## Starting point (verified in the code on main ccbd555 and the 2026-10-01 working tree)

| Area | Today | Where |
| --- | --- | --- |
| Checkout gate | `isStripeConfigured()` returns `Boolean(STRIPE_SECRET_KEY)`. Nine selling call sites read it: app/app/page.tsx line 53, app/app/new/page.tsx line 45, app/app/billing/page.tsx line 78, (marketing)/page.tsx line 299, (marketing)/pricing/page.tsx line 36, components/marketing/help-articles.ts line 129, lib/llms.ts line 103, lib/seo.ts line 300, api/billing/checkout/route.ts line 91. Others use it as "an API key exists": api/billing/portal/route.ts line 37, api/webhooks/stripe/route.ts line 41, lib/trust/account.ts line 182, lib/billing/cancel-store.ts line 79, lib/health.ts line 79. | apps/web/src/lib/env.ts line 24 |
| Webhook | 503 `stripe_not_configured` without `STRIPE_WEBHOOK_SECRET`; 13 handled event types. API version pinned to `2025-08-27.basil`. | api/webhooks/stripe/route.ts lines 48 to 57; lib/billing/stripe-webhook.ts line 488; lib/billing/stripe.ts line 12 |
| Credit expiry | Top ups write `expires_at` (`expiresMonths * 30 days`), nothing reads it; seed `topUps` 12 months, `rolloverPolicy` unused; billing page says "Stays usable for {topUpMonths()} months"; pricing says unused credits stay; terms point to "the rollover policy shown on the pricing page" and call fees non refundable. | lib/billing/db-store.ts line 160; packages/pipeline/src/seed/credits.ts lines 329 to 342; lib/marketing-facts.ts lines 99 to 111; app/app/billing/page.tsx line 205; (marketing)/terms/page.tsx lines 37 and 38 |
| Plan cards | Every Growth, Pro and Agency line is coming soon; API access is a live Growth entitlement the cards do not list. | lib/billing/plan-features.ts lines 47 to 65 |
| Downgrades | A tier downgrade in the portal applies at once and takes the credit difference back in full, below zero. The cancel flow's "smaller plan" save offer changes the price at once with `proration_behavior: "none"`. | docs/STRIPE_SETUP.md section 5; lib/billing/cancel-flow.ts lines 200 to 210 |
| Checkout consent | `consent_collection.terms_of_service: "required"` with "I agree to the Terms of Service"; no renewal text; tax only when `STRIPE_TAX_ENABLED`. | lib/billing/checkout.ts lines 72 to 77, 99 to 104 |
| Subscriptions row | Columns `tier`, `status`, `period_end`, `cancel_at_period_end`; no cadence column (the cancel flow reads the cadence from Stripe). | packages/db/src/schema.ts lines 560 to 575 |
| Billing roles | `canManageBilling` allows every role but client, so editors can buy, open the portal and cancel. | lib/billing/access.ts lines 2 to 9; api/billing/checkout/route.ts line 75; api/billing/portal/route.ts line 34 |
| Cancel flow | Continue is disabled until a reason is picked; the offers step shows "No thanks, continue to cancel", not a cancel button; cancel sets `cancel_at_period_end` through the Subscriptions API. | components/app/cancel-flow.tsx lines 183, 204 to 218, 234; lib/billing/cancel-service.ts line 314 |
| Ledger locking | `reserve_credits` takes `FOR UPDATE` on the workspace row; the ledger tests run on single connection PGlite only. | packages/db/migrations/0012_signup_grant_on_confirm.sql line 72; packages/db/src/ledger.test.ts |
| Email confirmation | /auth/callback only exchanges a PKCE code; the signup notice says "Open it on this device"; the error copy says "request a new link" with no control for it; raw Supabase error text reaches the form. | app/auth/callback/route.ts; lib/safe-next.ts lines 158 and 201; lib/auth-call.ts line 44 |
| Workspace of a session | `members.findFirst` with no ordering. | lib/services/db.ts line 542 |
| Members and integrations | Members shown as "Member {8 characters of the user id}"; invites by emailing hello@; Shopify "Connect a store" with no button. | lib/services/db.ts lines 2991, 3009 and 3010; app/app/settings/page.tsx line 79 |
| Redo a delivered image | Retry is refused unless the shot waits for review; follow up reasons are `retry` and `add_angle`. | lib/services/db.ts line 1222; trigger/src/follow-up.ts line 52 |
| Library | At most 120 images per load. | lib/library.ts line 51 |
| Retention copy | Privacy says uploads stay while the account is active; the purge deletes unused source media after 30 days. | (marketing)/privacy/page.tsx lines 45 to 48; lib/trust/purge.ts line 31 |
| App shell | Nine nav links in a `flex-wrap` row; the "ahead" stage is `text-ink-300` at 11 px; `app/error.tsx` shows no reference and reports nothing; no `not-found.tsx`, no `global-error.tsx`, no `instrumentation.ts`. The only four `text-[10px]` captions are on the public marketing gallery page, not in the app shell. | components/app/app-nav.tsx lines 8 to 23; components/app/job-progress-board.tsx lines 80 to 83; app/error.tsx; (marketing)/gallery/page.tsx lines 31, 38, 111 and 117 |
| Support | hello@curvi.ai appears 25 times in 16 files; no form; no Help link in the app nav. Many of the 25 cannot become links: the JSON-LD email (lib/seo.ts line 240), API JSON notices (api/billing/checkout/route.ts lines 112 and 127, api/billing/portal/route.ts line 41, lib/billing/cancel-service.ts line 299), the account deletion refusal (lib/trust/account.ts line 63), and the privacy, terms, help and footer mailto links. | grep of apps/web/src |
| Health | `ok` comes from the database, schema and drain only; warnings are added after and never change it; fal is listed as skipped by the probe route. | lib/service-health.ts lines 260 and 270 to 278; trigger/src/provider-probes.ts line 163 |
| Founder alerts | One email path, `sendFounderEmail`; quota emails only for the OpenAI LLM family, plus the daily spend alerts (P18-03 adds cutout and image providers). | trigger/src/spend-alerts.ts line 248; packages/pipeline/src/seed/monitoring.ts line 55 |
| Breaker | In memory per process, no half open; a quota answer opens it for 30 minutes; preflight rebuilds cutout quota trips from `events` on every check, so neither a restart nor a top up clears a cutout quota pause before 30 minutes pass from the last quota answer. | packages/ai/src/breaker.ts lines 8, 27 and 146; lib/provider-preflight.ts lines 152 to 180 and 226 to 231 |
| Spend caps | `$50` alert and `$150` daily stop as literals in packages/ai; the stop is changed only by an env var and a restart; the router supports `workspace_day` but callers pass only `image_asset`, `pack` and `global_day`. | packages/ai/src/caps.ts lines 17 to 25; trigger/src/runtime.ts line 406; trigger/src/live-runtime.ts lines 1035 to 1037 and 1210 to 1211; trigger/src/pipeline-runner.ts lines 310 and 311 |
| Runner | FIFO, default concurrency 1, 25 minute cap, 20 second default grace (max 290 seconds); the stale sweep window is 30 minutes and 200 jobs; COGS is kept with `greatest()`, so a second run that reports from zero hides the first run's spend. | lib/jobs/inline-runner.ts lines 132 to 142 and 334; lib/services/reconcile.ts lines 27 and 80; trigger/src/db-store.ts line 141 |
| Trigger.dev | `TRIGGER_SECRET_KEY` routes packs to the dead v3 cloud; scheduled tasks import `@trigger.dev/sdk/v3`; the digest reads `DemoMetricsReader`. | lib/jobs/enqueue.ts lines 41 to 47 and 66 to 72; trigger/src/tasks/*; trigger/src/tasks/metrics-digest.ts line 36; apps/web/package.json line 29; trigger/package.json lines 27, 28, 44, 50; root package.json line 20 |
| Crons | Two dashboard cron services (stale-jobs every 10 to 15 minutes, purge-source-media daily); `CRON_JOBS` lists those two. | lib/cron-health.ts lines 14 to 17; docs/LAUNCH_CHECKLIST.md lines 330 to 342, 390 |
| Switches | The seed upserts every platform setting, so `output_options_enabled` is reset by each re-seed. | trigger/src/platform-settings.ts lines 22 to 28; packages/pipeline/src/seed/credits.ts lines 361 to 366 |
| R2 keys | Every key starts with `ws/{id}/`, so a lifecycle rule cannot target temporary objects: cutout cache, preflight preview, carousel layer, run handoff. | trigger/src/cutout-cache.ts line 45; lib/preflight/service.ts line 62; trigger/src/live-runtime.ts line 1930; trigger/src/pipeline-runner.ts line 909 |
| render.yaml (working tree) | Plan `1c-2g`, `maxShutdownDelaySeconds` 300, `autoDeployTrigger: checksPass`; lists `TRIGGER_SECRET_KEY` (line 128) and `SENTRY_DSN` (line 140, unused); no crons, `CRON_SECRET`, `OPS_EMAILS`, `FAL_KEY_BACKUP`, `NEXT_PUBLIC_OUTPUT_OPTIONS`, `CURVI_SHOT_CONCURRENCY`, `NODE_OPTIONS`, `DAILY_SPEND_HARD_STOP_USD`, `OPENAI_ADS_CONVERSIONS_KEY` (lib/ads-conversions.ts line 42), `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID` (lib/consent.ts), `NEXT_PUBLIC_POSTHOG_HOST` (next.config.ts, components/analytics.tsx), `SHOPIFY_API_SECRET` (lib/health.ts line 80, the Shopify webhook), `CURVI_ALLOW_DEMO_GENERATION` (trigger/src/runtime.ts), `CURVI_TEMPLATE_FONT_FILE` (packages/pipeline/src/templates/font.ts); `METRICS_DIGEST_FROM` is read only by the Trigger.dev task P20-18 deletes. A test checks only the batch 1 variables. | render.yaml lines 18, 36, 41, 128, 140; apps/web/src/lib/jobs/deploy-config.test.ts |
| CI | Lint, typecheck, unit tests, then e2e on the demo build; no audit, scanning or Dependabot config. | .github/workflows/ci.yml |
| Rate limits and IP | Upstash when its variables are set, else per process; when Upstash throws, `FallbackRateLimitStore` already falls back to the in process counter; `clientIp()` trusts `cf-connecting-ip`, `true-client-ip`, `x-real-ip`, then the first `x-forwarded-for` entry, which a client can forge (docs/verification.md "Still unverified" item 2). | lib/rate-limit.ts lines 150 to 167, 175 to 189 and 267 to 274 |
| CSP | Report only, with `'unsafe-inline'` in `script-src`. | apps/web/next.config.ts lines 54 and 100 |
| Gallery | Anonymous visitors read rows with `published` true; no approval step. The public gallery and share pages read over the owner connection, which bypasses RLS: `loadGallery` filters `published` and `is_public` only, opting in sets `published: true` at once, and `inGallery` drives the share page's noindex. | packages/db/src/schema.ts line 640; migration 0002 line 116; apps/web/src/lib/shares/db-store.ts lines 2 to 4, 174, 256 and 431 |
| Operator gate | `isOperator` over `OPS_EMAILS` (or `OPS_EMAIL`) and /app/ops/visitors on `site-visitors`; not on main. | `site-visitors` apps/web/src/lib/ops.ts |
| Migrations | Latest on main 0026; `0027_site_visits` on `site-visitors`; PHASE_18 and PHASE_19 add more by name. | packages/db/migrations |
| Repo | Public, user owned. Root images now ignored by an uncommitted .gitignore change; four personal images sit untracked in the root. | .gitignore (working tree) |
| Scripts | No root `scripts/` folder. The root tsconfig type checks only `e2e/**` and playwright.config.ts; apps/web's tsconfig includes `**/*.ts` and resolves `@/`. Package scripts run TypeScript with `tsx` and the root aliases them through `pnpm --filter` (for example `db:seed`). So this phase's scripts live in `apps/web/scripts/` as `@curvi/web` package scripts, with root aliases. | tsconfig.json; apps/web/tsconfig.json; package.json lines 8 to 21; trigger/package.json line 29 |

## Ranked items

Effort, for one agent (PHASE_19's scale): XS under 2 hours, S about half a day, M 1 to 2 days, L 3 to 5 days, including tests. PHASE_18 sizes the same agents on a scale about four times larger (its S is up to 2 builder days, M 3 to 5, PHASE_18.md line 182), so a PHASE_18 S is about an M here; convert before comparing sizes across the two phases. Running cost is cash per month at today's near zero volume, beyond today's hosting.

| ID | Title | Workstream | Priority | Effort | Running cost |
| --- | --- | --- | --- | --- | --- |
| P20-01 | Checkout opens only when Stripe can grant credits | W1 | P0 | S | $0 |
| P20-02 | Billing reconciler and webhook endpoint check | W1 | P0 | M | $0 |
| P20-03 | Billing test harness | W1 | P0 | M | CI minutes |
| P20-04 | Unit economics report and the price before live keys | W1 | P0 | S plus a decision | $5 to $20 once if the golden set runs live |
| P20-05 | One credit terms sentence, no expiry | W1 | P0 | S | $0 |
| P20-06 | Downgrades take effect at the end of the period | W1 | P0 stopgap, P1 schedule | S (P0), M (P1) | $0 |
| P20-07 | Renewal terms, notices and a cancel flow that meet state rules | W1 | P0 terms and cancel flow, P1 notices | L (P0), M (P1) | Stripe Tax 0.5 percent where registered |
| P20-08 | Plan cards list only what runs; Agency off self serve | W1 | P0 | S | $0 |
| P20-09 | Credit history and invoices in the app | W1 | P1 | M | $0 |
| P20-66 | Operator credit grant with an audit row | W1 | P0 | S | $0 |
| P20-10 | Nightly encrypted database backup to R2 | W2 | P0 | M | about $1 a month |
| P20-11 | Restore drill | W2 | P0 | S | $0 |
| P20-12 | A migrate script that refuses without a fresh backup | W2 | P1 | S | $0 |
| P20-13 | Sentry for the server and the inline runner | W2 | P0 | M | $0 |
| P20-14 | Error and 404 pages | W2 | P1 | S | $0 |
| P20-15 | Health status: ok, degraded, down | W2 | P0 | S | $0 |
| P20-16 | Provider alerts PHASE_18 leaves out, and canaries | W2 | P1 | M | about $1.50 a month |
| P20-17 | External monitors and the alerts runbook | W2 | P0 | XS | $0 |
| P20-18 | Remove the dead Trigger.dev v3 path | W2 | P1 | S | $0 |
| P20-19 | Deploy safety: grace, release script, pause switch, rollback | W2 | P1 | L | $0 |
| P20-20 | Operator switches the seed never resets | W2 | P0 | S | $0 |
| P20-21 | render.yaml lists every variable and every cron | W2 | P1 | S | $0 |
| P20-22 | Model retirement and traffic split checks | W2 | P1 | S | $0 |
| P20-23 | Legal facts in one module: terms, privacy retention, subprocessors | W3 | P0 | S plus founder and counsel | counsel fees once (decision 9 estimate) |
| P20-24 | Contact form on /support and Help inside the app | W3 | P1 | M | $0 |
| P20-25 | "Not yet" pack feedback reaches the founder | W3 | P1 | XS | $0 |
| P20-26 | Help center: a page per article and 12 new articles | W3 | P1 | M | $0 |
| P20-27 | Status page and changelog | W3 | P1 | S | $0 |
| P20-28 | Email confirmation on any device, a resend button, plain errors | W4 | P1 | M | $0 |
| P20-29 | Turnstile on sign in and on anonymous endpoints that spend | W4 | P1 | S to M | $0 |
| P20-30 | No free credits for temporary inboxes | W4 | P1 | S | $0 |
| P20-31 | Change email | W4 | P1 | S | $0 |
| P20-32 | Fast orphan recovery after a crash | W5 | P1 | M | $0 |
| P20-33 | A requeue that survives a crash and counts cost once | W5 | P1 | M | re-run compute only |
| P20-34 | Memory test, start guard and heap cap | W5 | P1 | S to M | $0 |
| P20-35 | Queue position, wait estimate, priority and fairness | W5 | P1 position and estimate, P2 priority and fairness (triggered) | S (P1), M (P2) | $0 |
| P20-36 | Shared breaker in Postgres with half open | W5 | P2 (triggered) | M | $0 |
| P20-37 | Hard stop as an operator setting, and the workspace day cap | W5 | P1 | S to M | $0 |
| P20-38 | One tick cron and a real weekly report | W5 | P1 | M | $0 net (replaces two crons) |
| P20-39 | Table retention | W5 | P1 | M | $0 |
| P20-40 | Temporary R2 objects under tmp/ with a lifecycle rule | W5 | P1 | M | lowers storage |
| P20-41 | Make another version of a delivered scene | W6 | P1 | M | paid by credits |
| P20-42 | Pack fixes customers can see (a to e) | W6 | P1 | M | small eval spend |
| P20-43 | Products page and library paging | W6 | P2 (triggered) | M | $0 |
| P20-44 | Mobile app menu and accessibility | W6 | P1 | M | $0 |
| P20-45 | Ops overview and switches | W7 | P1 | M | $0 |
| P20-46 | Jobs list and timeline | W7 | P1 | M | $0 |
| P20-47 | Ops alert engine | W7 | P1 | M | $0 |
| P20-48 | Economics page | W7 | P2 (triggered) | S | $0 |
| P20-49 | Operator second factor and audit rows | W7 | P1 | S | $0 |
| P20-50 | Gallery approval queue | W7 | P1 | S | $0 |
| P20-51 | Shared rate limits on Upstash and a trusted client IP | W8 | P1 | XS to S | $0 |
| P20-52 | Security checks in CI | W8 | P1 | S | $0 |
| P20-53 | Enforced CSP (nonces on /app are P2) | W8 | P1 | S (P2 part M) | $0 |
| P20-54 | Free staging stack | W8 | P1 | S plus founder S | $0 |
| P20-55 | Real stack smoke | W8 | P1 | M | about $1.20 a month (two daily packs: staging and decision 19) |
| P20-56 | Disaster recovery runbook | W8 | P1 | S | $0 |
| P20-57 | Structured logs with request and job ids | W8 | P2 (triggered) | M | $0 |
| P20-58 | Docs refresh | W8 | P1 | S | $0 |
| P20-59 | Member emails, billing roles, invites and a workspace switcher | W9 | P1 member emails and roles, P2 invites and switcher (triggered) | S (P1), L (P2) | $0 |
| P20-60 | Same pack for several products, with the new pack form split | B5 | P2 | L | paid by credits |
| P20-61 | Listing text | B5 | P2 | M | about $0.002 a pack |
| P20-62 | Adjust a delivered image | B5 | P2 | M | paid by credits |
| P20-63 | Optional two step sign in for customers | B5 | P2 | M | $0 |
| P20-64 | Shot level checkpoint resume | B5 | P2 | L | $0 |
| P20-65 | Pack fixes f to h | B5 | P2 | M | small eval spend |

Each item below lists the problem, the change by file, schema, seed, copy, tests, acceptance, effort and cost, founder steps, and what it extends; every item has a Tests line and an Acceptance line. "From" names the design pass item it merges.

## W1. Take money safely

### P20-01 Checkout opens only when Stripe can grant credits (P0, S)

From CD P20-01.

- **Problem.** With only `STRIPE_SECRET_KEY` set, every selling surface offers checkout, the webhook answers 503, and the customer pays for credits that never arrive while health stays green.
- **Change.**
  - New `apps/web/src/lib/billing/readiness.ts`: `billingReadiness(readEnv)` returns `{ checkoutOpen, apiKey, problems }`. Problem codes: `stripe_webhook_secret_missing`; `stripe_price_missing` (names from `tierPriceEnvName` and `topUpPriceEnvName`, lib/billing/price-table.ts lines 29 and 33; Agency prices are not required once P20-08 sets it off self serve); `stripe_key_mode_mismatch`, keyed on an explicit environment rather than on https: a test key while `NEXT_PUBLIC_ENV_LABEL` is unset and `NEXT_PUBLIC_SITE_URL` is the production site (https://curvi.ai), a live key on localhost or while `NEXT_PUBLIC_ENV_LABEL` is set (staging, P20-54), or publishable and secret keys in different modes. A test key on staging or on localhost is not a mismatch. `checkoutOpen` needs the secret key, the webhook secret, every self serve price and no mismatch.
  - In env.ts rename `isStripeConfigured` to `hasStripeApiKey` for the five non selling uses, and add `isCheckoutOpen()`; switch the nine selling call sites in "Starting point" to it.
  - The webhook route records `webhook:stripe:last_success` in `platform_settings` on every 2xx (the cron-health pattern); the checkout route records `checkout:last_opened`.
  - config-health warns each readiness problem and `stripe_webhook_quiet` (a checkout opened in the last `billingReconcile.quietWebhookDays` days, seed 7, with no webhook success since). Health readiness lands in two places: `checkoutOpen` joins the stripe entry of the `services` list in the CRON_SECRET protected `/api/health/providers` (it is the only endpoint with that list), and the public `/api/health` shows only the warning codes. The Release 2 gate reads `/api/health/providers`.
- **Copy.** Unchanged ("Card payments are not open yet."). Warnings are founder facing.
- **Tests.** A readiness table over every env combination, including a test key with `NEXT_PUBLIC_ENV_LABEL=staging` (open) and a test key on the production site URL (mismatch); the checkout route answers 503 with a key but no webhook secret; pricing, billing and help render the closed state then; the warnings; the webhook records its success; `/api/health/providers` carries `checkoutOpen`.
- **Acceptance.** With `STRIPE_SECRET_KEY` alone, no surface offers checkout and health shows `stripe_webhook_secret_missing`.
- **Effort and cost.** S. $0.

### P20-02 Billing reconciler and webhook endpoint check (P0, M)

From CD P20-02.

- **Problem.** A wrong endpoint, a missing event type or a delivery that fails past Stripe's retries leaves a payer without credits until someone notices.
- **Change.**
  - New `apps/web/src/lib/billing/reconcile.ts` `reconcileStripe({ stripe, store, priceTable, since })`: `events.list` with `types` set to `HANDLED_STRIPE_EVENTS` (13 today, plus P20-06's schedule events in its P1 part, still under the 20 limit), `created[gte]` `billingReconcile.lookbackHours` back (seed 72), `limit` 100 with paging, at most `billingReconcile.maxEventsPerRun` events (seed 1,000), oldest first. Each event goes through `processStripeEvent` with `DbBillingStore`; grants are keyed on the paying object and serialized by the existing advisory locks, so a replay applies once.
  - **What counts as newly applied.** Only outcomes that moved credits on this run: a grant whose ledger row was written (`duplicate` false), and a debit, clawback or restore with status `applied`. `subscription_synced`, `payment_failure_noted`, `invoice_noted` and `checkout_noted` carry no duplicate flag and never count (stripe-webhook.ts lines 1003 to 1113). Result: applied, already applied, ignored and failed counts.
  - **Replays never move money in Stripe.** The reconciler passes no `StripeBillingActions`, so a replayed `customer.subscription.*` event never runs `retireDuplicateSubscriptions` (refund and cancel, stripe-webhook.ts lines 916 and 954); live duplicate handling stays with the webhook. `?dryRun=1` also passes a read only store that records what it would write and writes nothing.
  - **One bad event never stops the run.** Each event runs in its own try and catch; a failure is recorded (event id, type, error code) and the run continues. An `UnroutableBillingEventError` for a workspace that no longer exists (deleted workspaces cascade their `events` claims, schema.ts line 706) counts as acknowledged, not failed. The founder email lists failures beside the applied count.
  - Endpoint check through `webhookEndpoints.list`: an enabled endpoint at `${siteUrl}/api/webhooks/stripe`, `enabled_events` covering every handled type, `api_version` equal to `STRIPE_API_VERSION`. Otherwise warn `stripe_webhook_endpoint_mismatch`. The signing secret cannot be checked (it is never listed, V-bill section 2); `stripe_webhook_quiet` from P20-01 covers it.
  - Route `apps/web/src/app/api/cron/billing-reconcile/route.ts` (CRON_SECRET, `?dryRun=1` like the purge route), `CRON_JOBS` entry every `billingReconcile.everyMinutes` (seed 30), `recordCronSuccess`. Until the tick exists (P20-38) it joins the existing stale-jobs cron command.
  - When anything was applied or failed, one founder email through `sendFounderEmail`: "Billing check: {n} payments were missing credits. They are granted now." and, when any failed, "{f} billing events could not be applied: {ids}."
- **Seed.** credits.ts `billingReconcile = { lookbackHours: 72, maxEventsPerRun: 1000, everyMinutes: 30, quietWebhookDays: 7 }` (rule 2).
- **Tests.** Two runs apply once; a webhook and a reconcile for the same invoice grant once; a replayed `subscription_synced` or `invoice_noted` counts as nothing and sends no email; a replayed `customer.subscription.created` for a customer with two live subscriptions makes no Stripe call; a dry run writes nothing and calls no Stripe write; one throwing event is recorded and the next event still applies; an event for a deleted workspace is acknowledged; the mismatch warning; paging past 100 events.
- **Acceptance.** In a test database, delete one grant's events row and ledger row; one reconcile restores the grant exactly once and sends one email.
- **Effort and cost.** M. Stripe API calls are free.

### P20-03 Billing test harness (P0, M)

From CD P20-03.

- **Flow tests on PGlite** (`apps/web/src/lib/billing/billing-flow.test.ts`). Real event fixtures captured once in test mode by the founder ("Do before the phase" item 11), ids scrubbed, kept in `lib/billing/fixtures/`, signed with `stripe.webhooks.generateTestHeaderString` (timestamp in seconds) and posted to the route with `DbBillingStore` on `createTestDb`. Cases: monthly and annual start, renewal, a top up paid at once and paid later, an upgrade mid period, an immediate downgrade, partial and full refunds, a dispute won and lost, a duplicate delivery, subscription events out of order, an event that routes to no workspace, and a signature older than 300 seconds (refused). Each asserts the ledger, `workspaces.plan` and the subscriptions row. The scheduled downgrade case belongs to P20-06's P1 part and its own lane.
- **Race tests on real Postgres** (`packages/db/src/ledger-race.pg.test.ts`), run only when `TEST_DATABASE_URL` is set. A CI job adds a Postgres 17 service container and applies the migrations. Cases: 20 parallel `reserve_credits` against a balance that covers 10 (exactly 10 succeed, the balance never goes negative); parallel charges of the same job and step; parallel identical grant deliveries (one ledger row); a reserve racing a refund clawback. The flow suite is the P0 part; the race suite may follow early in Release 3 if it would hold the gate.
- **Founder test mode run.** `apps/web/scripts/billing-verify.ts` (`pnpm billing:verify --workspace <id>`, a root alias for `pnpm --filter @curvi/web billing:verify`, run with `tsx`) prints the plan, the subscription, the ledger by reason and the last 10 billing events, so docs/STRIPE_SETUP.md section 8 is checked by a script. The run happens locally with the Stripe CLI forwarding webhooks to the laptop, because staging does not exist until Release 4 and production gets no Stripe key before the gate. Optional `e2e/billing-stripe.spec.ts` fills Stripe Checkout with the test card, skipped unless `STRIPE_E2E=1`, never in CI.
- **Tests.** The flow suite and the race suite above; `billing-verify`'s output formatting on a PGlite fixture.
- **Acceptance.** The flow suite passes in CI (and the race suite when it lands); `billing:verify` matches a hand count on the founder's test workspace.
- **Effort and cost.** M. CI minutes only.

### P20-04 Unit economics report and the price before live keys (P0, S plus a decision)

From CD P20-04 and OD O43 (the cockpit page is P20-48).

- **Problem.** docs/PENDING.md line 101 estimates a generative still at about $0.17 against $0.083 to $0.145 of revenue per credit; seeded image prices are $0.041 to $0.067 plus a $0.01 cutout plus LLM calls, so the gap is unmeasured. PHASE_18 decision 18 holds the founding banner (P18-21) and referral rewards (P18-24) until the price is set.
- **Change.**
  - The pure math (revenue per credit from the seed, the price rule, margins) goes in `packages/pipeline/src/economics/` so apps/web and trigger can both import it (trigger cannot import apps/web, which depends on `@curvi/trigger`). The database reads go in `apps/web/src/lib/ops/economics.ts` (also used by P20-48 and P20-38's weekly report, which lives in apps/web). The script is `apps/web/scripts/unit-economics.ts` (`pnpm report:unit-economics --days 30`, a root alias for the `@curvi/web` package script, read only, run against production by the founder): `job_steps.cost_micros` by stage joined to the shot method and `generation_jobs.credits_charged`; p50 and p90 cost per delivered shot by method; cost per pack; retry overhead; revenue per credit for every tier, cadence, top up and promotion offer from the seed (the founding offer at both cadences), less the payment fee from seed `economics.paymentFee` (rule 7 row for Stripe's US card rate); LLM cost both at zero while the OpenAI credit lasts and at list price from `llmModelPrices` (that credit ends 2026-12-31).
  - Revenue per credit from today's seed, before the payment fee: Starter $0.145 monthly and $0.12 annual, Growth $0.132 and $0.11, Pro $0.115 and $0.095, Agency $0.0997 and $0.083, top ups $0.15 and $0.12, founding $0.095 monthly ($19 for 200 credits) and $0.079 annual ($190 a year for 2,400 credits; `foundingMemberOffer`, credits.ts line 342; PHASE_18.md line 867).
  - The price rule: credits per still equals the p90 cost divided by the lowest self serve revenue per credit times (1 minus `economics.targetGrossMargin`), rounded up to the next half credit. The floor is the minimum over every self serve price, monthly and annual, including promotion codes; with Agency off self serve (P20-08) it is the founding annual $0.079. Example: a p90 of $0.08 gives 0.08 / (0.079 x 0.4) = 2.53, so 3 credits; a p90 of $0.06 gives 1.90, so 2 credits.
  - If live traffic is thin, the founder runs the golden set live (about $5 to $20) to produce cost rows.
- **Seed.** New `packages/pipeline/src/seed/economics.ts` (`targetGrossMargin` 0.6, `paymentFee`, `minGrossMargin` for the alert in P20-47). A reprice changes only `creditCosts`, `tiers` and `topUps` (rule 2) plus the docs/STRIPE_SETUP.md table; estimates, holds and copy read from them.
- **Tests.** Report math on PGlite fixtures; revenue per credit from the seed, no literals; a seed test that enumerates every self serve price and promotion offer at both cadences (the founding offer included) and checks the floor is their minimum.
- **Acceptance.** The report runs read only against production, and decision 2 is recorded here with its numbers before live keys.
- **Effort and cost.** S, plus founder time. Extends PHASE_18 decision 18.

### P20-05 One credit terms sentence, no expiry (P0, S)

From CD P20-05. Decision 10.

- **Change.**
  - Seed (packages/pipeline/src/seed/credits.ts): remove `TopUp.expiresMonths` (lines 329 to 334), delete `rolloverPolicy` (line 338), add `creditExpiry = { kind: "none" }`.
  - `PriceMapping` drops `expiresMonths`; db-store.ts line 160 writes null. Migration `billing_terms` (lane 2, shared with P20-07) sets `expires_at` to null on every `credit_ledger` row with `reason = 'topup'`.
  - One `CREDIT_TERMS_SENTENCE` in lib/marketing-facts.ts replaces `UNUSED_CREDITS_SENTENCE` and `topUpMonths()`, used by pricing, the billing top up cards (billing/page.tsx line 205), the "how credits work" help article and the terms.
  - PHASE_18 copy that names a top up lifetime changes with it: the P18-07 `out_of_credits` template and P18-24's reward rows (no `expires_at`). If those are not merged yet, they adopt the sentence when they land.
  - docs/marketing.md holds the old wording in claim C-16, line 278, T-DIR-06 (line 1479) and the out of credits template (line 1718). The operator agent updates them through a dated changelog line with the founder's approval on the day P20-05 is live, and no later than 2026-10-18, because MKT-040's directory sweep (from 2026-10-19) copies T-DIR-06 to third party sites that this phase cannot change later. If Release 2 slips past 2026-10-18, the changelog line drops the lifetime clause from T-DIR-06 and C-16 for the sweep (no lifetime stated either way). This phase does not edit docs/marketing.md.
- **Copy.** One sentence, with no "expire" in it so P18-06's email lint passes unchanged: "Credits you do not use stay in your balance from one month to the next, for as long as your account is open."
- **Tests.** A seed test that no expiry field exists; a grant writes null; every surface renders the same sentence; the claims e2e and the P18-06 template lint (which bans "expire" next to "credits") pass without any change to that lint.
- **Acceptance.** No page, email or ledger row states or stores a credit expiry.
- **Effort and cost.** S. $0.

### P20-06 Downgrades take effect at the end of the period (P0 stopgap S, P1 schedule M)

From CD P20-06. Decision 5. Split by the review: the P0 part is a stopgap that creates no schedules of its own; building schedules waits for Release 3, when a subscriber could use them.

- **Problem.** A tier downgrade in the portal applies at once and takes the credit difference back in full, below zero, which blocks new packs (docs/STRIPE_SETUP.md section 5). The portal can defer only a change within one product, and Curvi sells one product per tier (V-bill section 4). While a schedule is attached, the portal can neither update nor cancel the subscription, and Stripe asks that changes go through the Schedule API (V-bill section 3, line 58 of the note), so every path that touches the subscription must handle a pending schedule.
- **Change, P0 stopgap (Release 2).**
  - Upgrades keep the `subscription_update_confirm` deep link (lib/billing/checkout.ts lines 135 to 148), now with a `configuration` per current tier that lists only higher self serve tiers (never Agency, which is not self serve after P20-08; up to 10 products). The default portal configuration has Switch plan off, so the portal home offers no downgrade.
  - The plan picker shows smaller plans with "Email us to move to a smaller plan. It takes effect at your next renewal." linking to hello@curvi.ai; the founder schedules the change in the Stripe Dashboard for the period end.
  - The cancel flow's "smaller plan" save offer (lib/billing/cancel-flow.ts lines 200 to 210), which changes the price at once today, is hidden until the P1 part ships; pause and discount stay.
  - A downgrade the founder schedules by hand attaches a subscription schedule, and with one attached neither the portal nor the Subscriptions API should change the subscription. So already in P0, lib/billing/cancel-service.ts releases any attached schedule (`subscriptions.retrieve`, then `subscriptionSchedules.release` when `schedule` is set) before pause, discount or cancel, and the upgrade route does the same before it opens the portal session; the released downgrade is noted for the founder in the cancel record.
  - docs/STRIPE_SETUP.md section 5: Switch plan off in the default configuration, the per tier upgrade only configurations, downgrades by email (this item edits that section).
- **Change, P1 schedule (Release 3, decision 5).**
  - `scheduleDowngrade` in lib/billing/stripe.ts: refuse when `pending_schedule_id` is already set (offer "Keep {plan}" first); `subscriptionSchedules.create({ from_subscription })`, then `subscriptionSchedules.update` with `end_behavior: "release"` set explicitly, phase 1 copied from the schedule (items, start and end dates, discounts, metadata) and phase 2 on the new price with `proration_behavior: "none"` and a one period duration (V-bill section 3). If the update call fails, release the schedule just created before returning the error, so no half built schedule stays attached.
  - Migration `billing_schedule` (lane 2b): `subscriptions.pending_tier`, `pending_cadence`, `pending_at`, `pending_schedule_id`. RLS unchanged; a test that members read and cannot write them.
  - "Keep Growth" releases the schedule (`/v1/subscription_schedules/:id/release`) and clears the pending columns.
  - Every other path keeps releasing an attached schedule first, as the P0 stopgap already does: the upgrade portal session, the cancel flow's pause and discount offers (lib/billing/cancel-service.ts lines 289 and 308 use `stripe.subscriptions.update`), and cancel before `cancel_at_period_end`; each also clears the pending columns. The smaller plan save offer comes back and uses `scheduleDowngrade`.
  - The webhook handles `subscription_schedule.released`, `subscription_schedule.canceled` and `subscription_schedule.completed` (added to `HANDLED_STRIPE_EVENTS`) and clears the pending columns when the event's schedule id equals `pending_schedule_id`; `customer.subscription.updated` also clears them when the subscription's price changes. The renewal grant already reads the new tier (rule 7 row for the phase transition invoice's `billing_reason`).
  - docs/STRIPE_SETUP.md section 5 moves to "downgrades start on /app/billing".
- **Copy.** P0: "Email us to move to a smaller plan. It takes effect at your next renewal." P1: "Your plan changes to Starter on November 3. Until then you keep Growth and its credits." Button "Keep Growth". Stopgap if decision 5 is declined, shown before the portal opens: "Moving to a smaller plan takes back the credits for the rest of this period, including ones you have used."
- **Tests.** P0: the upgrade configuration per tier lists only higher self serve tiers; the default configuration has plan switching off; the picker shows the email line for smaller plans; the cancel flow hides the smaller plan offer; with a schedule attached, pause, discount, cancel and the upgrade portal session each release it first. P1 (in its own lane, not P20-03's): flow tests on the captured fixtures for a scheduled downgrade and its release; a second downgrade while one is pending is refused; a failed update releases the new schedule; an upgrade, a pause and a discount with a pending downgrade each release the schedule first; cancel releases first; pending columns clear on released, canceled and completed for the matching schedule id; a test mode check of an annual downgrade (UNVERIFIED in the docs).
- **Acceptance.** P0: in test mode, the portal reached from /app/billing offers only higher tiers and never Agency. P1: in test mode, moving from Growth to Starter leaves the balance untouched until renewal, the renewal grants Starter's allowance, and a seller with a pending downgrade can still upgrade, pause and cancel online.
- **Effort and cost.** S for the P0 stopgap, M for the P1 part. $0.
- **Founder.** Create the per tier upgrade configurations and turn Switch plan off in the default configuration (test mode in Release 1, live at the gate); schedule any emailed downgrade in the Dashboard for the period end.

### P20-07 Renewal terms, notices and a cancel flow that meet state rules (P0 part L, P1 notices M)

From CD P20-07, widened by V-bill sections 6, 9 and 10. Decisions 3 and 4. Split by the review: the P0 part is what applies at the first sale; the notices are due months later (decision 4 gives the dates).

- **Problem.** Checkout shows only "I agree to the Terms of Service" (lib/billing/checkout.ts lines 74 to 77). No renewal term sits beside a buy button, no activation email or renewal notice exists, consent is not recorded, and the cancel flow requires a reason and hides cancel behind offers.
- **Change, P0 part (Release 2).**
  - **Seed (credits.ts).** `taxDisplay = { pricesIncludeTax: false }`; `renewalNotices = { annualDaysBefore: 35, annualWindow: [30, 45], monthlyYearlyNotice: true, priceChangeDaysBefore: 21, priceChangeWindow: [7, 30], consentRecordYears: 3 }`. Copy that states these numbers renders them from the seed.
  - **Beside every buy button** (pricing cards, the plan picker, `FinishUpgradeCard` at billing/page.tsx line 305): the renewal disclosure for that plan and cadence, built from the seed. Checkout sets `custom_text.submit.message` to the same disclosure and `custom_text.terms_of_service_acceptance.message` to the checkbox text, keeping `consent_collection.terms_of_service: "required"`. When it creates the session, checkout also writes `disclosure_version` and `disclosure_sha256` of the exact text shown into the session `metadata`.
  - **Consent record.** New tenant table `billing_consents` (migration `billing_terms`): `id`, `workspace_id` (nullable, `on delete set null` so the record outlives a deleted account as California requires), `user_id`, `email_key` (the 0012 `normalized_email_key`), `checkout_session_id` (unique), `tier`, `cadence`, `amount_usd`, `disclosure_version`, `disclosure_sha256`, `accepted_at`. Written by the webhook on `checkout.session.completed` when `consent.terms_of_service` is `accepted`, copying the disclosure version and hash from the session metadata, never computing them at webhook time (a P20-02 replay up to 72 hours later, after a seed change, must record what the buyer saw). RLS: owners and admins of the workspace read; no client writes; `no_oauth_clients`. P20-39 keeps it for `consentRecordYears`.
  - **Cadence on the subscription.** The same migration adds `subscriptions.cadence` (`monthly` or `annual`), written by the webhook from the price's interval on every subscription event, so the notices below select on it.
  - **Activation email** on the first paid invoice of a subscription (`invoice.paid`, billing reason `subscription_create`): plan, amount, cadence, next renewal date, how to cancel, contact. It does not wait for P18-06: `sendBillingEmail` sends through the Resend fetch path `sendFounderEmail` already uses (trigger/src/spend-alerts.ts), to the buyer, from the billing sender, deduplicated by an `events` row `billing:email:plan_active:<invoice id>` inserted with `on conflict do nothing` (the 0003 `events_billing_dedupe_uq` claim). When P18-06 merges it moves to `sendEmail` as transactional with the same key.
  - **Cancel flow** (components/app/cancel-flow.tsx, lib/billing/cancel-flow.ts): the reason becomes optional (Minnesota asks only for what is needed); after the reason step, "Want to see other options first?" asks once per attempt (Minnesota); the offers step always shows a working "Cancel my plan" button beside the offers (California); one click cancels at period end and shows the date.
  - **Tax line** on pricing and billing only when `STRIPE_TAX_ENABLED` is on and prices exclude tax.
  - **docs/STRIPE_SETUP.md section 6:** renewal reminders for annual plans off (today it says to turn them on); Stripe's own renewal emails stay off (decision 4).
- **Change, P1 notices (Release 3; each before its first due date in decision 4).**
  - **Renewal notices** (a tick job, P20-38; a daily route on the existing purge cron until then): subscriptions with `cadence = 'annual'` whose `period_end` falls inside `renewalNotices.annualWindow` days out get one reminder per period (`renewal_notice:<subscription>:<period end>`); subscriptions with `cadence = 'monthly'` get one yearly notice in their anniversary month. Selecting on cadence keeps a monthly plan with a 30 or 31 day period out of the annual window.
  - **Price changes:** `pnpm billing:price-notice --tier <tier> --cadence <cadence> --new-usd <n> --effective <date>` (an `apps/web/scripts/` package script with a root alias) refuses a date outside the seed window and sends to every affected subscriber.
  - These send through P18-06 `sendEmail` as transactional (bounce and complaint suppression applies), which P18-06 records in `email_sends`.
- **Copy.**
  - Monthly: "Your Curvi {Plan} plan renews automatically every month at ${X} plus any tax that applies, until you cancel. Cancel any time online in Billing. To avoid the next charge, cancel before {date}. You keep your plan until the end of the month you paid for. There is no minimum term."
  - Annual: "Your Curvi {Plan} plan renews automatically every year at ${Y} plus any tax that applies, until you cancel. We email you {min} to {max} days before each renewal. Cancel any time online in Billing. To avoid the next charge, cancel before {date}. There is no minimum term." ({min} and {max} from `renewalNotices.annualWindow`.)
  - Shared line: "If our price changes, we email you before it applies, and you can cancel."
  - Checkbox: "I agree that my plan renews automatically at the price above until I cancel, and I agree to the [Terms of Service]({site}/terms)."
  - Tax: "Prices are in US dollars. Tax is added at checkout where it applies."
  - Activation email subject "Your Curvi {Plan} plan is active". Annual reminder subject "Your Curvi plan renews on {date}". Yearly note subject "A yearly note about your Curvi plan". Price notice subject "Your Curvi plan price changes on {date}". Each body states the plan, amount, cadence, the date, "Cancel any time in Billing: {link}" and "Questions? Reply to this email or write to hello@curvi.ai." No offers in these emails (CAN-SPAM, V-bill section 10).
  - Cancel flow: "Want to see other options first?" with "Show me" and "No, cancel my plan"; the always visible button "Cancel my plan"; done: "Your plan is canceled. You keep it until {date}."
- **Tests.** P0: disclosure text from the seed per tier and cadence, with the window numbers rendered from the seed; Checkout params carry both texts within 1200 characters and the disclosure metadata; the consent row on a completed session copies the metadata (a replay after a seed change keeps the old version); `subscriptions.cadence` from the price interval; activation dedupe across a webhook retry and a P20-02 replay; the cancel flow (reason optional, cancel visible on the offers step, one ask per attempt); copy lint; RLS test `packages/db/src/billing-consents.test.ts`. P1: reminder windows by date fixtures, including a monthly subscription 31 days from renewal that gets no annual reminder; price notice refuses an out of window date.
- **Acceptance.** P0: a test mode annual purchase stores one consent row with the disclosure version shown and sends one activation email; a seller can cancel from the offers step in one click. P1: a fixture annual subscription 40 days from renewal gets one reminder and a monthly one gets none.
- **Effort and cost.** L for the P0 part, M for the P1 part. Stripe Tax fees only where registered.
- **Founder.** Registrations per decision 3; counsel confirms decision 4; Stripe's "Send emails about upcoming renewals" stays off; a billing sender address on the verified `updates.curvi.ai` subdomain ("Do before the phase" item 6).

### P20-08 Plan cards list only what runs; Agency off self serve (P0, S)

From CD P20-08. Decision 6. Extends P18-11 (the Growth API line is P18-11's; see the boundary table).

- **Change.**
  - lib/billing/plan-features.ts: Growth "Everything in Starter"; Pro "Everything in Growth". The existing Pro line "Priority queue" (`needs: ["priorityQueue"]`, line 57) stays as it is and keeps showing as coming soon until P20-35's P2 part flips both flags. P20-08 adds no API line of its own. P18-11 owns the Growth line "API keys for the Curvi API and MCP server", but it writes it to the seed's `includeLines`, while the cards render from plan-features.ts; whichever of P18-11 and P20-08 lands second adds the plan-features.ts entry with `needs: ["agentApi"]`, so the line appears once. Coming soon lines move to one "On the way" list under the cards, never inside a card.
  - Seed `tiers[].selfServe` (false for Agency). /pricing hides the Agency card and shows the line below; checkout refuses Agency with `tier_not_self_serve`; docs/STRIPE_SETUP.md says not to create Agency prices yet.
  - The settings Shopify row (lib/services/db.ts line 3009) links to the help article on Shopify uploads once P20-26 ships, and to /help until then.
- **Copy.** "Need more than Pro? Email us and we will set up a larger plan." Shopify row: "The Shopify app is on the way. Your packs already use Shopify ready file names."
- **Tests.** No card contains a coming soon line; checkout refuses Agency; the claims e2e and the pricing snapshot; a test that `FEATURES` in lib/marketing-facts.ts and the seed's `featureStatus` agree for every key the cards read.
- **Acceptance.** /pricing shows Starter, Growth and Pro with only live lines inside the cards, the "On the way" list under them, and the Agency line; a checkout request for Agency answers `tier_not_self_serve`.
- **Effort and cost.** S. $0.

### P20-09 Credit history and invoices in the app (P1, M)

From CD P20-09.

- **Change.**
  - `apps/web/src/lib/billing/history.ts`, a pure function grouping ledger rows into entries: one per pack (net charged, or held while it runs), plan credits, top up, welcome credits, referral (P18-24), operator grant (P20-66), refund or dispute clawback, plan change.
  - Migration `billing_schedule` (lane 2b): `credit_ledger.note text` (at most 120 characters), written by the server on grants ("Growth monthly", "Top up 100"); older rows fall back to labels by reason.
  - `listCreditHistory(workspaceId, cursor)`, 50 entries a page (members already read the ledger under RLS).
  - Invoices: `invoices.list({ customer, limit: 24 })` mapped to number, date, total, status, `hosted_invoice_url`, `invoice_pdf` (rule 7 row); owners and admins only (decision 27); cached 5 minutes; a demo fixture.
  - A CSV download safe against spreadsheet formulas. `csvField` in packages/pipeline/src/packager/index.ts is private and would turn "-8" into the text "'-8" (it escapes a leading "-"). Export a shared `csvField(raw, { numeric })` from packages/pipeline that leaves a field matching a plain signed number alone and escapes everything else as today; the packager and this export both use it.
- **Copy.** "Credit history", "Pack for {product}", "Held while the pack runs", "{Plan} plan credits", "Taken back after a refund", "Invoices", "View", "PDF".
- **Tests.** Grouping (follow ups, partial release, negative balance); invoice mapping; role gating (an editor sees history but not invoices); the CSV writes "-8" as a number and still escapes "=SUM(A1)" and "-cmd"; a demo e2e.
- **Acceptance.** A seller with a pack, a top up and a refund sees one entry each with the right signed amounts, downloads a CSV that opens with numeric amounts, and an owner sees the last invoices with working links.
- **Effort and cost.** M. $0.

### P20-66 Operator credit grant with an audit row (P0, S)

New in this phase (review finding). Extends nothing; P20-45 later adds a cockpit button over the same function.

- **Problem.** Once money flows, the founder has no audited way to grant or correct credits in a customer's workspace: `LedgerReason` has no adjustment reason (packages/db/src/schema.ts lines 39 to 47), P18-04's "Add prospect credits" writes only to the operator workspace, and the cockpit actions (P20-46) have no credit action. The only route is SQL against the production ledger, which P20-11's verify SQL (ledger sums against balances) would catch only after the fact. MKT-015's concierge packs also need credits in the founder workspace before live keys (decision 1).
- **Change.**
  - `apps/web/src/lib/ops/grants.ts` `grantCredits({ workspaceId, credits, note, operator })`: writes a `grant` row with source `system` through the same locked grant path the webhook uses (`DbBillingStore.recordGrantOnce` with its event source set to `system` and a `billing:ops_grant:<uuid>` claim key, so a retried call grants once), with `note` (at most 120 characters) in the row's props until P20-09's `credit_ledger.note` lands. Negative corrections write a `refund` row the same way, never below zero. Each call writes an `ops_audit` row (principle 9) with the operator, workspace, credits and note.
  - A seeded cap `opsGrants = { maxCreditsPerMonth: 2000, maxCreditsPerGrant: 600 }` (credits.ts, rule 2): a grant over either refuses with the remaining allowance.
  - CLI `apps/web/scripts/grant-credits.ts` (`pnpm ops:grant-credits --workspace <id> --credits <n> --note "<text>"`, a root alias for the `@curvi/web` package script), run by the founder with `DATABASE_URL` and `OPS_OPERATOR_EMAIL` set, which must be in `OPS_EMAILS`. It prints the balance before and after.
  - Migration `ops_switches_and_audit` (lane 5) creates `ops_audit` (`id`, `at`, `operator_email`, `action`, `target_kind`, `target_id`, `workspace_id` with no foreign key, `detail jsonb`, `forced boolean`): RLS on, no client policies, privileges revoked from anon and authenticated, `no_oauth_clients`.
- **Copy.** Founder facing only: "Granted {n} credits to {workspace}. Balance {before} to {after}. {left} credits left this month under the grant cap."
- **Tests.** A grant writes one ledger row and one audit row; a repeat with the same key writes nothing; the monthly and per grant caps refuse; a negative correction never takes the balance below zero; a caller not in `OPS_EMAILS` is refused; packages/db: client roles cannot read or write `ops_audit`.
- **Acceptance.** The founder grants 300 credits to the founder workspace from the laptop, the balance shows them, and one `ops_audit` row records it.
- **Effort and cost.** S. $0.
- **Founder.** Run it for the concierge credits (MKT-015) and record the workspace in docs/marketing-ops/exclusions.md.

## W2. Production safety net

### P20-10 Nightly encrypted database backup to R2 (P0, M)

From OD O08. Decisions 11 and 12.

- **Problem.** Supabase Free keeps no restorable backup, and every migration is applied by hand.
- **Change.**
  - `ops/cron/Dockerfile`: a `postgres` base image of the server's major version or newer (17 if `SHOW server_version;` says 17), plus `curl`, `age` and `rclone`. One image serves both crons (this and P20-38's tick).
  - `ops/cron/backup.sh`: `pg_dump --format=custom --no-owner --no-privileges --schema=public --schema=drizzle` against `BACKUP_DATABASE_URL` (the session pooler string); a data only dump of the auth tables a restore needs (`auth.users`, `auth.identities`, `auth.mfa_factors`; never sessions or refresh tokens; confirm the list, rule 7); a row count manifest through `psql`; `age -r $BACKUP_AGE_RECIPIENT`; upload to bucket `curvi-backups` under `daily/YYYY/MM/DD/` and, on the 1st, `monthly/YYYY-MM/`; `POST /api/cron/backup-report` with key, bytes, sha256 and counts; a healthchecks.io ping (`/fail` on any error). Any failure exits non zero.
  - Route `apps/web/src/app/api/cron/backup-report/route.ts` (CRON_SECRET) writes `platform_settings` `backup:last` and `recordCronSuccess("backup")`; `CRON_JOBS` gains `backup` at 1440 minutes, so a stale backup shows `cron_overdue:backup` (degraded, P20-15).
  - Render: a `type: cron` service `curvi-backup`, `runtime: docker`, `dockerfilePath: ./ops/cron/Dockerfile`, schedule `15 9 * * *` (09:15 UTC), plan `0.5c-512mb`. The founder creates it in the dashboard in Release 2 with only its own variables (the `BACKUP_*` set, `HEALTHCHECKS_BACKUP_URL`, `CRON_SECRET` and the site URL for the report), never the web service's secrets; P20-21 records it in render.yaml in Release 3.
  - The dump is for data. `--no-privileges` drops every GRANT and REVOKE, and the ledger and provisioning functions are protected only by `REVOKE EXECUTE` (migrations 0007 lines 136 to 154, 0009 lines 36 to 48, 0012 lines 323 to 342), so a schema restored from this dump would let anon and authenticated call `reserve_credits`, `release_credits` and `provision_workspace` through the Data API. Every restore takes the schema from `pnpm db:migrate` and only the data from the dump (`pg_restore --data-only`); P20-11 and P20-56 say so.
  - R2: a separate bucket with its own token, scoped to it. Lifecycle (`ops/r2/backups-lifecycle.json`): `daily/` 35 days, `monthly/` 180 days (decision 12), abort multipart after 1 day. A bucket lock on `daily/` by age, 7 days, so a leaked token cannot erase the newest backups (locks override lifecycle, V-data section 12).
- **Seed.** `operations.ts` `backup = { dailyKeepDays: 35, monthlyKeepDays: 180, lockDays: 7, maxAgeHours: 26 }` (the privacy copy reads the longest window, P20-23).
- **Tests.** The report route (auth, write, cron success); cron-health overdue; a script test with a fake `pg_dump` and uploader (exit codes, manifest); a lint that the lifecycle file matches the seed.
- **Acceptance.** A backup is recorded within the last 24 hours, its file decrypts with the founder's key, and health turns degraded when it is stale.
- **Effort and cost.** M. About $1 a month (the cron minimum). Storage is small, but R2's free 10 GB-month is per account and shared with production pack files, the cutout cache and P20-54's `curvi-staging` bucket, so the weekly report shows total R2 storage.
- **Founder.** Create the bucket, its token, the lifecycle and the lock; generate the age key pair and keep the private key only in the password manager; create the cron service; set its env.

### P20-11 Restore drill (P0, S)

From OD O09.

- **Problem.** A backup nobody has restored is a guess. The drill must also never put production data where an app could act on it.
- **Change.**
  - **Target: an isolated database only.** The default is a local Supabase stack on the founder's laptop (`supabase start` from the Supabase CLI, Docker), pinned to the production Postgres major; it runs Supabase Auth's own migrations, so `auth.users`, `auth.identities` and `auth.mfa_factors` exist and the auth data and the 0004 and 0012 signup triggers load (the repo's PGlite shim has no `auth.users`, and plain Postgres skips those triggers). Fallback: a throwaway Supabase Free project in a separate organization, created for the drill and deleted after it. Never staging or any database that an app instance, a cron or an email sender connects to: a restored copy holds customer data, password hashes and TOTP secrets, and P20-32's recovery on any booting instance would claim every restored live job and run it again on real provider keys.
  - `ops/cron/restore-drill.sh`, run by the founder: fetch the newest backup, decrypt it, run `pnpm db:migrate` against the drill database (the schema always comes from migrations, never from the dump, P20-10), restore the data with `pg_restore --data-only` and `session_replication_role = replica`, then before anything else set every non terminal `generation_jobs` row to failed with `run_payload` cleared. Run `ops/cron/verify-restore.sql` (counts against the manifest, latest migration tag, ledger sums against balances, foreign key sanity, and function ACLs and table grants equal to a fresh migrate), time it, `POST /api/cron/restore-drill-report` (writes `restore_drill:last`), then destroy the drill database (`supabase stop --no-backup`, or delete the throwaway project).
  - New docs/ops/BACKUP_RESTORE.md: RPO 24 hours, RTO target 2 hours, the Supabase Auth settings to re-apply after a restore, the isolation rule above, and that the schema comes from migrations and only the data from the dump.
- **Seed.** `healthLimits.drillMaxAgeDays` 35 (`restore_drill_overdue` as info).
- **Tests.** The report route; the verify SQL against a PGlite fixture, including the ACL comparison and the job reset; a script test that the drill refuses a target URL equal to `DATABASE_URL` or to the staging project's URL.
- **Acceptance.** One drill into an isolated local stack, with its measured duration, recorded in docs/verification.md and in `restore_drill:last` before Release 2's gate; the drill database no longer exists afterwards.
- **Effort and cost.** S, plus about an hour of founder time a month. $0.
- **Founder.** Install Docker and the Supabase CLI; run the drill monthly.

### P20-12 A migrate script that refuses without a fresh backup (P1, S)

From OD O10. Moved from P0 by the review: "Do before the phase" item 2 (a manual pg_dump before every migration) covers it until Release 3.

- **Change.**
  - `apps/web/scripts/ops-migrate.ts` (`pnpm ops:migrate --env prod`, and `--env staging` once P20-54 exists; a root alias for the `@curvi/web` package script): refuses unless `backup:last` is under one hour old, or `--backup-now` triggers the backup cron (`POST /cron-jobs/{id}/runs`, V-data section 6, which cancels an active run, so it refuses while a backup is running) and waits for its report; runs the Drizzle migrator, so the bookkeeping rows are written and nothing is pasted into the SQL editor; checks `/api/health` reports the schema `current`; with `--seed` shows the recipe and switch drift (P20-20, P20-22) before seeding.
  - Policy in docs/ops/RUNBOOK.md: migrations only add (expand) and remove later (contract), so a code rollback is always safe.
  - A packages/db test flags `DROP`, `RENAME` or `ALTER ... TYPE` in a new migration, and any `DELETE` or `UPDATE` on `platform_settings`, unless the statement carries a `-- contract:` comment.
- **Tests.** The pure steps (freshness check, refusal, a running backup refuses `--backup-now`, drift output); the migration lint, including a `DELETE FROM platform_settings` without the marker.
- **Acceptance.** `ops:migrate --env prod` without a fresh backup refuses and prints why; with one, it applies a pending migration and health shows the schema `current`.
- **Effort and cost.** S. $0. Until it ships, "Do before the phase" item 2 applies.

### P20-13 Sentry for the server and the inline runner (P0, M)

From OD O01 (PHASE_12 D1). Decision 13.

- **Problem.** `SENTRY_DSN` is in render.yaml (line 140) but no SDK is installed, and errors live only in Render's short lived logs.
- **Change.**
  - Add `@sentry/nextjs` (11.x; supports Next 15.5.26).
  - New `apps/web/src/instrumentation.ts`: `register()` imports `sentry.server.config` in the nodejs runtime and `sentry.edge.config` in the edge runtime; `export const onRequestError = Sentry.captureRequestError`.
  - `sentry.server.config.ts`: `sendDefaultPii: false` set explicitly (its default is unverified), `release` from `RENDER_GIT_COMMIT`, `captureConsoleIntegration({ levels: ["error"] })`, so the existing `console.error` calls become events with no rewrite.
  - `beforeSend` removes `authorization`, cookies, `x-cron-secret`, query strings and request bodies, and replaces token path segments listed in one shared constant `TOKEN_PATH_PREFIXES` (apps/web/src/lib/token-paths.ts), which P20-57's logger also reads: `/api/mcp/files/`, `/api/mcp/preview/` (P19-17), `/email/unsubscribe` (P18-06), `/invite/` (P20-59), `/api/claims/` and the claim share page path (P18-04), and P18-12's signed download path. A test fails when a route folder named `[token]` exists outside the list. Prefixes for routes not merged yet are harmless.
  - Two limits keep the free 5k errors a month from running out: `beforeSend` drops an event whose fingerprint was sent more than `errorReporting.maxSameErrorPerHour` times in the last hour, and any event past `errorReporting.maxEventsPerHour` or `maxEventsPerDay` across all fingerprints (at 150 a day the month stays under 5k). Founder alerts never depend on Sentry: email stays the first channel and Sentry the second.
  - `next.config.ts`: `withSentryConfig` with `org`, `project`, `authToken: process.env.SENTRY_AUTH_TOKEN`, `widenClientFileUpload: true`, `tunnelRoute: "/monitoring"`. A test pins only that the middleware matcher never matches `/monitoring` (and, once P20-57 adds its `/api` branch, `/api/health`), so PHASE_19's `/oauth/:path*` and P20-57's `/api/:path*` can join the matcher.
  - lib/jobs/enqueue.ts wraps `runPack` and settle in `Sentry.withScope` with tags `job_id`, `workspace_id`, `run_key`, `run_kind`; `crashed` and `timed_out` are errors, `interrupted` a warning.
  - trigger/src stays free of Sentry: spend-alerts.ts, provider-quota.ts and llm-monitor.ts get an injected `report(message, tags)` hook that trigger/src/db-runtime.ts wires from the web side, so every founder alert has a second channel.
- **Seed.** `monitoring.ts` `errorReporting = { maxSameErrorPerHour: 20, maxEventsPerHour: 60, maxEventsPerDay: 150 }`.
- **Tests.** The scrubber drops secret headers and every `TOKEN_PATH_PREFIXES` path, the claim token included; no DSN means no-op; an enqueue crash reports with job tags (Sentry mocked); the repeat limiter and the hourly and daily caps; the matcher never matches `/monitoring`; a local `next build` without `SENTRY_AUTH_TOKEN` succeeds (settles the UNVERIFIED row).
- **Acceptance.** A thrown runner error shows in Sentry with its `job_id` and a source mapped stack; nothing is sent without a DSN.
- **Effort and cost.** M. $0 on the Developer plan.
- **Founder.** Create the project; set `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (build), `SENTRY_ORG`, `SENTRY_PROJECT`; turn on new issue email alerts.

### P20-14 Error and 404 pages (P1, S)

From OD O02 and CD P20-27 (the error page part). Moved to P1 by the review (not a money gate).

- **Change.** New `app/global-error.tsx` (its own html and body, captures the error, plain copy); `app/error.tsx` and `app/app/error.tsx` call `Sentry.captureException` in an effect and show the digest; new `app/not-found.tsx` (branded, noindex, links to home, pricing and help); `instrumentation-client.ts` for errors only (`tracesSampleRate: 0`, no replay, no feedback). A build check that marketing first load JS grows by at most 40 KB gzipped; over that, client Sentry loads only from the app layout.
- **Copy.** Error: "Something went wrong on our side. Try again, or email hello@curvi.ai with this reference: {digest}." Not found: "We could not find that page. It may have moved, or the link may be wrong." Global error: "Something went wrong on our side. Try again, or contact us if it keeps happening."
- **Tests.** Render tests; e2e that an unknown URL answers 404 with the page; the first load JS budget check; copy lint.
- **Acceptance.** An unknown URL answers 404 with the branded page; a thrown page error shows the reference and appears in Sentry with the same digest.
- **Effort and cost.** S. $0.

### P20-15 Health status: ok, degraded, down (P0, S)

From OD O04.

- **Problem.** A keyword monitor on `"ok":true` misses fal running dry, a dead cron, a stale backup or high memory, because warnings never change `ok`.
- **Change.**
  - New `apps/web/src/lib/health-status.ts` `classify(codes)` with a severity table in code:
    - down: database failed, schema behind, draining (today's `ok: false` cases);
    - degraded: `packs_paused:<cause>`, `scenes_paused`, `maintenance` (P20-19), `provider_quota:*` that pauses a stage, `breaker_open:*` when every provider of a stage is open, `no_*_provider`, `storage_not_configured`, `fal_balance_low` (created by P20-16 from P18-03's balance rows) and P18-03's pause line, `cron_never_ran:*`, `cron_overdue:*` (backup included), `cron_check_failed`, `memory_high`, `db_size_high`, `llm_credits_expired:*`, `llm_model_retiring:*` within 14 days, `stripe_*` once checkout is open, `billing_email_from_missing`, `turnstile_secret_missing` (P20-29), `config_check_failed`;
    - info: `recipe_drift`, `recipe_check_failed`, `fal_admin_key_missing` (P18-03), `llm_credits_expiring:*`, `shot_concurrency_invalid`, `restore_drill_overdue`, `trigger_secret_ignored`.
    - A code missing from the table counts as degraded, so a new warning is never silently ignored, and a test fails when a code config-health can emit is missing from the table.
  - `HealthBody` gains `status` and `degradedBy[]`. `ok` keeps its meaning and the HTTP status logic is unchanged, so Render's restart behavior stays the same. The public body holds no other key named `status`.
  - The route merges the cached provider preflight verdict. config-health gains `db_size_high` (70 percent of the seeded 500 MB Free limit; read only above it, V-data section 1).
- **Seed.** `monitoring.ts` `healthLimits = { dbSizeLimitBytes: 500 MB, dbSizeHighRatio: 0.7, memoryStartRatio: 0.6, drillMaxAgeDays: 35 }`.
- **Tests.** A classification table; an unknown code gives degraded; every code config-health emits is classified; a quota warning gives degraded with HTTP 200; no nested `status` key in the public body; e2e/health.spec.ts checks `status`.
- **Acceptance.** With the fal quota tripped, the body shows `"status":"degraded"` with `packs_paused:quota`, and monitor B fires.
- **Effort and cost.** S. $0.

### P20-16 Provider alerts PHASE_18 leaves out, and canaries (P1, M)

From OD O05. Extends P18-03 and waits for it. Decision 18. Moved to P1 by the review: P18-03 sends the cutout and image quota emails, and "Do before the phase" items 5 and 6 cover the fal pause until Release 3.

- **Problem.** After P18-03, cutout and image quota answers email the founder and fal's balance is probed. Still missing: Anthropic quota emails (`llmQuotaAlertFamilies` is `["openai"]`), proof that a real cutout works end to end, probe results that survive a restart (`lastProbeReport` lives in memory), a quota breaker that clears when the account is funded again, a "stage paused" email, R2 health, BFL's low balance and a `fal_balance_low` health warning. Today a cutout quota pause clears only 30 minutes after the last quota answer: provider preflight re-trips the cutout breakers from `provider_quota_exhausted` events younger than 30 minutes on every check (lib/provider-preflight.ts lines 152 to 180 and 226 to 231), so a restart does not clear it.
- **Change.**
  - Seed `monitoring.ts`: `providerAlertPolicy` replaces `llmQuotaAlertFamilies`: `quotaEmailFamilies: "all"`, `quotaDedupeMinutes` 60, `stagePausedMinutes` 10, `lowBalance` per provider (BFL from its credit read), and `canaryPolicy` (`primaryEveryMinutes` 360, `backupEveryMinutes` 1440, a 64 x 64 fixture, `maxMicrosPerRun`). P18-03's `falBalanceLines` stay where P18-03 put them; config-health warns `fal_balance_low` when an account's newest balance row is under its line.
  - trigger/src/provider-quota.ts: P18-03's notifier reads the policy, so every family emails once per provider per hour through `sendFounderEmail`, deduplicated with `PgCapStore.claim("alerts:quota:<provider>:<hour>")`. llm-monitor.ts's OpenAI quota email hands off to it; a test asserts exactly one email per quota answer for each family.
  - New `trigger/src/provider-canary.ts`: the free key probes, P18-03's `probeFalBalance`, one metered fixture cutout per fal key, and an R2 put, get and delete under `tmp/ops/canary/`. Results go to `platform_settings` `probe:<provider>` (with `passedAt`), which lib/provider-preflight.ts reads instead of the in memory `lastProbeReport`. The probe route stops listing fal as skipped.
  - **The canary is pinned to one provider.** The router skips any provider whose breaker is open (packages/ai/src/router.ts lines 483 to 486) and would fail a primary fal canary over to `fal-birefnet-backup` (a separate provider in the same chain, seed models.ts line 203) and report a false pass. So the canary calls the router with a one provider chain (the provider under test, no failover) and a `trialCall` flag that skips the open breaker check for that single call only, while caps, metering and cost estimates apply as usual (rule 4). A passing canary clears that provider's quota trip in this process and records `passedAt`; `restoreQuotaTrips` ignores quota events older than the newest `passedAt` (or an operator reset from P20-45), so the next preflight does not re-trip it. A newly failing probe emails once.
  - The "stage paused" email fires once the preflight verdict has not been ok for 10 minutes. Subject: "Packs are paused: no cutout provider is available". Resend send failures go to Sentry only (an email cannot report email failing).
  - Until the tick exists (P20-38), `POST /api/cron/provider-canary` joins the stale-jobs cron command and runs only when due.
- **Tests.** A quota error from each family gives one email; dedupe; the canary calls only the provider under test, never the backup; with that provider's breaker open for quota, a passing canary clears the trip and the next preflight does not re-trip it from older events; a failing canary leaves the trip; the canary is metered and capped; probe results survive a new process; the stage paused timer; `fal_balance_low` under the line.
- **Acceptance.** Draining a test fal key's balance produces one quota email and health degraded; after a top up, the next canary passes and packs that need a cutout run again without a restart and before 30 minutes pass.
- **Effort and cost.** M. About $1.50 a month (four primary and one backup cutouts a day at the seeded $0.01).

### P20-17 External monitors and the alerts runbook (P0, XS)

From OD O07. Decision 14.

- **Change.** Monitor A (UptimeRobot keyword `"ok":true`, alert when missing; push and email) and monitor B (keyword `"status":"ok"`, email), both every 5 minutes. healthchecks.io checks pinged on success by the backup cron and, later, the tick. Render's failed deploy emails on. New docs/ops/ALERTS.md: every alert, what it means and the first action, including the Resend rule for unverified senders (rule 7 row).
- **Tests.** A docs test that every degraded and down code in P20-15's severity table has an entry in docs/ops/ALERTS.md; the monitors themselves are founder setup.
- **Acceptance.** Checks that are safe on production, since staging arrives in Release 4: pausing the backup cron's ping (or pointing a temporary healthchecks.io check at nothing) emails within 30 minutes; a temporary UptimeRobot keyword monitor on `https://curvi.ai/api/health` with a keyword that never appears alerts within 10 minutes, then is deleted. The staging 503 drill joins the Release 4 gate.
- **Effort and cost.** XS (agent docs) plus founder setup. $0.

### P20-18 Remove the dead Trigger.dev v3 path (P1, S)

From OD O14. Decision 29. Moved to P1 by the review: "Do before the phase" item 3 (confirm `TRIGGER_SECRET_KEY` is not set) covers it until Release 3.

- **Change.** lib/jobs/enqueue.ts runs inline only (lines 41 to 47 and 66 to 72 go). Remove `@trigger.dev/sdk` from apps/web and trigger, the `trigger.dev` dev dependency, trigger/trigger.config.ts, the `trigger:dev` (root package.json line 20), `dev` and `deploy` scripts, and trigger/src/tasks/*. Pure logic stays as libraries: trigger/src/digest.ts's composition helpers (P20-38 may reuse them from apps/web) and weekly drop planning; digest.ts's own send path and its `METRICS_DIGEST_TO` and `METRICS_DIGEST_FROM` reads are deleted (one weekly email, one send path, P20-38); the churn and weekly drop wrappers are deleted. config-health adds `trigger_secret_ignored` (info) when the key is set. render.yaml drops the key (P20-21). The package name `@curvi/trigger` stays.
- **Tests.** With `TRIGGER_SECRET_KEY` set, packs and follow ups still run inline; the warning appears; no code reads `METRICS_DIGEST_TO`.
- **Acceptance.** No import of `@trigger.dev/sdk` remains; `pnpm install` and the rule 6 gate pass.
- **Effort and cost.** S. $0.

### P20-19 Deploy safety: grace, release script, pause switch, rollback (P1, L)

From OD O15. Decision 17. Moved to P1 by the review: "Do before the phase" item 3 (push only while `/api/health` shows no running pack, or turn auto deploy off) covers it until Release 3. Waits for P18-23 or P20-33 to be live (boundary table): without a requeue, a deploy drain fails every pack that had not started (docs/LAUNCH_CHECKLIST.md line 165), so holding packs in the queue during a release would fail them.

- **Change.**
  - **Grace.** After "Do before the phase" item 3, `CURVI_SHUTDOWN_GRACE_MS=240000` gives a running pack about 300 seconds after traffic moves (60 seconds before SIGTERM plus the grace, V-data section 9). Once staging exists (Release 4), a staging drill starts a pack, deploys, and expects `drained (1 finished` in the log; it also checks that Next keeps `after()` work alive for the whole grace (rule 7).
  - **Release script** `apps/web/scripts/release.ts` (`pnpm release`, a root alias for the `@curvi/web` package script): clean tree, HEAD pushed, CI green through `gh`; stop if the release ships a migration production lacks (journal against `/api/health` `migrations.applied`) and point to P20-12; optional staging smoke for the same SHA once P20-55 exists; set `ops:deploy_pending` so new packs queue instead of starting, wait one cache TTL (30 seconds, principle 2) so every instance has read it, then poll `/api/health` until `running` is 0 (up to 20 minutes, then ask); `PATCH /v1/services/{id}` with `autoDeployTrigger: "off"` if it is not off already; `POST /v1/services/{id}/deploys` with `commitId`, keeping the previous deploy id; poll until live, then check `commit` equals the SHA, `status` is not down, the provider probe is ok and the production light smoke passes (P20-55: public pages and health, no sign in); on failure offer `POST /v1/services/{id}/rollback`; clear `ops:deploy_pending`; tag `release-YYYYMMDD-HHMM`. `RENDER_API_KEY` and `RENDER_SERVICE_ID` stay on the founder's machine.
  - **`ops:deploy_pending` cannot get stuck.** Its value is `{ on, setAt, expiresAt, setBy }`; readers treat it as off once `expiresAt` passes (seed `deploy.pendingMaxMinutes` 30), so a dead script, a sleeping laptop or a founder who stops at the 20 minute prompt never holds packs for long. The script clears it on SIGINT, SIGTERM and every error path. It writes the key only through `POST /api/ops/deploy-pending`, authorized by `OPS_RELEASE_TOKEN` (a separate secret on Render and the founder's machine, able to set or clear only this key), which writes an `ops_audit` row (principle 9) for each set and clear.
  - **Pause new packs.** `ops:packs_paused` (`{ on, message, setBy, setAt }`), read through the 30 second cached reader and failing open: createJob refuses before any hold; the preflight verdict and P18-03's `acquisition.ts` gain a `maintenance` reason (marketing calls to action switch to the waitlist); API v1 answers 503 with the copy; MCP `create_pack` answers with a new `packs_paused` row this item adds to P19-14's `lib/api-v1/mcp-copy.ts` (boundary table).
  - **Rollback runbook** in docs/ops/RUNBOOK.md, including that a Dashboard rollback turns auto deploy off by itself and an API rollback does not.
- **Seed.** `operations.ts` `deploy = { pendingMaxMinutes: 30, idleWaitMinutes: 20 }`.
- **Copy.** Web and API v1: "New packs are paused for a short update. Your photos are saved. Please try again in a few minutes." MCP row (neutral, no web words): "Curvi is not starting new packs for a few minutes. Nothing was charged. Try again shortly."
- **Tests.** The release script's pure steps (the cache wait, idle polling, SHA match, migration stop, rollback offer, clearing on SIGINT and on an error) with a fake Render API; an expired `ops:deploy_pending` reads as off; the route refuses without the token, writes only that key and writes an audit row; the switch blocks createJob with no hold; `ops:deploy_pending` holds starts but accepts jobs, and a held job starts after the deploy (through P18-23 or P20-33's boot pickup); the MCP row passes P19-14's lint; neither key is ever seeded.
- **Acceptance.** Release 3: a production release with no pack running deploys the exact SHA, leaves auto deploy off and clears `ops:deploy_pending`. Release 4: a staging release with a pack running finishes the pack and starts a pack that queued during the release.
- **Effort and cost.** L. $0.
- **Founder.** Set auto deploy to Off on production (or let the first `pnpm release` do it); set `OPS_RELEASE_TOKEN` on Render and the laptop.

### P20-20 Operator switches the seed never resets (P0, S)

New in this phase (found while checking OD correction 4 in the code). Stays in P0 although it protects no payment: PHASE_18's releases re-seed production before Release 3, and "Do before the phase" item 10 is the stopgap until this ships.

- **Problem.** `loadPlatformSettings` upserts every seeded row (trigger/src/platform-settings.ts lines 22 to 28), so each release's `pnpm db:seed` resets `output_options_enabled` (credits.ts line 365) and PHASE_18's `acquisition_paused`, `free_preview_enabled`, `lifecycle_email_enabled`, `referrals_enabled` and its white or clear background switch. A founder who paused acquisition is silently un-paused by the next release.
- **Change.**
  - Switches move to `ops:` keys: `ops:output_options_enabled`, `ops:acquisition_paused`, `ops:free_preview_enabled`, `ops:lifecycle_email_enabled`, `ops:referrals_enabled`, `ops:background_white_or_clear`, plus this phase's `ops:packs_paused`, `ops:deploy_pending` and `ops:global_hard_stop_usd`. PHASE_18's keys are defined here even if PHASE_18 has not merged; its lanes read them through `opsSwitch` when they land.
  - New seed constant `opsSwitchDefaults` in `packages/pipeline/src/seed/operations.ts`: per key `{ default, onReadError }` (kill switches keep failing closed, as `outputOptionsSwitchOn` does today). One reader `opsSwitch(key)` in apps/web/src/lib/features.ts returns the stored value or the default.
  - `loadPlatformSettings` refuses any `ops:` key, and the seed rows keep only values (such as `free_signup_credits`, which a database function reads); `output_options_enabled` leaves `platformSettingSeedRows`.
  - **Expand, then contract.** Migrations are applied before the deploy, and today's code reads a missing `output_options_enabled` row as off (features.ts lines 44 to 60, read at services/db.ts lines 1128 to 1135). So migration `ops_switches_and_audit` (Release 2, lane 5, shared with P20-66's `ops_audit`) only copies each existing switch row to its `ops:` key (`on conflict do nothing`) and leaves the old key in place, so the running code and any rollback keep working. A later migration `ops_switches_contract` (Release 3, lane 5b) deletes the old keys with a `-- contract:` comment, once every reader has used `opsSwitch` in production for one release. After a rollback in between, the old key holds the value from the copy time; the RUNBOOK says to check it.
- **Tests.** A seed test that no seed row starts with `ops:` and that `output_options_enabled` is no longer seeded; the loader refuses one; each reader falls back to its seed default and its read error value; the expand migration on a fixture with a flipped switch keeps both keys; today's reader still reads the old key after the expand migration; the contract migration deletes only the old keys and carries the marker.
- **Acceptance.** Flip `ops:acquisition_paused` on, run `pnpm db:seed`, and it stays on; after the expand migration and before the deploy, output options stay on in production.
- **Effort and cost.** S. $0. Extends P18-03, P18-06, P18-09, P18-12 and P18-24, which read their switches through `opsSwitch`.

### P20-21 render.yaml lists every variable and every cron (P1, S)

From OD O39. Moved to P1 by the review: it does not protect a payment, and the Blueprint adoption is not verified (V-data section 10: a new Blueprint can create suffixed copies of existing services). Runs last in Release 3, after every lane that adds a variable.

- **Change.**
  - render.yaml declares every variable the code reads in production, secrets with `sync: false`: the missing ones in "Starting point" (`CRON_SECRET`, `OPS_EMAILS`, `FAL_KEY_BACKUP`, `NEXT_PUBLIC_OUTPUT_OPTIONS`, `CURVI_SHOT_CONCURRENCY`, `NODE_OPTIONS`, `DAILY_SPEND_HARD_STOP_USD`, `OPENAI_ADS_CONVERSIONS_KEY`, `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID`, `NEXT_PUBLIC_POSTHOG_HOST`, `SHOPIFY_API_SECRET`, `CURVI_ALLOW_DEMO_GENERATION`, `CURVI_TEMPLATE_FONT_FILE`), PHASE_18's and PHASE_19's new ones, `VISITS_HASH_KEY` from `site-visitors`, and this phase's (see "Environment variables"). `TRIGGER_SECRET_KEY` is removed. `autoDeployTrigger` becomes `off` (decision 17).
  - **Secrets go only where they are used.** An env group holds only what every service needs (the site URL, `CRON_SECRET`, `NODE_ENV`). Each service sets its own secrets: the web service its Stripe, provider and Supabase keys; `curvi-backup` only `BACKUP_DATABASE_URL`, the `BACKUP_R2_*` keys, `BACKUP_AGE_RECIPIENT` and `HEALTHCHECKS_BACKUP_URL`; `curvi-tick` only `HEALTHCHECKS_TICK_URL`. So the web service has no write access to the backup bucket and the crons hold no web secrets.
  - `type: cron` services for `curvi-backup` (created by hand in Release 2) and, until P20-38 replaces them, the two existing dashboard crons exactly as they run today ("Do before the phase" item 8). P20-38 swaps those two for `curvi-tick`.
  - Generalize apps/web/src/lib/jobs/deploy-config.test.ts: scan apps/web/src, trigger/src and packages for `optionalEnv`, `requireEnv` and `process.env` reads and assert each name is in render.yaml or a documented local only allowlist (`NODE_ENV`, `PORT`, `RENDER_GIT_COMMIT`, `ALLOW_DEMO_MODE`, `NEXT_MANUAL_SIG_HANDLE`, `CURVI_RSS_TEST`, `TEST_DATABASE_URL`, `STRIPE_E2E`, `RENDER_API_KEY` and the like) and in the docs/LAUNCH_CHECKLIST.md table, and that each secret is declared on the services that use it and on no other. It also asserts every cron service maps to a `CRON_JOBS` entry.
  - A separate test, `env-example.test.ts`, checks the same names against `.env.example`. Agents cannot edit that file, so this test only warns (it is skipped with a printed list of missing names) until the founder's edit lands, and the lane can merge without it; the founder's edit turns it into a hard check.
  - Adopting the hand made service: before the first Blueprint sync, set Auto Sync to No, use "Generate Blueprint" to compare, make the name and type match exactly, and read the preview (V-data section 10).
- **Tests.** The completeness test fails on an undeclared variable and on a backup secret declared on the web service; the cron mapping; the `.env.example` warning lists missing names.
- **Acceptance.** The Blueprint preview shows the existing service adopted with no new or suffixed service and no env value overwritten, and the completeness test passes.
- **Effort and cost.** S. $0.

### P20-22 Model retirement and traffic split checks (P1, S)

From OD O23 (the seed change itself is "Do before the phase" item 1) and the drift gap recorded on `seed-openai-serving`. Moved to P1 by the review: "Do before the phase" item 1 takes Haiku out of every active chain.

- **Change.**
  - Seed `monitoring.ts` `llmModelRetirements`: model id, earliest retirement date, source and the date checked (Haiku 4.5 "not sooner than 2026-10-15"; Sonnet 5 "not sooner than 2027-06-30"; checked on Anthropic's deprecations page 2026-10-01).
  - config-health `llm_model_retiring:<model>` (info from 30 days out, degraded from 14) for any model in an active chain, fallbacks and escalations included.
  - `recipe_drift` also compares `traffic_pct` and `active` per version, so a SQL switch the seed does not match shows up before a re-seed undoes it.
  - A seed test with a fixed `asOf` date: no active chain names a model at or past its earliest retirement date; the test from `seed-openai-serving` that OpenAI versions serve 100 stays.
- **Tests.** As above, plus the drift detail lists the traffic difference.
- **Acceptance.** With production's traffic split differing from the seed, `/api/health` details list `recipe_drift` with the version and both percentages; a fixture chain naming a model 10 days from retirement shows `llm_model_retiring` as degraded.
- **Effort and cost.** S. $0.

## W3. Trust, legal and support

### P20-23 Legal facts in one module: terms, privacy retention, subprocessors (P0, S plus founder and counsel)

From CD P20-10 and OD O13. Decisions 9, 10 and 12.

- **Problem.** Privacy says uploads stay while the account is active, the purge deletes them after 30 days; terms say fees are non refundable and point to a rollover policy that does not exist; there is no entity, governing law, renewal term or subprocessor list (CA section 7).
- **Change.**
  - New `apps/web/src/lib/legal/facts.ts`: entity, postal address, governing law, support email and reply time (decision 24), the credit sentence (P20-05), the refund policy (today's "not refundable except where the law requires" until P18 decision 14's money back promise is approved), and retention numbers imported from their sources: `SOURCE_RETENTION_DAYS` (lib/trust/purge.ts line 31), the temporary object window (P20-40), the longest backup window (P20-10), consent records and billing email records (`renewalNotices.consentRecordYears`, P20-07), the free preview window (P18-12's `anon/` lifecycle, once P18-12 ships), and the log retention days (PHASE_19 decision 10 once PHASE_19 merges; until then the Sentry lookback of decision 13). A number whose feature has not shipped renders the statement that is true today: until P20-40 ships, temporary files such as the reused cutouts stay with the workspace until it is deleted.
  - Terms, privacy, help and settings read from it. PHASE_19's assistant sections in privacy and terms keep their text and read the log number from it.
  - `lib/legal/subprocessors.ts` and the page `(marketing)/legal/subprocessors`: Supabase, Render, Cloudflare (R2, Email Routing, Turnstile), Stripe, Resend, PostHog, Sentry, OpenAI (models, image generation and the Ads pixel), Anthropic, Google Gemini, Black Forest Labs, fal, Upstash. Each entry carries the condition that puts it in use (Turnstile with P20-29, Upstash with P20-51), and the page lists only vendors in use. A test checks every entry in `DEFAULT_PROVIDER_ENTRIES` (lib/health.ts line 46) and every health service is listed.
  - Terms sections: who we are; plans, renewal and cancellation (P20-07's terms); credits (held, then charged only for delivered files, taken back on refunds, disputes and plan changes); refunds; AI outputs (backgrounds and scenes may be generated, product pixels never are, the seller checks listings, labels are written into the files); acceptable use; liability; governing law; changes with 30 days' email notice for material changes.
  - Privacy "Retention and deletion" becomes a table.
- **Copy (privacy retention, numbers rendered from the module).** "Source photos are deleted {source} days after a pack last used them. Your pack files stay while your account is open. Temporary processing files are deleted within about {tmp} days. Photos you try in the free preview without an account are deleted within {preview} days. When you delete your account we delete your workspace data and files straight away, except the records below. When you buy a plan we keep a record of the renewal terms you agreed to, and of the billing emails we sent you, for {consentYears} years, including after you delete your account, because renewal laws require it. Encrypted copies of our database are kept for up to {backup} days, so data you delete can remain in them until then. Request logs and error reports are kept for up to {logs} days." Until P20-40 ships, the temporary files sentence is: "Temporary processing files, such as cutouts we reuse, stay with your workspace until you delete your account." The preview sentence appears once P18-12 ships. Also names Sentry, and Cloudflare Turnstile once P20-29 ships, as processors.
- **Tests.** Rendered numbers equal their constants, including `consentRecordYears` and the preview window; the consent and billing email rows are in the retention table; the temporary files sentence matches whether P20-40's prefix exists; subprocessor coverage and the in use conditions; "Last updated" dates move; copy lint.
- **Acceptance.** No retention, refund or credit statement on any page differs from the module.
- **Effort and cost.** S. Counsel fees (decision 9 estimate).
- **Founder.** Supply the entity, address and governing law; approve the text; counsel review before live keys, or within 30 days of them under decision 9's alternative.

### P20-24 Contact form on /support and Help inside the app (P1, M)

From CD P20-11. Extends P19-23 (decision 24) and P18-06. Moved to P1 by the review: marketing gate G1 already requires hello@curvi.ai to receive outside mail, which covers support until Release 3.

- **Change.**
  - PHASE_19's `(marketing)/support/page.tsx` gains `SupportForm` and the action `sendSupportRequest`: topic (pack, billing, account, other), a message of 10 to 2,000 characters, an email field when signed out, an optional job id kept only if it belongs to the caller's workspace, a honeypot field. Rate limit policy `support.contact` (5 per user and 10 per IP an hour; the IP is forgeable until P20-51, so the per user limit is the one that holds).
  - The message goes to `SUPPORT_INBOX` (default hello@curvi.ai) through P18-06 `sendEmail` (transactional) with reply-to set to the sender. A signed in sender gets an automatic reply to their account email. A signed out sender gets no automatic reply until P20-29's Turnstile is live on the form, so the form cannot be used to send Curvi mail to strangers; after that, the reply never echoes the message body and honors P18-06's bounce and complaint suppression. An `events` row `support_request` records the topic and job, never the message body.
  - AppNav gains "Help". Failed and needs review states show "Get help with this pack", linking to `/support?topic=pack&job={id}`; billing errors link with `topic=billing`. Of the 25 "email hello@curvi.ai" strings, only the UI surfaces become links to the form, keeping the address as text: app/error.tsx and app/app/error.tsx, the settings seat line (app/app/settings/page.tsx line 79), billing-actions.tsx (lines 168, 170, 392 and 393), and job-copy.ts's `CONTACT` (line 430). The JSON-LD email (lib/seo.ts), the API JSON notices (billing checkout and portal routes, cancel-service.ts), the account deletion refusal (lib/trust/account.ts), the auth form and the privacy, terms, help and footer mailto links stay as they are.
- **Copy.** "Contact us"; "What do you need help with?" with "A pack", "Billing", "My account", "Something else"; "Tell us what happened"; button "Send"; success "Thanks. We got your message and will reply within two business days."; failure "We could not send your message. Email hello@curvi.ai instead."
- **Tests.** Validation, the rate limit, the job ownership check, the mocked email payload, no automatic reply for a signed out sender while Turnstile is off, the reply never contains the message body, a demo e2e.
- **Acceptance.** A signed in seller on a failed pack reaches the form with the job attached, and the founder's inbox gets one email with reply-to set.
- **Effort and cost.** M. $0.
- **Founder.** Confirm hello@curvi.ai receives mail, then send a test through the form.

### P20-25 "Not yet" pack feedback reaches the founder (P1, XS)

From CD P20-12, reduced because P18-05 owns feedback storage and the card.

- **Change.** When a P18-05 answer is `usable = not_yet`, send one founder email per job (`sendFounderEmail`, dedupe `feedback:<job>`) with the job link and comment, until P20-47 absorbs it as an alert rule; the thanks state shows "Get help with this pack" to `/support?topic=pack&job={id}`.
- **Copy.** "Thanks. We read every note and will email you if we can fix it."
- **Tests.** One email per job; none for other answers; the thanks state links to the form with the job.
- **Acceptance.** A "Not yet" answer on a test pack sends the founder one email with the job link and comment, and a second answer on the same job sends none.
- **Effort and cost.** XS. $0.

### P20-26 Help center: a page per article and 12 new articles (P1, M)

From CD P20-13.

- **Change.** `(marketing)/help/[slug]/page.tsx` with static params from help-articles.ts; a grouped index with a filter box; Article JSON-LD and sitemap entries. New articles: "When a pack fails or images need review", "Download your files", "Upload your images to Amazon Seller Central", "Upload your images to Shopify", "Upload to Etsy, eBay, Walmart and TikTok Shop", "Refunds and the money back promise" (after P18 decision 14), "Credit history and invoices", "Why your pack is waiting", "Make a new version of an image", "Delete your account and data", "Invite your team", "Change your email". Articles for features not yet shipped stay gated by `FEATURES`. The billing article stays gated until checkout is open (help-articles.ts line 129).
- **Rule 7.** Each marketplace upload walkthrough gets a dated row.
- **Tests.** Every article renders, is in the sitemap and passes the copy lint and claims test; a gated article is absent from the index, the sitemap and its URL (404) while its feature is not live.
- **Acceptance.** Each live article has its own URL in the sitemap with Article JSON-LD, and the filter box finds an article by a word in its title.
- **Effort and cost.** M. $0.

### P20-27 Status page and changelog (P1, S)

From CD P20-14. Decision 28. Extends P18-03's `/api/status`.

- **Change.** `(marketing)/status`, revalidated every 60 seconds, maps `/api/status` and the public health status to four customer lines: Making packs, Lifestyle scenes, Downloads, Sign in and billing, each "Working normally", "Slower than usual" or "Paused". It never names a provider (reuse the job-copy filter). Founder notes come from `content/status-notes.ts`. `(marketing)/changelog` is built from `content/changelog.ts`. Both get footer links.
- **Tests.** The state mapping; no provider name in the output; copy lint.
- **Acceptance.** With the fal quota tripped, /status shows Making packs as "Paused" within about 60 seconds and names no provider; the changelog lists the entries in content/changelog.ts.
- **Effort and cost.** S. $0.

## W4. Sign in

### P20-28 Email confirmation on any device, a resend button, plain errors (P1, M)

From CD P20-16. Moved to P1 by the review: it is an activation fix, not a money gate. Ships early in Release 3.

- **Problem.** /auth/callback only exchanges a PKCE code, which works only in the browser that signed up; the notice says "Open it on this device"; "request a new link" has no control; raw Supabase text reaches users.
- **Change.**
  - Move the post sign in steps out of app/auth/callback/route.ts into `apps/web/src/lib/auth/finish.ts`: the terms record, the Registration Completed conversion, the welcome redirect, PHASE_18's attribution row and `signup_confirmed` event (P18-01, P18-02), claim and preview redemption (P18-04, P18-12), the pending referral row (P18-24), and PHASE_19's rule that a `next` under `/oauth/consent` skips /welcome. The contract commit lands this as a pure move of today's steps; the PHASE_18 and PHASE_19 steps join `finish.ts` as those phases merge.
  - New `app/auth/confirm/route.ts` and a small confirm page. GET shows "Confirm my email" (link scanners that prefetch a GET do not use up the token, V-data section 5); POST reads `token_hash` and `type` (`email`, `recovery`, `email_change`), calls `verifyOtp`, then `finish`. `next` arrives as a full URL (Supabase fills `{{ .RedirectTo }}` with the `emailRedirectTo` value), and that value is itself nested: AuthForm sends `${origin}/auth/callback?next=<path>` (components/marketing/auth-form.tsx line 122), while `safeNextPath` returns its fallback for anything that does not start with "/" (lib/safe-next.ts line 42). So `lib/auth/confirm-next.ts` parses it in order: accept only a URL whose origin equals the site origin (any other origin gives /app); if its path is `/auth/callback`, unwrap its own `next` parameter; then apply `safeNextPath` to the result. A bare path is passed to `safeNextPath` directly. Check how Supabase encodes `{{ .RedirectTo }}` inside the link before building (rule 7 row) and test the exact encoded form. PHASE_19's return to `/oauth/consent?authorization_id=...` must survive this. Recovery goes to /reset-password. Failures go to `/login?error=link_invalid`. /auth/callback stays for Google (P18-13) and PKCE.
  - `ResendLinkButton` (`auth.resend({ type: "signup", email })` with a 60 second cooldown) on the signup success state and the `link_invalid` state; it accepts a captcha token for P20-29.
  - New `lib/auth-errors.ts` maps `error.code` to copy; `runAuthCall` (lib/auth-call.ts line 44) returns only mapped copy; an unknown code falls back to the generic message and logs the code.
- **Copy.** Signup notice: "Almost there. We sent a confirmation link to {email}. Open it on any device. If it does not arrive in a minute, check spam or send it again." Button "Send the link again". Cooldown "You can send another link in {n} seconds." Confirm page "Confirm my email". `invalid_credentials`: "That email and password do not match. Try again or reset your password." `user_already_exists`: "An account with this email already exists. Log in instead." `over_email_send_rate_limit`: "We sent several links already. Wait a minute, then try again." The `link_invalid` message drops "request a new link" in favor of the button.
- **Tests.** The confirm route for each type; `next` parsing: a full same origin URL wrapping `/auth/callback?next=%2Foauth%2Fconsent%3Fauthorization_id%3D...` lands on `/oauth/consent?authorization_id=...`, a bare path, a foreign origin (gives /app), a nested foreign origin; a used token; `finish` behaves exactly as the callback did (a snapshot of its effects); the resend cooldown; the error map; copy lint.
- **Acceptance.** Signing up on a laptop and opening the email on a phone confirms the account and signs in on the phone.
- **Effort and cost.** M. $0.
- **Founder.** Point the Supabase templates (Confirm signup, Reset password, Change email, Magic link) at `/auth/confirm` with `{{ .TokenHash }}` and the right `type`, then test from a phone.

### P20-29 Turnstile on sign in and on anonymous endpoints that spend (P1, S to M)

From OD O33. Decision 26. Changes PHASE_18 decision 7 for these paths only.

- **Change.**
  - `components/marketing/turnstile.tsx` (script from `https://challenges.cloudflare.com/turnstile/v0/api.js`, never proxied, reset after every submit). AuthForm passes `options.captchaToken` to `signUp` and `signInWithPassword`; the forgot password form to `resetPasswordForEmail(email, { captchaToken })`; `ResendLinkButton` to `resend`; PHASE_19's inline consent page form the same way.
  - `lib/turnstile.ts` server `siteverify` (checks `success`, `hostname` and `action`, passes `remoteip` from the trusted client IP of P20-51, treats `timeout-or-duplicate` as "try again") for P18-12's `/api/preview`, P18-18's store audit and the signed out support form.
  - **Spending fails closed (principle 1).** When the site key is set and the secret is not, the anonymous spend endpoints refuse (a misconfiguration). In production with neither set, they use the stricter seeded limits `turnstileFallback` (half of P18-12's per IP and site wide daily caps) instead of skipping the check silently. Either case warns `turnstile_secret_missing` in config-health (degraded, P20-15).
  - CSP gains `https://challenges.cloudflare.com` in `script-src` and `frame-src`.
  - Staging and Playwright use the always pass test keys, which only works with staging's own Supabase project (P20-54). Turnstile treats Playwright as a bot and the production secret rejects dummy tokens, so no automated run signs in on production (P20-55).
- **Copy.** "We could not check that you are a person. Please try again."
- **Tests.** Each form sends a token; siteverify failure paths; the site key without the secret refuses; production without either uses the stricter limits and warns; e2e with the test keys.
- **Acceptance.** With CAPTCHA on in Supabase, sign up, sign in, reset and resend work in a browser and fail from a script without a token; the PHASE_19 reviewer login still works.
- **Effort and cost.** S to M. $0.
- **Founder.** Create the widget; enable CAPTCHA in Supabase with the secret, after PHASE_19's review closes.

### P20-30 No free credits for temporary inboxes (P1, S)

From OD O34.

- **Change.** Seed `packages/pipeline/src/seed/disposable-domains.ts`, vendored from the CC0 disposable-email-domains list (source, commit and date in docs/verification.md). New platform table `disposable_email_domains` (migration `disposable_domains`, lane 15, RLS on, no policies, privileges revoked from anon and authenticated, `no_oauth_clients`), loaded by seed-cli. The signup grant function (migration 0012, line 139) gets a new version that withholds credits with `withheld_reason = 'disposable_email'`, also matching parent domains. Sign up and buying still work. Because this lives in the database, it holds when someone calls the public Supabase API directly. The welcome page and dashboard show the notice for that reason.
- **Copy.** "Temporary inboxes cannot receive free credits. Please use an address you keep."
- **Tests.** packages/db: a disposable address and a subdomain of one are withheld; a normal address is paid; privileges on the table; the welcome page shows the notice for a withheld grant.
- **Acceptance.** Signing up with an address on the vendored list confirms the account with no free credits and shows the notice; buying a top up on that account still works.
- **Effort and cost.** S. $0.

### P20-31 Change email (P1, S)

From CD P20-17.

- **Change.** A settings card calls `updateUser({ email })` with `emailRedirectTo` through `/auth/confirm?next=/app/settings`. Secure email change (on by default) sends both addresses the Change email template with `type=email_change` (V-data section 5). On completion, update the Stripe customer's email and move P18-06's suppression key to the new address.
- **Copy.** "We sent a link to both addresses. Your email changes once you open both."
- **Tests.** The action; the Stripe update; the suppression move; the confirm route with `type=email_change` lands on /app/settings.
- **Acceptance.** Changing the email in settings and opening both links updates the sign in email, the Stripe customer's email and the suppression key.
- **Effort and cost.** S. $0.

## W5. Keep packs flowing

### P20-32 Fast orphan recovery after a crash (P1, M)

From OD O16. Decision 20.

- **Problem.** An out of memory crash or a hard kill skips the drain, so P18-23's requeue never runs and the job sits until the 30 minute stale sweep.
- **Change.**
  - Migration `runner_columns` (lane 8): `generation_jobs.heartbeat_at`, `runner_id` (at most 64 characters) and a partial index on `(status, heartbeat_at)` for live rows.
  - The runner gets a boot id. Running entries write `heartbeat_at` every 60 seconds and leave `updated_at` to mean progress, so the 30 minute sweep still catches a hung run. Waiting entries keep bumping `updated_at` exactly as today (`heartbeatQueuedJobs`, lib/jobs/enqueue.ts lines 100 to 119, up to `DEFAULT_MAX_QUEUE_WAIT_MS`, 60 minutes) and also write `heartbeat_at`. The stale sweep (lib/services/reconcile.ts line 106) reads `updated_at` only, so a pack waiting its turn longer than 30 minutes, which P20-35, P20-19's release hold and P20-60's batches make more likely, is never failed while its process is alive.
  - New `apps/web/src/lib/jobs/recovery.ts`, started from `instrumentation.ts` `register()` (nodejs runtime, db mode, 15 seconds after boot, then every 120 seconds, and from the tick): a live job whose `coalesce(heartbeat_at, updated_at)` is older than 5 minutes and whose `runner_id` is not this boot's is claimed with a conditional UPDATE that re-checks the heartbeat in SQL. Then, by decision 20: a row that never started (queued, or a waiting follow up) is handed to P20-33's requeue, since it cannot have caused the crash; a row that was running is settled as failed with its hold released and P18-23's restart copy, never requeued, because the same pack could take the shared instance down again.
- **Seed.** `operations.ts` `orphan = { heartbeatSeconds: 60, staleHeartbeatMinutes: 5, sweepEverySeconds: 120 }`.
- **Tests.** Jobs of the current boot are never touched; a fresh heartbeat is left alone (old and new instances overlap during a deploy); rows without a heartbeat fall back to `updated_at`; a queued job that has waited 40 minutes with a fresh heartbeat survives both the recovery sweep and the 30 minute stale sweep; a crash orphan that was running is settled failed and released, not requeued; a crash orphan that never started is requeued once.
- **Acceptance.** Killing the process mid pack recovers the job within about 5 minutes: the running pack is failed with its credits released, and a pack that was waiting starts on the new process. Unit tests cover it in Release 3; the live check is on staging in Release 4, since killing production on purpose would also take down sign in and the Stripe webhook.
- **Effort and cost.** M. $0.

### P20-33 A requeue that survives a crash and counts cost once (P1, M)

From OD O17. Extends P18-23 (builds P18-23 first if it has not shipped). Decision 20.

- **Problem.** P18-23 requeues not started packs with a `restart:` run key and re-reserves interrupted ones, and its boot pickup runs in the same process. The run payload (`GeneratePackInput`, trigger/src/pipeline-runner.ts line 1163, with preflight intake, brand style and output options) lives only in memory, so a new instance cannot rebuild it, and two instances overlapping during a deploy could both pick a job up. COGS uses `greatest()` (trigger/src/db-store.ts line 141), so a second run hides the first run's spend, and a late report from an earlier run still lands after a settle with no run key check (db-store.ts lines 148 to 151).
- **Change.**
  - Migration `runner_columns`: `generation_jobs.run_payload jsonb` (object check), unless P18-23 already stores one.
  - createJob stores the payload without `runKey` in the same transaction as the job.
  - Recovery (P20-32) and boot pickup claim queued `restart:` rows that no runner holds with a conditional UPDATE on `runner_id`, then submit them with the row's run key, so exactly one instance runs each.
  - What is requeued: packs a deploy drain interrupted (P18-23 marks them) and packs that never started. A pack orphaned while running by a crash is settled as failed (decision 20, P20-32). The restart rule keeps P18-23's `restart_count` and seed `deployRestarts.max` (1), and adds `deployRestarts.windowMinutes` 60: a job older than that fails and releases as today. `crashed` and `timed_out` still fail, since a crash may repeat.
  - COGS: each cost report adds its own delta with one atomic `cogs_micros = cogs_micros + delta`, replacing the `greatest()` comparison. A late report from an earlier, already fenced run still adds only what it spent, so it can never overwrite the requeued run's figure that P20-04's report and P20-47's margin rule read.
  - The cockpit's Requeue action (P20-46) uses the same function.
- **Copy.** P18-23's "We restarted the server while your pack was running, so it started again. You are charged only once."
- **Tests.** A drain requeues; boot pickup runs a job exactly once while two instances overlap; a second interruption fails the job and releases its credits; a running crash orphan is never requeued; charges are idempotent per shot; COGS adds across runs; a late report from the first run after the second run's report leaves the sum of both; follow ups are unchanged.
- **Acceptance.** A deploy during a running pack on production (Release 3, synthetic operator workspace) requeues it once, it finishes on the new instance, and its COGS equals the sum of both runs' provider spend.
- **Effort and cost.** M. Re-run compute only.

### P20-34 Memory test, start guard and heap cap (P1, S to M)

From OD O19.

- **Change.** `apps/web/scripts/memory-test.ts` (`pnpm ops:memory-test`, a root alias for the `@curvi/web` package script): the real runner with fake providers returning images of realistic size, concurrency N, the Everything bundle plus ads and 4 variations, sampling RSS, heap and external memory every 200 ms, exiting non zero over `--budget-mb`. A nightly workflow runs it at concurrency 2 and the result goes to docs/verification.md. A runtime guard: an injected `canStart()` in `InlinePackRunner.pump()` (inline-runner.ts line 334) holds new starts while RSS is above `healthLimits.memoryStartRatio` (0.6) of the container limit, unless nothing is running, re-checking every 5 seconds. Set `NODE_OPTIONS=--max-old-space-size=` from the measurement (libvips memory sits outside the heap); evaluate `MALLOC_ARENA_MAX=2`.
- **Tests.** Backpressure cases in inline-runner.test.ts (held above the ratio, started when nothing runs, released when memory falls); the memory test's exit code over the budget with a fake sampler.
- **Acceptance.** The nightly run at concurrency 2 stays under the measured budget and its numbers are in docs/verification.md; `NODE_OPTIONS` in production is set from them.
- **Effort and cost.** S to M. $0.

### P20-35 Queue position, wait estimate, priority and fairness (P1 position and estimate S; P2 priority and fairness M, triggered)

From CD P20-20 and OD O20. Decision 6. Split by the review: at concurrency 2 and today's volume, priority and fairness change nothing until queues form.

- **Change, P1 part (Release 3).**
  - Migration `runner_columns`: `generation_jobs.started_at` and `finished_at`, set by the runner.
  - `apps/web/src/lib/jobs/queue-info.ts` returns the caller's position only, computed over the owner connection, never another tenant's data. Wait estimate: ceiling of position divided by concurrency, times the median run of the last 50 finished jobs, or the seeded default with no history.
  - `JobView.queue` carries `{ position, etaSeconds }`.
- **Change, P2 part (trigger: the weekly report shows a queue wait over 10 minutes, or a Pro buyer asks for the priority queue).**
  - `pump()` picks by priority first (workspaces whose plan has `priorityQueue`), then by time queued, and while another workspace waits a workspace runs at most `queue.maxRunningPerWorkspace` packs.
  - The Pro card line "Priority queue" already exists in plan-features.ts (line 57) and is gated by `FEATURES.priorityQueue` in lib/marketing-facts.ts (line 187), a flag separate from the seed's `featureStatus.priorityQueue` (credits.ts line 70). This part flips both to live in the same change; P20-08's agreement test keeps them equal.
- **Seed.** `operations.ts` `queue = { etaDefaultSeconds: 240, etaSampleSize: 50, maxRunningPerWorkspace: 1 }` (seed, not platform settings rows).
- **Copy.** "Your pack is number {n} in line. It should start in about {m} minutes." / "Your pack starts next." / "Your pack is waiting for a free spot. It starts soon."
- **Tests.** P1: the estimate with and without history; no cross tenant data in the view; the copy per position. P2: ordering by priority and fairness; both flags flip together.
- **Acceptance.** P1: with two packs running and one waiting, the waiting seller sees "Your pack starts next." with an estimate. P2: a Pro workspace's pack starts before an earlier Starter pack, and one workspace never holds both slots while another waits.
- **Effort and cost.** S for the P1 part, M for the P2 part. $0.

### P20-36 Shared breaker in Postgres with half open (P2, M; triggered)

From OD O21. Moved to P2 by the review. Trigger: production runs a second web instance (render.yaml declares one today) or a breaker state disagreement between overlapping deploy instances shows up in the weekly report. Until then the in memory breaker plus P20-16's canary rules (pinned trial call, `passedAt` respected by `restoreQuotaTrips`) cover quota trips on the single instance.

- **Change.** Platform table `breaker_state(key primary key, value, expires_at, updated_at)` (migration `breaker_state`, RLS on, no client policies, privileges revoked, `no_oauth_clients`). New `trigger/src/breaker-store.ts` `PgBreakerStore`: `get`, `set` with a TTL, `incr` that keeps the existing expiry, and `setIfAbsent`; database errors read as a closed breaker. One `breakerStore()` accessor wired through trigger/src/runtime.ts line 424, health and lib/provider-preflight.ts, so `restoreQuotaTrips` (line 158) goes away. Half open in packages/ai/src/breaker.ts: after the open key expires, one caller wins `setIfAbsent(trial, breakerPolicy.trialSeconds)` and makes a trial call; success clears, failure reopens with doubled backoff capped at `breakerPolicy.maxOpenSeconds`; quota trips clear only through a passing canary (P20-16, whose trial call skips the open check for its one provider) or an operator reset.
- **Seed.** models.ts `breakerPolicy = { failureThreshold: 5, windowSeconds: 60, openSeconds: 120, quotaOpenSeconds: 1800, trialSeconds: 30, maxOpenSeconds: 1800 }`, replacing the literals in packages/ai/src/breaker.ts lines 15 to 27 (rule 2).
- **Tests.** The existing breaker tests run against both stores; exactly one concurrent trial passes; a trip survives a new process; a quota trip clears after a passing canary and not after the open key expires; the timings come from the seed.
- **Acceptance.** Two processes against one database see the same open breaker, and a quota trip set by one clears for both after one passing canary.
- **Effort and cost.** M. $0.

### P20-37 Hard stop as an operator setting, and the workspace day cap (P1, S to M)

From OD O22. Decision 8.

- **Change.**
  - `ops:global_hard_stop_usd`, read per pack where trigger/src/runtime.ts line 406 parses the env today. Precedence: the setting, then the env, then the seed. `spend-alerts.ts` `hardStopMicros` and its email copy follow.
  - Every value in `SPEND_CAPS` (packages/ai/src/caps.ts lines 17 to 25) moves into the seed and is injected into `SpendCaps` (rule 2): the `$50` alert and `$150` stop as `costCaps.globalDailyAlertMicros` and `globalDailyHardStopMicros` (models.ts line 218), the per image asset, per video asset and per pack values read from the existing `costCaps.imageAssetMicros`, `videoAssetMicros` and the pack cap instead of duplicating them, and `workspaceDailyMultiplier` (3) as `costCaps.workspaceDailyMultiplier`. No cap literal stays in packages/ai.
  - Seed `costCaps.workspaceExpectedDailyMicrosByTier` for every tier, free included. The payload carries the tier's value, and `{ capKind: "workspace_day", ... }` joins the cap lists at live-runtime.ts lines 1035 and 1210 and pipeline-runner.ts line 310, plus the preflight and brand palette calls.
  - createJob refuses a new pack once the workspace is at its cap; API v1 answers with the copy and MCP with a new `workspace_day_cap` row this item adds to P19-14's `lib/api-v1/mcp-copy.ts` (boundary table).
  - P20-47 alerts the founder when a workspace hits its cap.
- **Copy.** Web and API v1: "This workspace reached its daily limit. It resets tomorrow, or email hello@curvi.ai." MCP row: "This workspace reached its daily limit for new packs. It resets tomorrow. Nothing was charged."
- **Tests.** Precedence; the wiring at each call site; the seed covers every tier; no numeric cap literal in packages/ai/src/caps.ts; the MCP row passes P19-14's lint; copy lint.
- **Acceptance.** With `ops:global_hard_stop_usd` set below today's spend, the next pack refuses before any hold; a workspace past its day cap refuses on the web, API v1 and MCP with the copy above, and the founder gets one alert.
- **Effort and cost.** S to M. $0.

### P20-38 One tick cron and a real weekly report (P1, M)

From OD O25 and O26. Extends P18-02.

- **Change.**
  - `CRON_JOBS` (lib/cron-health.ts) becomes a registry `{ name, every | dailyAtUtc | weeklyAt, run(ctx) }`. New `app/api/cron/tick/route.ts` (CRON_SECRET) runs each job that is due by its last success within a time budget and records success per job.
  - **No overlap, through a lease row.** The app connects through Supabase's transaction mode pooler (services/db.ts line 182), where a session level `pg_try_advisory_lock` can stay held on a pooled backend or be released on another one. So the tick claims a lease row `platform_settings` `tick:lease` (`{ holder, expiresAt }`) with one conditional `UPDATE ... WHERE expiresAt < now()` (expiry = the time budget plus a margin), and releases it at the end. When the lease is held by another tick for longer than `tick.leaseStuckMinutes` (seed 30), the route answers 503, so the cron's `curl --fail` fails and the cron pings healthchecks.io `/fail` instead of the success URL.
  - Jobs: stale-jobs (10 minutes), recovery (10), billing-reconcile (30, P20-02), provider-canary (P20-16), PHASE_18's provider-balance and lifecycle (10), ops-alerts (10, P20-47), renewal-notices (daily, P20-07), retention (daily, P20-39), purge-source-media (daily), r2-legacy-sweep (daily, P20-40), visits salt cleanup (daily, from `site-visitors`), Upstash keep alive (daily, P20-51), and funnel-digest (Mondays 13:00 UTC, P18-02).
  - The old routes stay as thin wrappers until the founder deletes the two dashboard crons. One Render cron `curvi-tick` every 10 minutes on the P20-10 image runs `curl --fail` to the tick, then the healthchecks.io ping (success or `/fail` by the exit code). Cron services stay two (tick and backup).
  - **Weekly report, one email, one send path.** A `DbMetricsReader` in `apps/web/src/lib/ops/weekly-report.ts`, next to P18-02's funnel-digest route (trigger cannot import apps/web, which depends on `@curvi/trigger`), adds a "Money" section (MRR from active subscriptions times seed prices, churn, top ups, COGS from `cogs_micros`, gross margin from P20-04's math in packages/pipeline) and an "Operations" section (packs started, done and failed, failure and needs review rates, median duration and the longest queue wait, alerts opened, backup and drill age, spend against caps, LLM spend, database size and total R2 storage) to P18-02's weekly email, sent through `sendFounderEmail` to `FOUNDER_ALERT_EMAIL`. A "Triggers" section lists each P2 volume trigger (a second instance, a queue wait over 10 minutes, a team request, a workspace near a list limit, 100 paid packs a month for P20-48) and decision 11's points (first paying customer, database past 300 MB), marking any that fired. `DemoMetricsReader` stays for tests only. No `METRICS_DIGEST_TO`: P20-18 removes digest.ts's own sender.
- **Seed.** `operations.ts` `tick = { budgetSeconds: 240, leaseStuckMinutes: 30 }`.
- **Tests.** Due calculation; the lease (two overlapping ticks: one runs, one skips; an expired lease is taken over; a lease stuck past the threshold answers 503) on a pooled connection; partial failure; the report sections on PGlite fixtures; one weekly email per ISO week.
- **Acceptance.** `curvi-tick` runs every 10 minutes with its healthchecks.io check up, each registered job shows a recent success in health, and the next Monday brings one weekly email with the Money, Operations and Triggers sections.
- **Effort and cost.** M. $0 net: one tick service replaces two dashboard crons.

### P20-39 Table retention (P1, M)

From OD O11. Decision 21.

- **Change.** `apps/web/src/lib/ops/retention.ts`: batched deletes (5,000 rows a batch, 20 second budget, dry run, a report), windows from new seed `packages/pipeline/src/seed/data-retention.ts` (the existing `retention.ts` seed is about cancel offers):
  - `events` 180 days, except: `billing:email:%` rows (P20-07's billing email records) kept `renewalNotices.consentRecordYears`; other `billing:%` rows 400 days; `funnel.%` rows never by this job, because PHASE_18's write once `funnel.first_%` rows (`events_funnel_first_uq`) would otherwise be written again by a later event and the weekly email's "since 2026-10-01" totals would shrink.
  - `ops_audit` 400 days (principle 9; the audit trail is not in `events`).
  - `job_steps` of finished jobs 180 days.
  - `spend_cap_counters`: `caps:asset:%` and `caps:pack:%` 14 days; `caps:workspace:%`, `caps:global:%`, `caps:alert:%` (packages/ai/src/caps.ts line 173) and `alerts:%` 90 days; `preview:%` (P18-12's daily counters) 30 days; `csp|%` (P20-53's daily counts) 90 days; `llm|%` 400 days; any other key family 90 days, with a test that lists every prefix the code writes so a new family gets a window on purpose.
  - `site_visits` 400 days; `upload_preflights` 30 days; resolved `ops_alerts` 180 days; expired `breaker_state` 1 day once P20-36 ships; P18-06 `email_sends` of billing notices kept for `renewalNotices.consentRecordYears`; `billing_consents` never by this job.
  - Retention indexes on `events(at)`, `spend_cap_counters(updated_at)` and `upload_preflights(updated_at)` (migration `retention_indexes`, lane 10). Database size and top tables feed P20-15 and P20-45.
- **Tests.** PGlite fixtures for each window; billing rows, `billing:email:%` rows and `funnel.first_%` rows survive past 180 days; every counter prefix the code writes has a window; dry run deletes nothing.
- **Acceptance.** A dry run against production lists the rows each window would delete and no `funnel.%`, `billing:%` or `ops_audit` row under its window; the first real run stays inside its time budget.
- **Effort and cost.** M. $0.

### P20-40 Temporary R2 objects under tmp/ with a lifecycle rule (P1, M)

From OD O12.

- **Change.** New temporary writes go under `tmp/ws/{id}/...`: the cutout cache (trigger/src/cutout-cache.ts line 45), the preflight preview (lib/preflight/service.ts line 62), the carousel layer (trigger/src/live-runtime.ts line 1930), the run handoff (trigger/src/pipeline-runner.ts line 909) and P20-64's checkpoints. Both object-keys.ts files gain `isWorkspaceTmpKey`; readers accept old keys during rollout, and a cache miss only recomputes. lib/trust/account.ts line 263 also deletes `tmp/ws/{id}/`. P18-12's preview claim copies into the new cutout cache path. A daily tick job sweeps legacy temporary objects older than 7 days under the old prefixes with the cursor pattern of lib/trust/purge.ts, and is removed once a run finds nothing.
- **One lifecycle file for the whole bucket.** Applying an R2 lifecycle configuration replaces every rule on the bucket, so `ops/r2/lifecycle.json` holds all of them: PHASE_18's `anon/` rule (2 days, P18-12's free previews) and `tmp/` (7 days; deletion usually within a day after, V-data section 11). A rule added later goes into this file, never only in the dashboard.
- **Seed.** `data-retention.ts` `tmpObjectDays` 7 (the privacy copy reads it); the `anon/` window reads P18-12's seed value.
- **Tests.** Key builders; readers accept both prefixes; account deletion covers `tmp/`; the sweep cursor; the lifecycle file has exactly one rule per seeded prefix and its days equal both seeds.
- **Acceptance.** After the founder applies the file, the bucket's lifecycle shows both the `anon/` and `tmp/` rules, and a new cutout lands under `tmp/ws/`.
- **Effort and cost.** M. Lowers storage.
- **Founder.** Apply the lifecycle file (both rules at once).

## W6. Pack experience

### P20-41 Make another version of a delivered scene (P1, M)

From CD P20-19. Decision 7.

- **Change.** Follow up reason `regenerate` in trigger/src/follow-up.ts (line 52) and `regenerateShot(workspaceId, jobId, shotId, note?)` in the db and demo services; route `api/jobs/[id]/shots/[shotId]/regenerate` with the retry route's guards. Eligible: delivered `composite_generate` scenes; carousels and marketplace mains are not. The run produces the next version number (`expandVariations` naming) with `picked` false, so it never takes a channel slot, and the seller ships it with the existing picker. An optional note of up to 120 characters goes through `wrapUserDescription` and the rule 9 lint; if the runner needs a recipe change to accept it, ship without the note. Rule 3 holds because the run uses the same `runShot`, composite step and fidelity gate, placing the real cutout of the source photo, never a cut from the delivered image.
- **Only while the source exists.** The 30 day purge deletes a product's source photos and their masks (lib/trust/purge.ts lines 1 to 12 and 31), and the cutout cache is keyed by the source bytes and expires after 7 days under `tmp/` (P20-40). So regenerate (and P20-62's Adjust) is offered only while the job's source media row exists; the button is hidden otherwise and the route refuses. A regenerate counts as use: the purge treats a follow up started in the last 30 days like a new pack, so the source stays while the seller is still working on it. When the cutout cache has expired, the run makes a fresh cutout from the source photo and the price includes it (`creditCosts` for the cutout, shown in the estimate).
- **Seed.** `followUpPricing.regenerateFreePerShot` 0; the price is the shot's seed price, plus the cutout's when the cache has expired, charged only if the new version passes; the cap reuses `variationOptions.max` (4).
- **Copy.** "Make another version"; "Want something different? Describe it in a few words (optional)."; "About {n} credits. You are charged only if the new version passes its checks."; "New version ready. Pick the one you want to ship."; refused: "The original photo for this pack was deleted after {source} days, so we cannot make another version from it. Start a new pack with the photo to make more."
- **Tests.** Eligibility; the version number; charged only on pass; the cap; a pack whose source media was purged hides the action and the route refuses with the copy; an expired cutout cache recuts from the source and prices the cutout; a regenerate keeps the source from the next purge; a rule 3 test.
- **Acceptance.** On a delivered pack, "Make another version" produces a new unpicked version that the seller can pick and ship, charged only when it passes; on a pack older than the purge window it is not offered.
- **Effort and cost.** M. One generative still plus QC, paid by the customer's credits.

### P20-42 Pack fixes customers can see (a to e) (P1, M)

From CD P20-21 a to e.

- a. **Empty plan guard.** Submit is disabled when the plan has nothing to make, and createJob (also used by API v1 and MCP) refuses with `empty_plan` before `reserve_credits`. Copy: "This set has nothing to make for the channels you picked. Pick a bigger set or add a marketplace." MCP gets a new `empty_plan` row in P19-14's `lib/api-v1/mcp-copy.ts` (boundary table): "These choices make no images for the channels picked, so no pack was started. Pick more channels or a bigger set. Nothing was charged."
- b. **All files zip.** Include `ads/ads.csv` and drop the "-2" suffix on picked versions (apps/web/src/lib/pack-zip.ts, reusing the packager's `ADS_CSV_NAME` and CSV builder).
- c. **Compliance report.** Built from the picked versions when it is read (apps/web/src/lib/compliance-report.ts), so the PDF follows the pick.
- d. **Carousels.** A retry of a single slide is refused and "Run the whole carousel again" is offered.
- e. **Shot planner.** A new version names Etsy, eBay, Walmart, TikTok Shop and Pinterest, with its own prompt constant, after whatever version production serves (P18-09 part 3 adds v4; this is the next one). `trafficPct` 0, `pnpm eval` with the prompt-eval agent, then canary 10, 50 and 100 percent, keeping the seed's `trafficPct` in step with production (P20-22).
- **Tests.** Each fix; the `empty_plan` refusal on the web, API v1 and MCP with no hold; the MCP row passes P19-14's lint; the seed test that older prompt versions are byte for byte unchanged.
- **Acceptance.** An empty plan cannot be submitted or started through any surface; the all files zip holds `ads/ads.csv` and the picked names without "-2"; the compliance PDF matches the pick; the new planner version passes `pnpm eval` before its canary.
- **Effort and cost.** M. Small eval spend.

### P20-43 Products page and library paging (P2, M; triggered)

From CD P20-22. Moved to P2 by the review. Trigger: the weekly report shows a workspace with more than 30 products or more than 100 library images (the library loads at most 120, lib/library.ts line 51).

- **Change.** Products: search by title or SKU (`?q=`), thumbnails (the latest pack's main image, else the first source photo while it exists), rename up to 120 characters (owners, admins, editors), archive and restore (archived products leave the list and pickers, their packs stay), 30 per page with a cursor. Library (lib/library.ts line 51): channel, shot type and favorite filters in SQL with a cursor on `(created_at, id)`, 60 per page, "Show more". Migration `products_archive`: `products.archived_at` and an index on `(workspace_id, archived_at, created_at desc)`.
- **Copy.** "Archived products keep their packs and files. Restore one any time."
- **Tests.** RLS test for the column (members read, editors write through the server only); paging; filters.
- **Acceptance.** A workspace with 150 library images pages through all of them with "Show more", and an archived product leaves the list and the pickers while its packs stay.
- **Effort and cost.** M. $0.

### P20-44 Mobile app menu and accessibility (P1, M)

From CD P20-27 (the error pages moved to P20-14).

- **Change.** Below `md` the header shows the wordmark, the balance and a "Menu" button with grouped links (Connected apps, Help and Contact us included); Escape closes it and focus returns to the button. On desktop, Gallery and Free tools move into "More", so the row never wraps at 1024 px (app-nav.tsx line 23). A "Skip to content" link. The "ahead" stage (job-progress-board.tsx line 83) passes 4.5 to 1. No text is smaller than 12 px in the app or on the public gallery page, whose four `text-[10px]` captions ((marketing)/gallery/page.tsx lines 31, 38, 111 and 117) are the only ones in the code. `@axe-core/playwright` (rule 7 for the version) on six key pages.
- **Tests.** Keyboard and focus tests for the menu; axe with no serious violations; a mobile viewport e2e; a lint that no `text-[10px]` or `text-[11px]` class remains under apps/web/src.
- **Acceptance.** At 375 px wide every app page is usable through the menu with a keyboard, the desktop nav never wraps at 1024 px, and axe reports no serious violation on the six pages.
- **Effort and cost.** M. $0.

## W7. Founder cockpit

All pages live under /app/ops and use the `site-visitors` gate plus the second factor (P20-49). Queries live in the `apps/web/src/lib/ops/` directory, read only, on the owner connection. A boundary test checks that files in that directory are imported only from `app/app/ops/**`, `app/api/cron/**`, `app/api/ops/**` and `apps/web/scripts/**`; it does not cover `apps/web/src/lib/ops.ts` (the `isOperator` gate from `site-visitors`), which PHASE_18's gallery label and the app nav import. Pure math that trigger also needs lives in packages/pipeline (P20-04).

### P20-45 Ops overview and switches (P1, M)

From OD O28.

- **Change.** `app/app/ops/layout.tsx`: one operator gate with the second factor, noindex, and navigation to pages that exist: Overview (`/app/ops`), Jobs (`/app/ops/jobs`, P20-46), Gallery (`/app/ops/gallery`, P20-50's approval queue), Visitors (`/app/ops/visitors`, `site-visitors`), PHASE_18's Prospects and Funnel once merged, and Security (`/app/ops/security`, P20-49). Economics (`/app/ops/economics`) joins when P20-48 ships. Providers are a section of the overview, not a page. The app nav shows "Ops" to operators only. The overview shows status and its reasons, commit, uptime, memory and runner stats; the `ops:packs_paused`, `ops:acquisition_paused` and other switches; the hard stop editor; today's spend against the alert line and the stop; providers (breaker, reason, expiry, last probe or canary, balance) with Reset (which records a reset time that `restoreQuotaTrips` respects, as P20-16's `passedAt` does) and Probe now; a "Grant credits" form over P20-66's `grantCredits`; cron, backup and drill ages; open alerts; 24 hour pack counts with p50 and p95 duration; database size and the top tables. `app/app/ops/actions.ts` server actions each re-check `isOperator` and the second factor (P20-49) and write an `ops_audit` row (principle 9).
- **Tests.** Non operators get 404 on every page and action; an operator at `aal1` is sent to /app/ops/security; each action writes its `ops_audit` row; every nav entry resolves to a page.
- **Acceptance.** The founder, signed in with the second factor, flips `ops:packs_paused` on and off from the overview, a new pack is refused while it is on, and two `ops_audit` rows record it.
- **Effort and cost.** M. $0.

### P20-46 Jobs list and timeline (P1, M)

From OD O29 (PHASE_12 D3).

- **Change.** `/app/ops/jobs` with filters (failed, stuck, needs review, workspace). `/app/ops/jobs/[id]`: status, run key, restart count, heartbeat, COGS, credits; recipe variants, seller note and answers; source photo thumbnails (presigned for 5 minutes with the workspace guard); `job_steps` in order (stage, provider, attempt, status, cost, latency, error); assets with QC verdicts, pack files, ledger rows, the job's events, `packLlmSpend`, and a Sentry search link by `job_id`. Actions: Settle now and Requeue (P20-33), both with confirmation. Both refuse while the job's `heartbeat_at` is fresher than `orphan.staleHeartbeatMinutes`, because requeuing a pack whose runner is still alive would run it twice (its in flight provider calls still complete) and use up its restart; a "Force" checkbox overrides that, and the `ops_audit` row records `forced: true`.
- **Tests.** The timeline from fixtures; actions gated and audited; Requeue and Settle now refuse on a fresh heartbeat and work with Force, recording it.
- **Acceptance.** For a failed test pack the timeline shows every step with its provider, cost and error, and Requeue on a stale job runs it once.
- **Effort and cost.** M. $0.

### P20-47 Ops alert engine (P1, M)

From OD O06 (PHASE_12 D4).

- **Change.** `apps/web/src/lib/ops/alerts.ts`, evaluated each tick, with state in platform table `ops_alerts` (migration `ops_alerts_gallery`, lane 13; RLS on, no client policies, privileges revoked, `no_oauth_clients`; one open row per rule and subject; counts; last notified; a history of opened and resolved times). Rules from seed `opsAlertPolicy`: every failed pack while volume is low; a failure rate of 20 percent or more over 60 minutes with at least 5 finished packs (it cannot fire at today's volume, which is intended); a live job with a heartbeat older than 10 minutes, or the sweep reconciled anything; a queue wait over 10 minutes; `memory_high` on 3 ticks in a row; a cron, backup or drill overdue; `db_size_high`; a workspace at its day cap; signups per hour or withheld grants per day over a threshold; a new gallery submission (P20-50); "Not yet" feedback (absorbing P20-25); a shot type below `economics.minGrossMargin` (from P20-04's report math). Delivery: founder email and a Sentry message; the alert's history stays in `ops_alerts`, not in `events`. A resolved alert sends one line.
- **Tests.** Each rule against PGlite fixtures; dedupe; resolve; client roles cannot read or write `ops_alerts`.
- **Acceptance.** A failed test pack opens one alert and sends one email, a second failure on the same rule within the dedupe window sends none, and the alert resolves with one line once the rule clears.
- **Effort and cost.** M. $0.

### P20-48 Economics page (P2, S; triggered)

From OD O43. Moved to P2 by the review: P20-04's report gives the same table from the command line. Trigger: 100 paid packs a month in the weekly report.

- **Change.** `/app/ops/economics` from P20-04's library: per shot type the count, median and p90 cost, credits and margin, with rows below `economics.minGrossMargin` flagged; revenue per credit by tier from the seed; operator workspaces excluded.
- **Tests.** The page renders P20-04's numbers for a PGlite fixture; operator workspaces are excluded; a row under the floor is flagged; non operators get 404.
- **Acceptance.** The page and `pnpm report:unit-economics --days 30` show the same numbers for the same window.
- **Effort and cost.** S. $0.

### P20-49 Operator second factor and audit rows (P1, S)

From OD O31. Decision 22.

- **Change.**
  - `isOperator(user, aal)` requires `aal2` on the whole /app/ops layout and every ops action (Supabase TOTP), not only on mutations and photo pages: the operator pages show seller notes, answers, ledger rows, events, prospects and visitors. The only exception is `/app/ops/security` for the first enrollment.
  - `aal` is read on the server from verified claims (`getClaims()` or `getUser()`, rule 7 row), never from `getAuthenticatorAssuranceLevel()`, which decodes the session without verifying it.
  - Enrollment page `/app/ops/security` (`mfa.enroll({ factorType: "totp" })`, challenge, verify) works at `aal1` only while the operator has no verified factor; adding or removing a factor once one exists needs `aal2`. Every factor change emails the founder ("A sign in factor was added to the operator account {email}.").
  - Recovery runbook: removing a lost factor through the admin API (recovery codes are experimental, V-data section 4).
- **Tests.** `aal1` is refused on every ops page and action except the first enrollment; enrollment at `aal1` is refused once a verified factor exists; a forged session claiming `aal2` without a verified token is refused; a factor change emails the founder; audit rows are written.
- **Acceptance.** Signed in with the password only, the founder can open nothing under /app/ops but the enrollment page; after verifying a code, every page and action works.
- **Effort and cost.** S. $0.
- **Founder.** Enroll.

### P20-50 Gallery approval queue (P1, S)

From OD O32. Decision 23. Extends P18-14.

- **Change.**
  - Migration `ops_alerts_gallery` (lane 13): `gallery_items.review_status` (`pending`, `approved`, `rejected`, default `pending`), `reviewed_at`, `reviewed_by`; existing published rows become approved. The anonymous read policy requires `published` and `review_status = 'approved'`.
  - **The owner connection queries too.** The public gallery and share pages read over the owner connection, which bypasses RLS (apps/web/src/lib/shares/db-store.ts lines 2 to 4), so the policy alone would leave pending and rejected items public. `loadGallery` (line 431) adds `review_status = 'approved'`; the share page's `inGallery` (line 174) is true only for approved rows, so a pending item stays noindex; P18-14's sitemap query built from `listGallery` gets the same filter; and opting in (line 256) writes `review_status = 'pending'` instead of going public at once.
  - A queue at `/app/ops/gallery` with Approve and Reject; each clears the in process gallery cache (`galleryCacheFor`, db-store.ts line 407) and writes an `ops_audit` row. A P20-47 alert on each new submission.
- **Tests.** Anonymous visitors see approved rows only (rule 5 update to the gallery RLS tests); through `DbShareStore`: a pending and a rejected item are absent from `listGallery` and the sitemap and their share pages are noindex; approving clears the cache; an e2e that /gallery never renders a pending or rejected item.
- **Acceptance.** A seller opts a pack into the gallery; it does not appear on /gallery or in the sitemap until the founder approves it, and appears within one cache period after.
- **Effort and cost.** S. $0.

## W8. Security and delivery

### P20-51 Shared rate limits on Upstash and a trusted client IP (P1, XS to S)

From OD O35. Decision 15. Extends P19-21.

- **Change.** Upstash Free in `us-west-2`; lib/rate-limit.ts already supports it (line 175) and already falls back to the in process counter when Upstash throws (`FallbackRateLimitStore`, lines 150 to 167), so this item adds no fail open code. What it adds:
  - A daily tick job touches Redis so a quiet month does not archive the database.
  - New `CLIENT_IP_HEADER`: `clientIp()` reads only that header (the rightmost trusted entry for `x-forwarded-for`); callers P19-21 marks `ipExempt` skip IP rules as before.
  - **The direct Render origin.** The service is also reachable at its `*.onrender.com` host, which bypasses any Cloudflare proxy, so `cf-connecting-ip` sent to that host is forgeable. The header is trusted only when the request came through Cloudflare, proven by a secret header that a Cloudflare Transform Rule adds (`CLIENT_IP_PROXY_SECRET`); without it, the IP falls back to Render's own forwarded entry. API and anonymous spend requests whose Host is not the custom domain are refused.
  - To choose the header, the authorized health details show IP candidates truncated to /24; the founder sends forged headers from outside to both `curvi.ai` and the `onrender.com` host and compares, which closes docs/verification.md "Still unverified" item 2.
- **Tests.** Forged headers are ignored on both hosts; `cf-connecting-ip` without the proxy secret is not trusted; a spend request on the `onrender.com` host is refused; exempt callers unchanged; the keep alive job runs daily.
- **Acceptance.** From outside, a request to either host with a forged `cf-connecting-ip` and `x-forwarded-for` is limited by the real IP, and two instances share one counter in Upstash.
- **Effort and cost.** XS to S. $0.

### P20-52 Security checks in CI (P1, S)

From OD O36.

- **Change.** `.github/dependabot.yml` (npm and github-actions, weekly, grouped). ci.yml gains `pnpm audit --prod --audit-level=high` and a gitleaks step using the MIT gitleaks CLI at a pinned version (the Action is EULA software that cannot be modified, V-ops section 5), both `continue-on-error` at first. With auto deploy off (P20-19) a failing check no longer holds a deploy by itself; the release script requires CI green. P2: pin actions to SHAs.
- **Tests.** A workflow lint (actionlint or the YAML schema check already in CI) passes on the changed workflow; gitleaks runs clean on the current tree with the repo's allowlist.
- **Acceptance.** A pull request shows the audit and gitleaks steps, and Dependabot opens its first grouped update.
- **Founder.** Turn on CodeQL default setup, Dependabot alerts and security updates, and private vulnerability reporting (secret scanning and push protection are already on).
- **Effort and cost.** S. $0.

### P20-53 Enforced CSP (P1, S; nonces on /app are P2, M)

From OD O37.

- **Change.** Phase 1 (P1): enforce today's policy (next.config.ts line 100 switches from `Content-Security-Policy-Report-Only`) plus Turnstile, the Sentry tunnel and PHASE_19's `form-action https://chatgpt.com`; keep a stricter report only policy on /app (no `'unsafe-inline'`, a nonce) to collect data; the csp-report route aggregates counts per `csp|day|directive|host` through `PgCapStore.addMany` (P20-39 keeps them 90 days), shown in the cockpit. Gate: 7 days with no unexpected first party violations. Phase 2 (P2): nonces from middleware on /app (those pages already render dynamically); marketing pages stay static and out of the nonce work.
- **Tests.** security-headers.test.ts for both policies; the report route aggregates by day, directive and host.
- **Acceptance.** Production sends the enforced header, Turnstile, the Sentry tunnel and the consent form action still work, and the cockpit shows 7 days of report counts with no unexpected first party violation.
- **Effort and cost.** S, then M for phase 2. $0.

### P20-54 Free staging stack (P1, S plus founder S)

From OD O41. Decision 16.

- **Change.** A second Supabase Free project in a separate free organization (so it never counts against production's organization or gets billed compute if decision 11 moves production to Pro), an R2 bucket `curvi-staging`, and a free Render web service that deploys main after CI at concurrency 1 (verify the free instance type). Stripe test keys and Turnstile test keys; `NEXT_PUBLIC_ENV_LABEL=staging` shows a thin banner, adds noindex and makes a test Stripe key valid there (P20-01). It is never a restore target (P20-11): it is public, auto deployed and runs real provider keys. The daily smoke probably keeps the Free project from pausing (Supabase does not define inactivity, V-data section 1). New docs/ops/STAGING.md.
- **Tests.** The env label banner and noindex render only with `NEXT_PUBLIC_ENV_LABEL` set; P20-01's readiness opens checkout with a test key on staging.
- **Acceptance.** Staging deploys main after CI, shows the banner, and a test card purchase on it grants credits through its own webhook.
- **Effort and cost.** S. $0 (R2's free tier is shared with production, P20-10).

### P20-55 Real stack smoke (P1, M)

From OD O42. Decision 19.

- **Change.** `playwright.smoke.config.ts` (no web server, `SMOKE_BASE_URL`) and `e2e/smoke/*`. Turnstile treats Playwright as a bot and the production secret rejects dummy tokens (V-ops section 6), so sign in runs only where the test keys work:
  - **Staging smoke:** health status and commit; key marketing pages; a smoke user sign in (staging's own Supabase project with Turnstile test keys); the cheapest real pack (main image only, one channel), polled until done, then the zip downloaded and checked for a white main image at the right size; MCP `initialize`.
  - **Production light smoke** (run by `pnpm release`): health status and commit, key marketing pages, `/api/status` and MCP `initialize`. No sign in and no pack.
  - **Daily synthetic production pack** (decision 19): no browser; an API v1 call with a key of the operator workspace that every metric excludes (comped on Growth by SQL for API access, kept in GitHub secrets as `SMOKE_API_KEY`), main image only, polled until done.
  - `.github/workflows/smoke.yml` on dispatch, daily and from the release script.
- **Tests.** The smoke specs run against the demo build in CI with `SMOKE_BASE_URL` pointed at it (sign in and the pack skipped there); the production config contains no sign in step.
- **Acceptance.** The staging smoke and the production light smoke pass on the same SHA, and the synthetic pack has run daily for a week with its spend excluded from every metric.
- **Effort and cost.** M. About $1.20 a month (the staging pack and the synthetic production pack, about $0.02 each a day).

### P20-56 Disaster recovery runbook (P1, S)

From OD O40.

- **Change.** docs/ops/DISASTER_RECOVERY.md: every external setting needed to rebuild (Render services and env; Supabase Auth site URL, redirects, SMTP, templates, CAPTCHA, MFA, PHASE_19's OAuth server, clients and access token hook; R2 buckets, CORS, the lifecycle file, locks and tokens; Stripe products, prices, portal configurations and webhook; Resend DNS; DNS records; PostHog, Sentry and the monitors; provider accounts and their limits; GitHub settings), then the ordered rebuild steps with P20-11's restore. The schema always comes from `pnpm db:migrate`, never from the dump, and only the data is restored (`pg_restore --data-only`), because the dump carries no grants (P20-10); the runbook ends with P20-11's ACL and grant check against a fresh migrate before any app instance connects.
- **Tests.** A docs test that every service and cron in render.yaml and every variable in the LAUNCH_CHECKLIST table is named in the runbook.
- **Acceptance.** The founder walks the runbook once against the local drill stack (P20-11) and every step resolves to a setting that exists.
- **Effort and cost.** S. $0.

### P20-57 Structured logs with request and job ids (P2, M; triggered)

From OD O03. Moved to P2 by the review. Trigger: a second instance, or a support case the current logs and Sentry could not answer.

- **Change.** Workspace package `packages/observability`: `log.info|warn|error(event, fields)` as JSON lines, an AsyncLocalStorage context `{ requestId, jobId, workspaceId, runKey, cron }`, and a Sentry tag bridge. A light middleware branch for `/api/:path*` (not /api/health and not `/monitoring`, no Supabase call) sets `x-request-id` from Render's `Rndr-Id` when present (unverified on Hobby), else `x-request-id`, else a new id, and echoes it. enqueue.ts runs each pack inside the job context. Convert about 80 calls on the job path. ESLint `no-console: warn` for apps/web/src/lib and trigger/src outside tests and the logger. Redaction keeps PHASE_19's rules and reads P20-13's `TOKEN_PATH_PREFIXES`.
- **Tests.** The context survives `after()`; log lines carry `job_id`; no token from `TOKEN_PATH_PREFIXES` in a log line; the matcher still excludes /api/health and /monitoring.
- **Acceptance.** For one production pack, every log line on its path carries its `job_id`, and one request id ties the API call to its log lines and its Sentry event.
- **Effort and cost.** M. $0.

### P20-58 Docs refresh (P1, S)

From OD O44.

- **Change.** docs/PENDING.md shows the real production state (it still says "Nothing in this file is built yet", line 5) and drops the Trigger.dev worker steps; PHASE_16 and PHASE_17 status sections; docs/LAUNCH_CHECKLIST.md (the tick, backups, release, staging); docs/STRIPE_SETUP.md sections 5 and 6 if P20-06 and P20-07 have not already changed them (Switch plan off in the default portal configuration, per tier upgrade configurations, renewal reminders off); new docs/ops/ (RUNBOOK, ALERTS, BACKUP_RESTORE, DISASTER_RECOVERY, STAGING); this phase's docs/verification.md rows. CLAUDE.md edits only with the founder's approval (decision 29).
- **Tests.** A docs test that docs/STRIPE_SETUP.md no longer tells the founder to turn renewal reminders or Switch plan on, and that every docs/ops file named here exists.
- **Acceptance.** docs/PENDING.md and docs/LAUNCH_CHECKLIST.md describe production as it runs after Release 4, with no Trigger.dev worker step.
- **Effort and cost.** S. $0.

## W9. Teams

### P20-59 Member emails, billing roles, invites and a workspace switcher (P1 part S; P2 part L, triggered)

From CD P20-26. Decision 27. Split by the review: the P1 part fixes what is wrong today; invites and the switcher wait for the first team. Trigger for the P2 part: the first request to add a teammate, or an Agency style request (Agency is off self serve, P20-08).

- **Change, P1 part (Release 4).**
  - Names: `listMembers` joins the user's email from `auth.users` over the owner connection (lib/services/db.ts line 2991).
  - Billing roles (decision 27): `canManageBilling` (apps/web/src/lib/billing/access.ts) allows owners and admins only; the checkout route (line 75), the portal route (line 34), the cancel flow and its route, and P20-09's invoices all use it. `BILLING_FORBIDDEN_NOTICE` becomes "Only the workspace owner or an admin can change billing."
  - Default workspace: the oldest membership where the user is owner, then the oldest membership (`members.created_at`), which fixes `members.findFirst` with no ordering at line 542.
- **Change, P2 part (when triggered).**
  - Invites: owners and admins send and revoke. Tokens are 32 random bytes, stored as sha256, valid for `teamLimits.inviteTtlDays`, emailed through P18-06 `sendEmail` (transactional, so bounce and complaint suppression applies). Abuse limits: at most `teamLimits.invitesPerWorkspacePerDay` sends (seed 10) counting resends, and open invites count against `maxMembersPerWorkspace` together with members, so a free account cannot use invites to mail strangers. `/invite/{token}` asks the visitor to sign in or sign up, then joins only if the signed in email matches the invite and `email_confirmed_at` is set.
  - Roles: owners change roles and remove members; the last owner can never be removed. A removed member loses MCP access at once, because PHASE_19 re-reads the membership on every call.
  - Switcher: an httpOnly `curvi_ws` cookie names the workspace and is used only when the user is a member; otherwise the P1 default. The header menu reuses PHASE_19's `listMemberships` and picker. The cookie never changes an MCP connection's workspace (PHASE_19 decision 18).
- **Schema (P2 part).** Migration `workspace_invites`: tenant table `workspace_invites` (`workspace_id` with cascade, `email_key` from `normalized_email_key`, `role` checked to admin, editor or client, unique `token_hash`, `expires_at`, `accepted_at`, `revoked_at`, `invited_by`); a unique partial index for open invites per (workspace, email); RLS select for owners and admins only; no client writes; `no_oauth_clients`. Test `packages/db/src/workspace-invites.test.ts`.
- **Seed.** `teamLimits = { maxMembersPerWorkspace: 10, inviteTtlDays: 7, invitesPerWorkspacePerDay: 10 }`.
- **Copy.** "Invite a teammate"; "Invite sent to {email}. The link works for {inviteTtlDays} days." (rendered from the seed); "This invite was sent to {masked email}. Log in with that email to join."; role help "Owner can do everything. Admin manages billing, the team and packs. Editor makes packs. Client can view packs and download files."
- **Tests.** P1: member emails; an editor and a client get the billing notice from checkout, the portal and cancel, while an owner and an admin pass; the default workspace order. P2: token hashing and expiry; email match; an unconfirmed email cannot accept; the daily send limit; open invites count toward the cap; the last owner rule; switcher defaults; RLS.
- **Acceptance.** P1: the settings page lists members by email, and an editor cannot open checkout or the portal. P2: an owner invites a teammate who signs up with that email, confirms it and lands in the workspace as an editor.
- **Effort and cost.** S for the P1 part, L for the P2 part. $0.
- **Not in this phase.** Client workspaces with a shared credit pool, client review links and white label pages (PHASE_21).

## B5. Optional growth (P2)

Each item waits for Release 4 to pass its gate, and for the condition in its line. The P2 items moved here by volume triggers (P20-35's P2 part, P20-36, P20-43, P20-48, P20-57 and P20-59's P2 part) keep their place in their workstreams above and wait for their own trigger instead.

### P20-60 Same pack for several products, with the new pack form split (P2, L)

From CD P20-23 and P20-28. Decision 32. Needs P20-35's fairness (its P2 part ships first).

- **Change.** "Use these choices for more products" from a finished pack or the form; up to `batchLimits.maxProducts` photos, one per product, options from `getReusePrefill`; the question step is skipped and an unclear target gets a "Pick the product" step. `POST /api/batches` checks the total estimate against the balance, then calls `Services.createJob` once per photo with idempotency key `batch:{id}:{index}`. A batch page offers "Download everything". The 1,795 line new-pack-form.tsx is split into a reducer hook and a component per step, with a snapshot test proving the request body is unchanged. Migration `pack_batches`: tenant table `pack_batches` (RLS, `no_oauth_clients`, test) and `generation_jobs.batch_id`. Redundant `force-dynamic` is removed only where a before and after time to first byte measurement shows a gain.
- **Copy.** "Add up to {maxProducts} product photos. Each one gets its own pack." (from `batchLimits.maxProducts`) / "About {n} credits for all {k} packs. You have {b}."
- **Tests.** The batch estimate against the balance; one job per photo with its idempotency key (a retried request creates none twice); the reducer snapshot keeps the request body unchanged; RLS for `pack_batches`; a rule 3 test that each batch pack's main image passes `fidelityReport`.
- **Acceptance.** A seller starts packs for three products from one finished pack's choices, the packs run one at a time for that workspace, and "Download everything" returns all three packs.
- **Effort and cost.** L. Paid by credits.

### P20-61 Listing text (P2, M)

From CD P20-24. Decision 30.

- **Change.** Seed recipe `listing_copy` v1 (gpt-6-luna, then gpt-6.1-sol, then Claude last; low effort; `llmJson` with metering, caps and failover); alt text per file plus a title and up to 5 bullets per marketplace; limits in the registry's `textLimits` after rule 7 checks; the `applyAplusCopy` guards (rule 9 lint, no figures or claims the seller did not type). Output `listing-text.csv` in every zip and a "Listing text" card with copy buttons. Migration `pack_batches` also adds `generation_jobs.listing_copy jsonb` (object check). `creditCosts.listingText` 0; a "Listing text" extra switch, on by default. `pnpm eval` before the canary.
- **Tests.** Text limits per marketplace; the rule 9 lint and the no new claims guard on fixture outputs; the CSV in the zip; metering and failover through packages/ai; the switch off makes no call.
- **Acceptance.** `pnpm eval` passes for `listing_copy` v1, and a canary pack's zip holds `listing-text.csv` within every marketplace's limits.
- **Effort and cost.** M. About $0.002 a pack.

### P20-62 Adjust a delivered image (P2, M)

From CD P20-25.

- **Change.** A deterministic re-render of deterministic and template shots only: background color (seed swatches; disabled where the spec requires white), product size (within the registry's fill limits) and shadow. Follow up reason `adjust` in trigger/src/follow-up.ts, `adjustShot` in apps/web/src/lib/services/db.ts and demo.ts, route `apps/web/src/app/api/jobs/[id]/shots/[shotId]/adjust/route.ts` with the retry route's guards, and an "Adjust" panel in the job view. A new version, charged at `creditCosts.deterministic`. Same source rule as P20-41: offered only while the source media row exists. Rule 3 holds through `placeOnBackground` (packages/pipeline/src/deterministic/whiten.ts) and the fidelity gate (packages/pipeline/src/qc/fidelity.ts).
- **Tests.** Each control within its limits; white locked where the spec requires it; the version number and the charge; a purged source refuses; a rule 3 test that the product pixels inside the mask equal the source cutout's.
- **Acceptance.** A seller changes a template shot's background and product size and ships the new version; its fidelity report passes.
- **Effort and cost.** M. Paid by credits.

### P20-63 Optional two step sign in for customers (P2, M)

From CD P20-18. Decision 31.

- **Change.** Settings: a new `components/app/two-step-card.tsx` on apps/web/src/app/app/settings/page.tsx to enroll with a QR code, verify and remove (`apps/web/src/lib/auth/mfa.ts` over Supabase TOTP, removal at `aal2` only); login asks for the code when the account has a verified factor (a code step in components/marketing/auth-form.tsx, using P20-49's verified claims check). Never required, so the PHASE_19 reviewer account keeps working with a password only.
- **Tests.** Enroll, verify and remove (remove refused at `aal1`); sign in asks for the code only for an account with a factor; a wrong code is refused with plain copy; the reviewer style password only account still signs in with no code step.
- **Acceptance.** A seller enrolls from settings, signs out, signs in with the password and a code, then removes the factor; the reviewer account signs in with its password only.
- **Effort and cost.** M. $0.

### P20-64 Shot level checkpoint resume (P2, L)

From OD O18.

- **Change.** At `plan_ready`, write `generation_jobs.checkpoint` `{ v, profile, plan, skipped, plannerSource, payloadHash }` (migration `job_checkpoint`). After each shot, `serializeShotOutcome(..., { handoff, inlineChars: 0 })` goes under `tmp/ws/{ws}/jobs/{job}/checkpoint/`. A requeued run with a matching hash skips intake, analysis and planning and restores finished shots with `deserializeShotOutcome` (workspace key guard). Splitting "derive the shot context from payload and inventory" out of the runner is the L part. `DbJobStore` today persists neither plans nor passed pixels before `savePack` (OD correction 2), which is why this waits.
- **Tests.** After an interrupt at k shots, providers are called only for the rest; files and charges match an uninterrupted run; rule 3 holds.
- **Acceptance.** A deploy during a six shot pack resumes it without calling providers again for the shots already finished.
- **Effort and cost.** L. $0.

### P20-65 Pack fixes f to h (P2, M)

From CD P20-21 f to h. Needs golden photos (and fal funded).

- **Change.** f: the already white path honors the seller's target product (packages/pipeline/src/treatment.ts). g: a pure white check after encoding for TikTok Shop and Google mains (packages/pipeline/src/qc/pixelChecks.ts, run on the encoded bytes in trigger/src/pipeline-runner.ts), with P18-09's background switch (packages/pipeline/src/output-options.ts) and the PNG escape. h: the scene count is honored on the LLM plan path (trigger/src/pipeline-runner.ts and packages/pipeline/src/planner/).
- **Tests.** f: a fixture with a white background and two products keeps the target; g: an encoded main with near white JPEG noise fails the check and the PNG escape passes, and a rule 3 test that the escape re-encodes without touching product pixels inside the mask; h: the LLM plan path returns the requested scene count.
- **Acceptance.** On the golden photos, every TikTok Shop and Google main passes the pure white check after encoding, and a pack asking for 3 scenes gets 3.
- **Effort and cost.** M. Small eval spend.

## Data model summary

Migrations are named, never numbered (principle 10), one per lane. Each takes the next free number when its lane runs `pnpm db:generate` after rebasing on the newest main, after 0026, `0027_site_visits`, PHASE_18's named migrations and PHASE_19's (Release 2's may come before PHASE_18's if those have not landed). Every new table carries the `no_oauth_clients` restrictive policy.

| Migration (name) | Release, lane | Items | Change | Kind | RLS and test |
| --- | --- | --- | --- | --- | --- |
| `billing_terms` | 2, lane 2 | P20-05, P20-07 | `credit_ledger.expires_at` set to null where `reason = 'topup'`; `subscriptions.cadence`; new `billing_consents` | Column, data, tenant table | Members read `cadence` and cannot write; `billing_consents` owners and admins read, no client writes. packages/db/src/billing-terms.test.ts, billing-consents.test.ts |
| `ops_switches_and_audit` | 2, lane 5 | P20-20, P20-66 | Copy each switch row to its `ops:` key once, keeping the old key (expand only); new platform table `ops_audit` with no cascading foreign key | Data, platform table | Test on a fixture with a flipped switch (both keys present); client roles cannot read or write `ops_audit` |
| `billing_schedule` | 3, lane 2b | P20-06 (P1 part), P20-09 | `subscriptions.pending_tier`, `pending_cadence`, `pending_at`, `pending_schedule_id`; `credit_ledger.note` | Columns | Members read and cannot write. packages/db/src/billing-schedule.test.ts |
| `ops_switches_contract` | 3, lane 5b | P20-20 | Delete the old switch keys, with a `-- contract:` comment, after one release on `opsSwitch` | Data (contract) | Test that only the old keys go |
| `runner_columns` | 3, lane 8 | P20-32, P20-33, P20-35 | `generation_jobs.heartbeat_at`, `runner_id`, `run_payload` (if P18-23 lacks it), `started_at`, `finished_at`, the partial live index | Columns, index | Members read only their own job columns; client writes refused. packages/db/src/runner-columns.test.ts |
| `retention_indexes` | 3, lane 10 | P20-39 | Indexes on `events(at)`, `spend_cap_counters(updated_at)`, `upload_preflights(updated_at)` | Indexes | Covered by the retention tests |
| `ops_alerts_gallery` | 3, lane 13 | P20-47, P20-50 | Platform table `ops_alerts`; `gallery_items.review_status` (default `pending`), `reviewed_at`, `reviewed_by` with a backfill and the new public policy | Platform table, columns, policy | packages/db/src/ops-alerts-gallery.test.ts (client roles cannot read or write `ops_alerts`; anonymous gallery reads approved rows only) |
| `disposable_domains` | 4, lane 15 | P20-30 | Platform table `disposable_email_domains`; the new signup grant function version | Platform table, function | packages/db/src/disposable-domains.test.ts |
| `breaker_state` | P2 (triggered) | P20-36 | Platform table `breaker_state` | Platform table | Client roles cannot read or write it |
| `products_archive` | P2 (triggered) | P20-43 | `products.archived_at` and its index | Column | Members read; client writes refused. packages/db/src/products-archive.test.ts |
| `workspace_invites` | P2 (triggered) | P20-59 (P2 part) | New `workspace_invites` | Tenant table | packages/db/src/workspace-invites.test.ts |
| `pack_batches` | 5 | P20-60, P20-61 | New `pack_batches`; `generation_jobs.batch_id`, `listing_copy` | Tenant table, columns | packages/db/src/pack-batches.test.ts |
| `job_checkpoint` | 5 | P20-64 | `generation_jobs.checkpoint` | Column | Members read own rows; client writes refused |

No migration: P20-01 to P20-04, P20-08, P20-10 to P20-19, P20-21 to P20-29, P20-31, P20-34, P20-37, P20-38, P20-40 to P20-42, P20-44 to P20-46, P20-48, P20-49, P20-51 to P20-58, P20-62, P20-63, P20-65. P18-23's `restart_count` is reused, not duplicated.

## Seed summary (rule 2)

- **credits.ts:** `creditExpiry`; `TopUp.expiresMonths` and `rolloverPolicy` removed; `tiers[].selfServe`; `taxDisplay`; `renewalNotices`; `billingReconcile`; `opsGrants`; the reprice of `creditCosts` (decision 2); `featureStatus.priorityQueue` live with P20-35's P2 part (together with `FEATURES.priorityQueue`); `followUpPricing.regenerateFreePerShot`; `teamLimits`; P2 `batchLimits.maxProducts` and `creditCosts.listingText`.
- **monitoring.ts:** `providerAlertPolicy` (replaces `llmQuotaAlertFamilies`), `canaryPolicy`, `opsAlertPolicy`, `healthLimits`, `llmModelRetirements`, `errorReporting`.
- **models.ts:** `costCaps.workspaceExpectedDailyMicrosByTier`, `costCaps.globalDailyAlertMicros`, `costCaps.globalDailyHardStopMicros`, `costCaps.workspaceDailyMultiplier` (every `SPEND_CAPS` literal leaves packages/ai); P2 `breakerPolicy`.
- **New files:** `operations.ts` (`opsSwitchDefaults`, `queue`, `orphan`, `backup`, `deploy`, `tick`), `data-retention.ts` (also `turnstileFallback`), `disposable-domains.ts`, `economics.ts`.
- **growth.ts (PHASE_18):** `deployRestarts.windowMinutes` added beside P18-23's `max`.
- **recipes.ts:** the next shot_planner version (P20-42e) at `trafficPct` 0; P2 `listing_copy` v1.
- **Registry:** P2 `textLimits` for listing titles and bullets, after rule 7 checks.
- **Never seeded:** every `ops:` key. `platformSettingSeedRows` keeps only values; `output_options_enabled` leaves it.

## Environment variables

Each goes into render.yaml (P20-21) on the services that use it, and into the docs/LAUNCH_CHECKLIST.md table with what happens when unset; the founder adds them to `.env.example` by hand (P20-21's separate test warns until then).

| Variable | Where | Items | When unset |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (build), `SENTRY_ORG`, `SENTRY_PROJECT` (`SENTRY_DSN` exists) | web | P20-13, P20-14 | No events; stack traces stay minified |
| `BILLING_EMAIL_FROM` (an address on the verified `updates.curvi.ai`) | web | P20-07 | No activation email; config-health warns `billing_email_from_missing` (degraded once checkout is open) |
| `BACKUP_DATABASE_URL` (session pooler), `BACKUP_AGE_RECIPIENT`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `HEALTHCHECKS_BACKUP_URL` | backup cron only, never the web service | P20-10 | The backup exits non zero and health turns degraded |
| `HEALTHCHECKS_TICK_URL` | tick cron only | P20-38 | No heartbeat for the tick |
| `RENDER_API_KEY`, `RENDER_SERVICE_ID`, `RENDER_BACKUP_CRON_ID` | founder's machine only, never on Render | P20-12, P20-19 | The scripts refuse to run |
| `OPS_RELEASE_TOKEN` | web and the founder's machine | P20-19 | The deploy pending route answers 404 and the release script refuses |
| `OPS_OPERATOR_EMAIL` | founder's machine only | P20-66 | The grant CLI refuses |
| `SUPPORT_INBOX` | web | P20-24 | hello@curvi.ai |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | web | P20-29 | No widget; Supabase CAPTCHA must stay off; the anonymous spend endpoints use the stricter `turnstileFallback` limits in production and warn `turnstile_secret_missing`; with the site key set and no secret they refuse |
| `CLIENT_IP_HEADER`, `CLIENT_IP_PROXY_SECRET` | web | P20-51 | Today's header order, logged as untrusted |
| `NEXT_PUBLIC_ENV_LABEL` | staging | P20-54 | No banner; a Stripe test key on the production site URL is a mismatch (P20-01) |
| `SMOKE_BASE_URL`, `SMOKE_USER_EMAIL`, `SMOKE_USER_PASSWORD` (staging only), `SMOKE_API_KEY` (the excluded operator workspace) | GitHub secrets | P20-55 | The smoke workflow is skipped |
| `TEST_DATABASE_URL` | CI only | P20-03 | Race tests are skipped |
| `STRIPE_E2E` | local only | P20-03 | The Checkout e2e is skipped |
| `NODE_OPTIONS` | web | P20-34 | Node's default heap |
| Already read but missing from render.yaml: `CRON_SECRET`, `OPS_EMAILS`, `FAL_KEY_BACKUP`, `NEXT_PUBLIC_OUTPUT_OPTIONS`, `CURVI_SHOT_CONCURRENCY`, `DAILY_SPEND_HARD_STOP_USD`, `OPENAI_ADS_CONVERSIONS_KEY`, `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID`, `NEXT_PUBLIC_POSTHOG_HOST`, `SHOPIFY_API_SECRET`, `CURVI_ALLOW_DEMO_GENERATION`, `CURVI_TEMPLATE_FONT_FILE`, `VISITS_HASH_KEY`, plus every PHASE_18 and PHASE_19 variable | web | P20-21 | As documented by their phase |
| Removed: `TRIGGER_SECRET_KEY` | | P20-18, P20-21 | Ignored; `trigger_secret_ignored` info |
| Removed: `METRICS_DIGEST_TO`, `METRICS_DIGEST_FROM` (read only by the Trigger.dev digest task) | | P20-18, P20-38 | The weekly email goes to `FOUNDER_ALERT_EMAIL` through `sendFounderEmail` |

## Tests (summary)

| Package | Tests |
| --- | --- |
| packages/db | `billing_terms` (`subscriptions.cadence`, `billing_consents` RLS); `ops_audit` closed to client roles; `billing_schedule` columns; `runner_columns`; `ops_alerts` and the gallery policy; `disposable_domains` and the grant; P2 tables (`breaker_state`, `products_archive`, `workspace_invites`, `pack_batches`, `job_checkpoint`); the migration lint for contract statements, including `DELETE` or `UPDATE` on `platform_settings`; real Postgres ledger races (when `TEST_DATABASE_URL` is set); each new table has `no_oauth_clients` (PHASE_19's walk). |
| packages/ai | No cap literal left in caps.ts; the seed driven caps; the canary's trial call skips the open check for its one provider only; P2: the breaker on both stores, half open with one trial. |
| packages/pipeline | Seed tests: no credit expiry fields, `selfServe`, renewal windows, `billingReconcile`, `opsGrants`, `opsSwitchDefaults` and no `ops:` seed rows, retirement dates with a fixed `asOf`, every tier in the workspace caps, data retention windows for every counter prefix, economics (the price floor over every self serve price and promotion offer at both cadences), `FEATURES` and `featureStatus` agree, older shot_planner prompts unchanged; the shared `csvField` leaves signed numbers alone. |
| trigger | Quota emails once per family; the canary pinned to one provider, metered and capped; probe store and `passedAt`; COGS added as deltas across runs; payload persistence and single pickup; the report hook. |
| apps/web | Billing readiness (environment label), reconciler (applied counts, no Stripe writes on replay, per event isolation, dry run), flow suite, the downgrade stopgap and (P1) the scheduled downgrade with schedule release on every path, disclosures with metadata, consent rows, activation email dedupe, notices by cadence, cancel flow, credit history and CSV, operator grants; health classification (unknown codes degraded); Sentry scrubber, `TOKEN_PATH_PREFIXES`, repeat limiter and caps; error pages; release script steps and the `ops:deploy_pending` expiry and route; pause switch; env completeness and per service secrets; legal facts, retention rows and subprocessor coverage; support form (no auto reply when signed out without Turnstile); auth confirm route and `next` unwrapping, `finish` parity, error map, resend, Turnstile and its fallback; orphan recovery (a 40 minute wait survives the sweep; crash orphans settled, not requeued); queue info; workspace day cap and MCP rows; tick registry and lease; retention; tmp keys and the lifecycle file; regenerate and its source rule; pack fixes; ops gate (second factor on every page), actions, force on a fresh heartbeat, audit rows; alert rules; gallery approval through `DbShareStore` and the sitemap; client IP on both hosts; CSP; billing roles; P2: products and library, structured logger, invites and switcher. |
| e2e | Health `status`; 404 page; cross device confirm (demo); resend button; contact form; help pages; status page; pricing disclosures and the Agency line; cancel flow; credit history; regenerate; queue line; mobile menu and axe; ops pages for an operator and 404 for others; /gallery never shows a pending item. Existing specs unchanged. P2: products search and archive; invites. |
| smoke | e2e/smoke on staging with sign in and a pack; the production light smoke with no sign in (P20-55). |

## Sequencing and parallelization

### Contract first (serial, on `p20/integration`)

One commit before any lane starts, so lanes code against the same seams:
- `apps/web/src/lib/features.ts` `opsSwitch(key)` and seed `operations.ts` `opsSwitchDefaults` (the reader only; P20-20 moves the keys);
- `apps/web/src/lib/auth/finish.ts` as a pure move of today's steps out of the callback, with a test that its effects are unchanged;
- `apps/web/src/lib/health-status.ts` with the severity table and an empty `degradedBy`;
- the `CRON_JOBS` registry type in lib/cron-health.ts, keeping today's two entries;
- `apps/web/src/lib/legal/facts.ts` with today's values;
- `apps/web/src/lib/token-paths.ts` with `TOKEN_PATH_PREFIXES`;
- `apps/web/src/lib/ops/audit.ts` with the `writeOpsAudit` signature (lane 5's migration creates the table);
- empty seed files `data-retention.ts`, `disposable-domains.ts`, `economics.ts` wired into the seed index, and an empty `packages/pipeline/src/economics/`;
- the `apps/web/src/lib/ops/` directory skeleton, its boundary test, and the `app/app/ops/layout.tsx` gate (reusing `isOperator`);
- the `apps/web/scripts/` folder with a `tsx` runner in `@curvi/web`'s package.json and the root aliases;
- this file's migration names and order.

### Lanes (one subagent per lane, each in its own git worktree)

Worktrees branch from `p20/integration`; each agent starts with `git merge --ff-only p20/integration`. Release 2's lanes need nothing from PHASE_18 or PHASE_19.

| Release | Lane | Branch | Items, in order | Migrations | Must wait for |
| --- | --- | --- | --- | --- | --- |
| 2 | 1 Billing core | p20/billing-core | P20-01, P20-02, P20-03 (the flow suite; the race suite may follow early in Release 3), P20-04 | none | contract; the founder's test mode fixtures ("Do before the phase" item 11) for P20-03 |
| 2 | 2 Billing terms | p20/billing-terms | P20-05, P20-08, P20-06 (P0 stopgap), then P20-07 (P0 part) | `billing_terms` | P20-01 merged (call sites) before it starts; P20-02 merged (webhook) before P20-07 |
| 2 | 3 Data safety | p20/data | P20-10, P20-11 | none | contract |
| 2 | 4 Observe | p20/observe | P20-13, P20-15, P20-17 (docs) | none | contract |
| 2 | 5 Operator basics | p20/ops-basics | P20-20, P20-66 | `ops_switches_and_audit` | contract |
| 2 | 6 Trust | p20/trust | P20-23 | none | contract |
| 3 | 2b Billing later | p20/billing-later | P20-06 (P1 part), P20-09, P20-07 (P1 notices) | `billing_schedule` | Release 2 merged; P18-06 merged before the notices |
| 3 | 3b Data tools | p20/data-tools | P20-12, P20-22 | none | Release 2 merged |
| 3 | 4b Observe more | p20/observe-more | P20-14, P20-16 | none | Release 2 merged; P18-03 merged before P20-16 |
| 3 | 5b Deploy | p20/deploy | P20-18, then P20-19, then `ops_switches_contract`, then P20-21 last | `ops_switches_contract` | P20-19 after lane 8's P20-33 (or P18-23) is merged and live; the contract migration after one release on `opsSwitch`; P20-21 after every Release 2 and 3 lane that adds a variable |
| 3 | 6b Support | p20/support | P20-24 | none | P18-06 merged; PHASE_19's /support merged (else the lane creates it) |
| 3 | 7 Sign in | p20/auth | P20-28 | none | Release 2 merged; PHASE_18 and PHASE_19 auth edits merged into `finish.ts` |
| 3 | 8 Runner | p20/runner | P20-32, P20-33, P20-34, P20-35 (P1 part) | `runner_columns` | Release 2 merged; P18-23 merged or built here first |
| 3 | 9 Providers | p20/providers | P20-37 | none | Release 2 merged |
| 3 | 10 Schedule | p20/schedule | P20-38, P20-39, P20-40 | `retention_indexes` | lanes 2b, 4b and 8 (tick jobs) |
| 3 | 11 Pack | p20/pack | P20-41, P20-42 | none | Release 2 merged |
| 3 | 12 App | p20/app | P20-44 | none | Release 2 merged |
| 3 | 13 Cockpit | p20/cockpit | P20-49, P20-45, P20-46, P20-47, P20-50 | `ops_alerts_gallery` | lanes 8 and 10 for the data they show |
| 3 | 14 Help | p20/help | P20-25, P20-26, P20-27 | none | Release 2 merged; P18-05 merged before P20-25 |
| 4 | 15 Security | p20/security | P20-51, P20-52, P20-53, P20-29, P20-30 | `disposable_domains` | Release 3 merged; PHASE_19's review closed before CAPTCHA is turned on |
| 4 | 16 Staging | p20/staging | P20-54, P20-55, P20-56 | none | founder creates the staging accounts |
| 4 | 17 Docs | p20/docs | P20-58 | none | Release 3 merged |
| 4 | 18 Teams | p20/teams | P20-59 (P1 part), P20-31 | none | Release 3 merged |
| 5 | 19 to 22 | p20/batch, p20/listing, p20/adjust, p20/resume | P20-60; P20-61; P20-62 and P20-65; P20-63 and P20-64 | `pack_batches`, `job_checkpoint` | Release 4 gate; each item's condition |
| triggered | 23 Volume | one branch per item, p20/volume-<id> | P20-35 (P2 part), P20-36, P20-43, P20-48, P20-57, P20-59 (P2 part) | `breaker_state`, `products_archive`, `workspace_invites` | Release 3 merged; the item's trigger in the weekly report |

Serial constraints and shared files (merge in this order, rebasing the later lane):
- **render.yaml:** Release 2 and 3 lanes hand their variables and cron entries to lane 5b, which writes them in P20-21 last in Release 3; later lanes add their own entries with the completeness test.
- **lib/config-health.ts:** lane 1 (Stripe warnings), lane 2 (`billing_email_from_missing`), lane 4 (classification); then lane 3b (retiring), lane 4b (`fal_balance_low`), lane 5b (`trigger_secret_ignored`) and lane 15 (`turnstile_secret_missing`).
- **lib/cron-health.ts:** lane 1 (billing-reconcile), lane 3 (backup), lane 4b (provider-canary), lane 2b (renewal notices), then lane 10 turns it into the tick registry.
- **Stripe webhook and stripe.ts:** lane 1, then lane 2, then lane 2b.
- **Pricing and billing pages:** lane 1 (call sites), then lane 2, then lane 2b.
- **app/auth/callback, confirm and AuthForm:** lane 7, then lane 15 (Turnstile), then lane 18 (change email). From Release 3 on, PHASE_18 and PHASE_19 edits are merged first.
- **inline-runner.ts and enqueue.ts:** lane 4 (Sentry scope tags), then lane 5b (P20-18), then lane 8, then lane 5b's P20-19.
- **createJob refusals and `lib/api-v1/mcp-copy.ts`:** lane 5b (packs paused), lane 9 (day cap), lane 11 (`empty_plan`).
- **privacy and terms pages:** lane 6 only in Release 2; later lanes change numbers through `facts.ts`.
- **lib/rate-limit.ts:** lane 6b (`support.contact`), then lane 15.
- **next.config.ts:** lane 4 (Sentry), then lane 15 (CSP).
- **Migrations** are generated after rebasing on the newest main and applied to production only in numeric order.

Agents per CLAUDE.md:
- **reviewer.md** reviews every lane that touches billing (1, 2, 2b, 5 for operator grants, 18 for billing roles), RLS and migrations (2, 2b, 5, 5b, 8, 10, 13, 15, 23, 19 to 22), recovery and requeue (8), ops actions and the second factor (5, 13), the backup, restore and release scripts (3, 5b), Sentry redaction (4), the auth confirm route (7), the support form (6b), the client IP (15) and invites (23), before each merge.
- **test-writer.md** writes each lane's Vitest and Playwright specs.
- **prompt-eval.md** runs `pnpm eval` for P20-42e and P20-61.

### Release order

| Release | Items | Gate |
| --- | --- | --- |
| 1 | Founder decisions and "Do before the phase" | Decisions recorded here; the seed SQL run with no `recipe_drift`; one manual backup; the test alert received; the Stripe test mode setup and fixtures done; counsel quotes requested |
| 2 (P0, the money gate) | P20-01 to P20-05, P20-06 (stopgap), P20-07 (P0 part), P20-08, P20-10, P20-11, P20-13, P20-15, P20-17, P20-20, P20-23, P20-66 | docs/STRIPE_SETUP.md section 8 passes in test mode, run locally with the Stripe CLI forwarding webhooks and checked with `billing:verify`; legal text approved (or decision 9's alternative recorded); one restore drill into an isolated local stack recorded with its duration; P20-17's production safe monitor checks. Then live keys go in and `/api/health/providers` shows `checkoutOpen` with no Stripe warning in `/api/health`. The founder buys a live plan with a real card (Growth monthly as MKT-006 step 2 says, or Starter monthly at $29, the cheaper option it allows) and checks credits granted exactly once, one `billing_consents` row and one activation email; then buys a $15 top up and refunds it (MKT-006 steps 3 and 4), proving the grant and the clawback on live. The subscription stays, so the founder workspace keeps concierge credits, and the workspace is in docs/marketing-ops/exclusions.md. This passes marketing G3. |
| 3 (P1) | The rest of W1 to W4 (P20-06 and P20-07 P1 parts, P20-09, P20-12, P20-14, P20-16, P20-18, P20-19, P20-21, P20-22, P20-24 to P20-28), W5, W6 and W7 except the triggered P2 items | Checks on production with the synthetic operator workspace: the first `pnpm release` deploys the exact SHA and leaves auto deploy off; a deploy during a running pack requeues it once and it finishes; email templates switched and a cross device signup confirmed on a phone; `curvi-tick` runs with its check up; the cockpit shows a job timeline behind the second factor |
| 4 (P1) | W8 except P20-57, the P1 part of P20-59, P20-29 to P20-31 | Staging smoke green; a staging release with a pack running finishes it (P20-19); a staging health 503 fires both monitors (P20-17); an induced crash on staging recovers within 5 minutes (P20-32); CSP enforced for 7 days with no unexpected violations |
| 5 (P2) | Batch 5, and the triggered items (P20-35 P2 part, P20-36, P20-43, P20-48, P20-57, P20-59 P2 part) when their trigger fires | Each item's condition or trigger |

Rough size at the middle of each effort band (PHASE_19's scale): P0 about 15 agent days (11 to 19), P1 about 45 (34 to 56), P2 about 26 (20 to 32), including the triggered items that may never be built; about 86 in all. The longest P0 chain: P20-01 (half a day), then lane 2's P20-05, P20-08 and P20-06's stopgap (about 1.5 days, while lane 1 finishes P20-02), then P20-07's P0 part (L, about 4 days), so about 6 agent days. With review, the founder steps, counsel and Stripe's account review, Release 2 lands about day 10 to 14 (decision 1).

### Running cost after each release

Cash per month at today's volume, beyond what runs today (Render web $25, already paid). Stripe's card fees and Stripe Tax's 0.5 percent (where registered) scale with sales and are not counted.

| After | Added | Monthly total beyond today |
| --- | --- | --- |
| Release 2 | Backup cron about $1 (Render's minimum); the two existing dashboard crons stay (about $2 already paid); R2 backup storage inside the shared free tier | about $1 |
| Release 3 | Canary about $1.50; `curvi-tick` replaces the two dashboard crons (net about $1 less) | about $1.50 |
| Release 4 | Staging pack and synthetic production pack about $1.20; Upstash, staging Supabase and Render free | about $2.70 |
| Founder options | Supabase Pro $25 (decision 11); healthchecks.io Supporter $5 (decision 14) | up to $30 more |
| One time | Counsel about $500 to $1,500 (decision 9 estimate); accountant about $200 to $500 (decision 3 estimate); golden set run $5 to $20 (P20-04) | |

## Rollout and the rule 6 gate

### Each release

1. Plan detail in this file first (rule 1). Each lane passes `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` in its worktree; the integration branch passes the same gate after every merge (rule 6).
2. The reviewer agent signs off on the lanes listed above.
3. Production database: a fresh backup (manual pg_dump until P20-12, then `pnpm ops:migrate --env prod`, which refuses without one); migrations in numeric order, after any earlier migration from another branch production lacks; then `pnpm db:seed` only after the drift check shows the seed's `trafficPct` and active versions equal production (P20-22).
4. Render: add the release's variables with Save only. Deploy with `pnpm release` once P20-19 ships; before that, push only while `/api/health` shows no running pack.
5. Check `/api/health` (`status` ok), `/api/status`, and the release's own checks; the staging smoke once P20-55 exists.
6. Flip `ops:` switches only after their checks pass.
7. Record each external fact read and each founder step done, dated, in docs/verification.md, and update "Implementation status".

### Founder steps (mirror into docs/PENDING.md as "Phase 20 founder steps")

1. Record the decisions above, or accept the defaults; ask for counsel quotes on day 1 (decision 9).
2. Everything in "Do before the phase", including the Stripe test mode setup and fixtures (item 11) and the switch check after each re-seed (item 10).
3. Stripe test mode run of docs/STRIPE_SETUP.md section 8 on the laptop with the Stripe CLI and `pnpm billing:verify`; the per tier upgrade only portal configurations and Switch plan off in the default configuration (P20-06); keep "Send emails about upcoming renewals" off (P20-07).
4. Legal entity, address, governing law and counsel review (P20-23); accountant on tax registrations (decision 3).
5. Backup bucket, token, lifecycle, lock, age key pair and the `curvi-backup` cron with only its own variables (P20-10); Docker and the Supabase CLI, then the first restore drill into the local stack (P20-11).
6. Sentry project and variables (P20-13); UptimeRobot monitors A and B and healthchecks.io checks (P20-17); Render failed deploy emails; `BILLING_EMAIL_FROM` (P20-07).
7. Concierge credits for the founder workspace with `pnpm ops:grant-credits` (P20-66), and the Growth comp by SQL for PHASE_19's MCP client test (decision 1).
8. After Release 2's gate: live Stripe keys and the live portal configurations, the live plan purchase, then the $15 live top up and refund.
9. Release 3: auto deploy off, and `RENDER_API_KEY`, `RENDER_SERVICE_ID` and `OPS_RELEASE_TOKEN` on the founder's machine (P20-19); Supabase email templates to `/auth/confirm` with `{{ .TokenHash }}`, then a test from a phone (P20-28); delete the two dashboard crons once `curvi-tick` runs (P20-38); apply the R2 lifecycle file with both rules (P20-40); enroll the operator second factor (P20-49).
10. Release 4: Upstash, the Cloudflare Transform Rule with `CLIENT_IP_PROXY_SECRET`, and the forged header test on both hosts (P20-51); GitHub toggles (P20-52); the Turnstile widget and Supabase CAPTCHA after PHASE_19's review closes (P20-29); the staging Supabase project in a separate free organization, R2 bucket and Render service (P20-54); smoke secrets and the operator workspace API key (P20-55).
11. Approve the CLAUDE.md stack and commands edit (decision 29).

## Done when

- A live payment cannot leave a customer without credits: the readiness gate, the reconciler and the real Postgres race tests are green, a live plan purchase granted its credits once with one consent row and one activation email, and the live $15 top up was granted once and clawed back once.
- Every credit, renewal, refund and retention statement comes from one source and matches the code; no plan card lists a feature that does not run; the cancel flow shows a cancel button beside every offer.
- A backup under 24 hours old and one restore drill into an isolated database with its measured duration are recorded, and no migration reaches production without a fresh backup.
- Sentry shows a runner error with its job id; `/api/health` reports degraded during a fal quota trip and both monitors fire in a staging drill; every provider family's quota answer sends exactly one email.
- A re-seed leaves every `ops:` switch as the founder set it, and the drift check catches a traffic split that differs from the seed.
- render.yaml passes the env completeness test, keeps each secret on the services that use it and documents every cron; `TRIGGER_SECRET_KEY` is gone; no active chain references Haiku 4.5.
- A customer can confirm their email on another device, reach a person from inside the app, see where their credits went, make another version of a scene and see their place in the queue.
- A staging deploy during a pack either finishes it or requeues it once, and an induced crash recovers within 5 minutes.
- The cockpit shows the job timeline and open alerts behind a second factor on every page, and every operator action has an `ops_audit` row.
- The full rule 6 gate passes on `p20/integration` and the staging smoke passes; docs/verification.md has a dated row for every external fact in "External facts" that a shipped item uses.
- The triggered P2 items are listed in the weekly report's Triggers section; none is required for this phase to be done.

## Implementation status

Record per item: status, branch and merge commit, deviations from this plan, known gaps, and what still needs a live run, as PHASE_16 and PHASE_17 do. Each lane edits only its own items' entries below, so merges do not collide.

### Current acceptance matrix (2026-10-02, integration in progress)

This dated matrix supersedes the historical per-item statements below. It describes the implementation developed on `codex/complete-phases-18-20`, based on `release/2026-10-02` (`02a0ae0`), now committed and published for review. PR4 merged as `dae0fb0`; feature PR6 tracks the real PostgreSQL 17 CI and deployment evidence. **Local** means implemented and locally tested; **partial** means code or an acceptance gate remains; **deferred** means the plan explicitly requires a trigger that has not been recorded. None of these labels alone confirms a production deployment, a real payment, a delivered email, or an operational drill. The whole phase is not accepted yet.

Reusable baseline: Release 2 integration `24d8b10`, review fixes `743044f`, merged in `2096f7c`, are already ancestors of the release checkout. The former lane migrations 0028/0029 became 0038/0039 at integration. Additive schema contracts originated in `7082ec4`: 0040 billing schedule, 0041 runner ownership, 0042 retention indexes, 0043 alerts/gallery, 0044 disposable domains. Schema publication is complete through merged PR4 (`dae0fb0`). Production SQL 0028–0044 is applied, with all 45 migration journal entries verified; the targeted 9,199-domain seed and unchanged access controls are also verified. Do not cherry-pick the historical lanes over this checkout. Publication and live migration evidence are tracked separately in `docs/verification.md` by the integration owner.

Paths below are repository-relative. Web library paths abbreviate `apps/web/src/lib/`; app paths abbreviate `apps/web/src/app/`. Tests named beside a module are its colocated `*.test.ts` unless stated otherwise.

| Item | Local acceptance and evidence | Remaining gate / deliberate scope |
| --- | --- | --- |
| P20-01 | Local: `billing/readiness.ts`, checkout callers, readiness and billing-flow tests. | Exact production Price, webhook and portal configuration; checkout-open health and live purchase proof. |
| P20-02 | Local: `billing/reconcile.ts`, `reconcile-run.ts`, cron route; replay/dedupe/paging/dry-run tests. | Test-mode missed-webhook replay and production cron observation. |
| P20-03 | Partial: `billing/billing-flow.test.ts`, fixtures, `ledger-race.pg.test.ts`, `scripts/billing-verify.ts`. | Fixtures are documented shapes, not founder-captured real payloads; real PostgreSQL race suite and Stripe Checkout/test-clock exercise remain. |
| P20-04 | Partial: `packages/pipeline/src/economics`, `ops/economics.ts`, `scripts/unit-economics.ts`; fixture tests. | Actual pack-cost sample and credit-price decision; a synthetic report does not establish margin. |
| P20-05 | Local: nonexpiring credit terms, migration 0039, grant paths and billing copy tests. | Production acceptance follows migration and checkout/legal review. |
| P20-06 | Local P0 and P1: `billing/scheduled-change.ts`, `/api/billing/schedule`, cancel service/store, pending-plan UI, migration 0040; schedule/role/webhook tests. | Stripe test-mode monthly/annual boundary, Keep current plan and portal interaction; actual price-change billing reason. Interrupted-response recovery and empty-attachment Keep-current fixtures pass. No immediate-price downgrade. |
| P20-07 | Local: transactional activation adapter, `billing/renewal-notices.ts`, daily tick registration and `scripts/billing-price-notice.ts`; date/dedupe tests. | Sender and mailbox delivery, annual/monthly dates against real Stripe data. Price notice script defaults to an explicitly chosen run; no mail sent by this implementation task. |
| P20-08 | Local: seed-driven plan cards, self-serve tiers and API feature gate; billing render tests. | Visual production review and correct portal configurations. |
| P20-09 | Local: paged `billing/history.ts`, invoice owner/admin service and APIs, billing history UI, safe current-page CSV; grouping, pagination, tenant/role and invoice-cache tests. | Live Stripe invoice/PDF permissions and seller browser check. |
| P20-10 | Partial operational: backup scripts, `ops/backups.ts`, backup-report route and tests already in baseline. | Encrypted backup cron, independent bucket credentials and observed retention/delivery. |
| P20-11 | Partial operational: restore-drill/verify-restore scripts, health records and fixture tests. | Timed restore into isolated stack and recorded proof; never infer recovery from backup existence. |
| P20-12 | Local tools: `ops/migrate.ts`, `scripts/ops-migrate.ts`; migration refusal/backup tests. | Real pre-migration backup job and report proof, live invocation through release process. |
| P20-13 | Local: server Sentry initialization, shared token scrubber, bounded sampling and tunnel tests. | Real scrubbed event, source maps and quota behavior in deployed runtime. |
| P20-14 | Local: app/global errors, not-found, dynamic authenticated browser reporter, staging banner; customer tests. | Real browser Sentry event and production error-page smoke. |
| P20-15 | Local: classified health, database/queue/spend/provider details and warning tests. | Protected deployed health observation after new release. |
| P20-16 | Local canary/provider implementation: durable quota/probe/reset records, stage pause alerts, seeded opt-in canaries and BFL balance; AI/worker/web tests. | Canary is disabled by default. Funded drain/top-up/rerun, R2 probe, scheduling and alert-delivery proof remain. |
| P20-17 | Partial operational: `docs/ops/ALERTS.md` and health endpoints exist. | External uptime/heartbeat monitors and production-safe outage/recovery checks. |
| P20-18 | Local: retired Trigger.dev task files/config/SDK; inline runner and current web tick paths used. | Production env cleanup and deployment observation. |
| P20-19 | Local tools: deploy-pending endpoint, `ops/release.ts`, release CLI, maintenance gate; safe-release tests. | Live drain/deploy/restart smoke and adopted Render settings. |
| P20-20 | Local expand/readers: durable ops keys, guarded seed loader, audit and switch tests. | Destructive old-key contract migration intentionally waits until every reader has run in production for a release. Verify seed preserves a flipped live switch. |
| P20-21 | Local complete: production web/isolated backup/tick Blueprint, exhaustive source/seed/dynamic env inventory, user-approved checksPass; seven deploy and four tick tests passed; official Render schema validation zero errors. | Live no-duplicate preview/adoption, secret preservation, cron heartbeat/backup proof and founder env-example update remain. |
| P20-22 | Local: verified earliest-retirement metadata, active primary/fallback/escalation warnings (30/14 days), traffic/active drift detail; 70 seed and 58 web tests, pipeline/web TypeScript and lint passed. | Compare live rows and warning output; dates are earliest provider bounds, not confirmed shutdowns. No live seed/model change performed. |
| P20-23 | Local legal-facts/copy/subprocessor modules, temporary window now imports `tmpObjectDays`; legal tests. | Founder entity/address/law and counsel approval remain operational/legal gates. No completed legal review claimed. |
| P20-24 | Local: support form/endpoint, workspace checks, shared sender, seeded per-user/IP rates; support tests. | Inbox/ack delivery and signed-in public-form smoke. |
| P20-25 | Local: deduped unusable feedback founder notification and support link; `feedback/notify.test.ts`. | Real inbox delivery and founder triage. |
| P20-26 | Local: grouped help index, 22 articles, individual metadata/sitemap, refund/team gates. | Review displayed help against deployed features; gated offers remain off. |
| P20-27 | Local: four-line status and honest changelog data; customer-status tests. | Actual deployed status transitions and dated release notes once shipped. |
| P20-28 | Local: scanner-safe confirmation GET/POST, common finish flow, resend cooldown and plain auth errors; auth tests. | Phone/mail-client template smoke and Supabase template application. |
| P20-29 | Local: Turnstile widget/reset/siteverify for auth/support/spend endpoints, hostname/action checks, fail-closed half-config, seeded production fallback caps; 51 spend-focused tests. | Configure approved widget/CAPTCHA only after assistant review; prove live challenge and reviewer login. |
| P20-30 | Implemented and database verified: migration 0044, normalized disposable-domain snapshot with hash, atomic seed sync and withheld-grant UI; DB/seed tests. Production has exactly 9,199 seeded domains; checksum, RLS, OAuth denies, client grants and function ACLs verified unchanged. | Disposable signup and withheld-grant UI smoke remain. No signup-grant replay or auth-hook activation is claimed by the targeted seed. Snapshot metadata records source/checksum. |
| P20-31 | Local: email-change routes, verified Stripe match and suppression preservation; email-change tests. | Supabase mail-template, real confirmation and Stripe customer-email sync proof. |
| P20-32 | Local: runner heartbeat ownership, stale sweep CAS/settlement, recovery route/tick; recovery and worker tests. | Abrupt process termination smoke with exactly-once settlement. |
| P20-33 | Local: persisted first-run payload, bounded restart/claim, run fencing and additive COGS; restart/recovery/db-store tests. | Two-instance boot pickup and live deploy recovery; original payload is server-only. |
| P20-34 | Local RSS admission and representative stress: two packs/concurrency two finished in nine seconds, peak RSS 1012.20 MiB under 2048 MiB. One pack/concurrency one peaked 724.66 MiB and failed 512 MiB. `handoffs/pipeline.md` records commands. | 512 MiB is unsuitable for this fixture. Intended local profile is 2 GiB/concurrency two; actual staging Next.js overlap/latency acceptance remains pending. |
| P20-35 | Local P1: global queue position and median ETA; queue/recovery tests. P2 deferred. | Priority/workspace fairness requires the documented volume trigger; no priority guarantee claimed. |
| P20-36 | Deferred P2: shared PostgreSQL breaker state. | Requires multiple active instances/recorded trigger; current breaker remains per process. |
| P20-37 | Local: seeded per-call/pack/day caps, operator global override, workspace-day reservations and pre-hold refusal; AI and worker cap tests. | Metered provider exercise and production cap alerts. |
| P20-38 | Local: seeded 10-minute atomic leased tick, heartbeat/due/budget/partial-failure behavior, optional-job registration and one weekly Money/Operations/Triggers digest; tick/weekly tests. | Render schedule, stuck-lease drill and first real weekly report; optional integrations stay unmonitored until configured. |
| P20-39 | Local: bounded seeded retention, SQL statement timeout, dry-run counts and billing-mail three-year retention; PGlite retention tests. | Production dry run and measured delete pass. Funnel and billing consents untouched; absent P2 breaker table cleanup deferred. |
| P20-40 | Local: `tmp/ws` writer migration/guards, legacy reads and bounded sweep, account deletion, single R2 lifecycle JSON (anon two days/tmp seven); storage tests. | Founder applies lifecycle config and observes live-object expiry; keep both lifecycle rules together. |
| P20-41 | Local: real regenerate service/API/UI, source/cache checks, new unpicked version, hold and delivered-only charge; DB shot-op tests plus worker ledger regeneration test. | Metered real-scene run, pick and download; no optional note/recipe change. |
| P20-42 | Local a-d: empty-plan guard, picked ZIP/ad CSV, current picked JSON/PDF proof, single-carousel retry refusal. `pack-contents`, `pack-zip`, `picked-compliance`, DB and worker tests. e inactive planner v4/v5 with old prompt hashes pinned; 183 seed/prompt/benchmark tests passed. | Exact checks stored by object key in asset QC; legacy versions without saved checks show unmeasured. Colliding versions keep their filename in a version folder. Planner eval and canary promotion remain unperformed. |
| P20-43 | Deferred P2: product archive/search/library paging. | Needs more than 30 products or 100 library images in a workspace. |
| P20-44 | Local and browser verified: mobile Menu/focus/skip link, desktop nav and minimum text/contrast; six-page axe plus readiness 10 passed, related browser regression 26 passed. | Recheck deployed responsive UI after integration. |
| P20-45 | Local: gated overview, switches/grants, health/spend/timings/alerts/probes/CSP counts and operator navigation; access/switch tests. | Founder MFA, live pause/refusal/audit smoke; breaker expiry unavailable in current store API (reason/probe/reset shown). |
| P20-46 | Local: filtered jobs, timeline, workspace-safe five-minute source links, audited settle/forced/stale requeue with backend locks and unique pickup; jobs/access tests. | Live stale/forced rerun smoke; max-one/one-hour restart limits retained. |
| P20-47 | Local alert integration: durable open/resolved state, retryable deduped notification claims and tick integration; `ops/alerts.test.ts` (34 focused alerts/gallery/share/action tests passed). | Real notification/recovery delivery. Tick now supplies cap/margin samples (`ops/alert-signals.ts`, three fixture tests); incomplete historical QC omits margin telemetry rather than falsely resolving alerts. |
| P20-48 | Deferred P2: economics cockpit. | Needs weekly report trigger; P20-04 report is available meanwhile. |
| P20-49 | Local: operator AAL2 gate on pages/actions, enrollment/challenge/removal UI, audit and founder notification; operator/security tests. | Founder enrollment and real factor/recovery exercise. |
| P20-50 | Local: migration 0043 review state, approved-only gallery/owner queries/sitemap, operator approval/rejection with audit; gallery/RLS/action tests (34 focused web tests shared with P47). | Live submission, approve/unpublish visibility and consent smoke. |
| P20-51 | Local: trusted configured proxy IP/secret handling, shared rate storage and host/origin protections; focused security tests. | Trusted header/spoof check through actual proxy and configured Upstash behavior. |
| P20-52 | Local security checks verified: pinned warning-only Gitleaks, dependency audit/Dependabot CI scaffolding; final dependency audit and Gitleaks scans each reported zero findings. | Hosted security settings and promotion to required gates remain; feature PR6 records the separate real PostgreSQL 17 check. No live acceptance inferred from clean local scans. |
| P20-53 | Partial: bounded persisted CSP report aggregates, configurable enforced policy/Turnstile paths and token redaction; CSP tests. Nonces deferred P2. | Seven days of report-only evidence and zero real staging violations before enforcing. |
| P20-54 | Local scaffold: `render.staging.yaml`, STAGING runbook and isolated env/banner policy; focused smoke-policy/docs tests. | External staging accounts/configuration and deployed isolation proof. |
| P20-55 | Local scaffold: demo/public/staging/synthetic smoke specs, opt-in workflow and safety config; 68 smoke-policy/docs/SEO tests passed; demo browser smoke three passed, auth/paid two correctly skipped. | No paid smoke, real credentials or customer emails run by this task; scheduled successful real-stack proof pending. |
| P20-56 | Local scaffold: `docs/ops/DISASTER_RECOVERY.md`, safe drill instructions and docs tests. | Timed isolated recovery and interruption-safe operational rehearsal. |
| P20-57 | Deferred P2: structured log overhaul. | Triggered by incident/debug volume; existing scrubbers remain. |
| P20-58 | Local docs refreshed: dated matrix/handoffs, current PENDING and Stripe scheduling/notices, RUNBOOK/ALERTS/BACKUP_RESTORE; delivery owns staging/DR, customer LAUNCH and root verification. | Final integrated docs tests and each deployed batch must be recorded; no planned config is claimed as production. |
| P20-59 | Local P1: member emails, owner/admin billing permission and deterministic default workspace; service and billing tests. Invites/switcher deferred P2. | First team/Agency request required before invitation feature activation. |
| P20-60 | Deferred P2: multiple-product batches. | Documented customer/volume trigger and schema/API/UI work remain. |
| P20-61 | Deferred P2: listing copy. | Documented demand trigger, own recipe/eval and entitlement work remain. |
| P20-62 | Deferred P2: adjust scene. | Documented request trigger; must preserve source/cutout fidelity and price rules. |
| P20-63 | Deferred P2: customer MFA. | Customer/security demand trigger; operator MFA is separate and implemented. |
| P20-64 | Deferred P2: checkpoint/resume. | Needs incident/runtime evidence; no checkpoint schema or video deployment claimed. |
| P20-65 | Deferred P2: target-product handling on the white path, encoded-white main checks and LLM scene-count fixes. | Golden photos and funded evaluation required; no behavior change in this lane. |
| P20-66 | Local: audited/idempotent grant service, CLI and MFA-gated cockpit form; `ops/grants.test.ts`. | Authorized live grant and duplicate audit/ledger proof. |

Final integration-owner verification: **6,633 unit tests and 192 browser tests passed**, with lint and TypeScript checks passing; dependency audit and Gitleaks each reported **zero findings**. Earlier focused lane counts overlap with this result and remain documented in `docs/ops/handoffs/phase-20.md`. PR4 is merged as `dae0fb0`; feature PR6 records the real PostgreSQL 17 CI result separately; these local counts do not imply that gate passed. Real Stripe/mail/MFA/restore/deployment acceptance remains open as listed above.

### Historical implementation record

### Contract commit (p20/integration, 2026-10-01)

`p20/integration` starts from main 31992a9 (the visitor counter with `0027_site_visits`, the seed alignment and the PHASE_18, PHASE_19 and PHASE_20 docs). Build scope now: Release 2 only, the P0 money gate. The contract every lane codes against is behavior neutral: on a request path only the /app/ops layout gate (the same check the visitors page already makes) and the callback's move to `finishSignIn` (same effects) run new code.
- `opsSwitch(key, read)` in apps/web/src/lib/features.ts, with `forgetOpsSwitch(key?)` and `OPS_SWITCH_CACHE_MS` (30 seconds, the output options pattern), and the seed `opsSwitchDefaults` in packages/pipeline/src/seed/operations.ts: per `ops:` key a kind (`boolean`, `flag` `{ on, message, setBy, setAt, expiresAt }` or `usd`), a `default` and an `onReadError`. A missing row gives the default, a failed read or a wrong shape gives `onReadError`, and a flag past `expiresAt` reads as off. Deviation from "one reader `opsSwitch(key)`": the reader takes the platform_settings read as its second argument, as `outputOptionsSwitchOn` does, so features.ts stays client safe; server code passes `platformSettingReader(db)` from the new apps/web/src/lib/platform-settings.ts. The keys are the nine that P20-20 lists. PHASE_18 as built on p18/integration also seeds `deploy_restarts_enabled`, `founding_offer_enabled` and the store audit switch with `keepStored`; Lane 5 decides at the combine whether they move to `ops:` keys too.
- `finishSignIn({ user, next, origin, headers, params })` in apps/web/src/lib/auth/finish.ts, a pure move of the callback's terms record, Registration Completed conversion and welcome redirect; it returns the destination path. finish.test.ts runs one effect table through `finishSignIn` and through `/auth/callback`. PHASE_18 and PHASE_19 edit the callback today, so the combine moves their lines into finish.ts.
- apps/web/src/lib/health-status.ts: `SEVERITY_TABLE` (exact codes and `*` patterns, first match wins, `whileCheckoutClosed` for `stripe_*` and `billing_email_from_missing`), `DOWN_CODES`, `downCodes(checks)`, `severityOf` (no row means degraded) and `classify(codes, { checkoutOpen })` returning `{ status, degradedBy }`. Not wired into `/api/health` yet (Lane 4).
- `CronJobDefinition` in lib/cron-health.ts: `name`, `intervalMinutes` (freshness), at most one of `every`, `dailyAtUtc` and `weeklyAt`, and an optional `run(ctx)`; `CRON_JOBS` keeps today's two entries in their old shape, so PHASE_18's three added entries still merge, and `cronJobProblems` checks an entry.
- apps/web/src/lib/legal/facts.ts: `LEGAL_FACTS` with today's values (the support email, the reply time of decision 24, today's credit sentence and refund sentence, `SOURCE_RETENTION_DAYS`, the "Last updated" dates); the entity, address, governing law and every retention number of a feature that has not shipped are null. No page reads it yet (Lane 6).
- apps/web/src/lib/token-paths.ts: `TOKEN_PATH_PREFIXES` (the plan's list plus PHASE_18's `/feedback/` and `/api/feedback/` token routes, the one click `/api/email/unsubscribe`, `/s/` for claim links, and `/api/preview/`), `tokenPathPrefix` and `redactTokenPath`; a test fails when a `[token]` route folder is outside the list.
- apps/web/src/lib/ops/audit.ts: `writeOpsAudit(db, { operatorEmail, action, targetKind, targetId, workspaceId?, detail?, forced? }, at?)`, a raw insert into `ops_audit` that throws on failure. Lane 5's migration creates the table with those columns plus `id`.
- apps/web/src/lib/ops/ with its boundary test (imported only from app/app/ops, app/api/cron, app/api/ops, apps/web/scripts and lib/ops itself), and app/app/ops/layout.tsx, the operator gate over `isOperator`: noindex, and a 404 for everyone else.
- Seed files operations.ts, data-retention.ts, disposable-domains.ts and economics.ts with one section per lane, re-exported whole from the seed index; the empty packages/pipeline/src/economics/ is exported as `@curvi/pipeline/economics`.
- apps/web/scripts/ with `runScript`, `ScriptRefusal` and `parseScriptArgs` (cli.ts); `@curvi/web` scripts `script` (tsx), `billing:verify`, `report:unit-economics` and `ops:grant-credits` with root aliases (`web:script` for one off files). The three named scripts refuse until their lanes build them. Vitest now includes scripts/**/*.test.ts, and tsx is a devDependency of `@curvi/web`.
- packages/db/src/schema.ts ends with the Phase 20 migration names and order, the hand written SQL markers, the `no_oauth_clients` snippet and one block per new table.

### Release 2 combine (p20/integration, 2026-10-01)

Merged with `git merge --no-ff` in the plan's order: p20/billing-core (Lane 1: P20-01 to P20-04), p20/data (Lane 3: P20-10, P20-11), p20/observe (Lane 4: P20-13, P20-15, P20-17), p20/ops-basics (Lane 5: P20-20, P20-66) and p20/trust (Lane 6: P20-23). Lane 2 (Billing terms: P20-05, P20-08, P20-06 stopgap, P20-07 P0 part) was then built straight on p20/integration after this combine, one commit per item (2026-10-02), with migration `0029_billing_terms` on top of `0028_ops_switches_and_audit`. Not pushed; PHASE_19 and PHASE_18 merge first.
- **Migration.** Lane 5 brings `0028_ops_switches_and_audit` on top of `0027_site_visits`, and Lane 2 then added `0029_billing_terms` on top of it (generated from the schema with drizzle-kit, its hand written block re-appended); the chain 0027, 0028, 0029 is clean (each snapshot's prevId is the one before). At the final combine it is renumbered after PHASE_19's and PHASE_18's migrations by regenerating from the merged schema and re-appending its hand written block.
- **Conflicts, all kept from both sides.** cron-health.ts: `CRON_JOBS` is stale-jobs, purge-source-media, billing-reconcile, backup (the serial order); its test keeps Lane 3's `BASE_JOBS` filter and checks both new entries. config-health.ts: the header lists both the restore drill and the billing checks. The exact warning lists in config-health.test.ts and the health route test gain `cron_never_ran:billing-reconcile`, `cron_never_ran:backup` and `restore_drill_overdue`. docs/PENDING.md, docs/LAUNCH_CHECKLIST.md and docs/verification.md keep each lane's appended section.
- **Fixes the merge needed.** (1) The health route classifies with `isCheckoutOpen()` (P20-01) instead of Lane 4's `isStripeConfigured()` placeholder, which Lane 1 renamed. (2) Lane 4's status.test.ts fake now reports a run for every `CRON_JOBS` entry and the restore drill, so new crons do not leak into its exact warning list. (3) The two drill age seeds: `restoreDrill.maxAgeDays` (operations.ts, the one `restoreDrillWarning` reads) stays and the unread `healthLimits.drillMaxAgeDays` is removed; docs/ops/ALERTS.md names the kept seed. (4) P20-23's facts.test.ts gate: `backupMaxDays` is `max(backup.dailyKeepDays, backup.monthlyKeepDays)` (180) from the seed, and `logDays` is the new seed `errorReportRetentionDays` (30, Sentry's Developer plan lookback, decision 13; PHASE_19's request log retention replaces it at the final combine). The privacy page's retention table now states both, so its fingerprint in lib/legal/pages.test.ts is recorded again under 2026-10-01; move the Last updated dates to the ship day at the final combine as P20-23 says.
- **Still open for the final combine** (from the lane notes): PHASE_18's readers move to their `ops:` keys and their `keepStored` rows leave growth.ts (P20-20); trigger/package.json's `./spend-alerts` subpath is added by both Lane 1 and PHASE_18; the health status source scan needs a severity row for PHASE_18's `lifecycle_email_not_configured`; PHASE_19's privacy and terms text merges into the lib/legal structure and its "within thirty days" sentence moves into lib/legal (pages.test.ts fails until then, on purpose); the billing-reconcile and backup crons go into render.yaml with P20-21.

### Release 2 review fixes and gate (p20/integration, 2026-10-02)

Two reviews of f22e92d (billing, security and RLS: 1 major, 10 minor; law, copy and correctness: 8 major, 12 minor) found no blocker. Every finding was applied (the law review's item 20 was a pass: rule 9 holds); none was rejected. Overlaps were fixed once: schedule release notices (security 2, law 7), the reconciler order (security 8, law 18) and the Pro yearly configuration (security 10, law 11). One commit per area on `p20/integration`, after f22e92d.
- **Plan changes (security 1 and 10; law 3 and 11).** `planChangeDirection` calls a change an upgrade only when the price is in `upgradeTargets(from)`: from monthly, the same plan yearly and every bigger plan sold online at either cadence; from yearly, only the bigger plans' yearly prices. Yearly to monthly is a downgrade by email even onto a bigger plan ("Email us to switch to monthly billing. It takes effect at your next renewal."), so Growth yearly to Pro monthly no longer takes the year's credits back at once. The portal configuration is chosen per plan and cadence (`STRIPE_PORTAL_UPGRADE_CONFIG_<TIER>` for monthly, `_<TIER>_ANNUAL` for yearly, listing yearly prices only; Pro monthly gets `_PRO` for Pro yearly), and a missing one falls back to the default configuration (Switch plan off), which is safe. The plan picker starts on the subscriber's cadence (`subscriptions.cadence` now reaches `SubscriptionView`), shows the email line for any downgrade, and labels the current plan's move to yearly "Switch to yearly billing" with its renewal terms beside it; the finish upgrading card follows the same rule. Health checks all five configurations.
- **Renewal terms, consent and plan emails (law 1, 2, 3 and 8; security 6).** The yearly disclosure adds "If you cancel, you keep your plan until the end of the year you paid for. We do not refund the rest of the year."; promotion codes stay on and Checkout's `custom_text.submit` adds "If you use a promotion code, Checkout shows the discounted price and how long it lasts. After that, your plan renews at $X a month." (the simpler option); `RENEWAL_DISCLOSURE_VERSION` is `2026-10-02.2`, with a fingerprint test of every renewal text per plan and cadence keyed to it. The activation email states "Renews at: $X a month plus any tax that applies" from the seed (", less any discount that still applies" when the invoice had one) and what canceling means; a paid upgrade (`invoice.paid` with `subscription_update`) sends the same acknowledgment for the new plan, once per invoice (`billing:email:plan_changed:<invoice>`). `billing_consents` gains `email`, `stripe_customer_id`, `disclosure_text` (copied from the session's `custom_text`, so its sha256 is the stored hash) and `portal_session_id`; `checkout_session_id` becomes nullable with a check that exactly one session id is set; a plan change opened from /app/billing writes a row with the terms that sat beside the button, keyed by the portal session. Client roles lose insert, update, delete and truncate grants on the table (the 0026 pattern), tested on a Supabase shaped database. A session whose checkbox was not accepted writes no row (tested).
- **Billing health (law 4, 5, 6 and 13; security 5).** Checkout stays closed until `BILLING_EMAIL_FROM` and `RESEND_API_KEY` are both set (readiness problem `billing_email_not_configured`, which replaces `billing_email_from_missing`); every plan email records its result in `billing:email:last_result`, and health warns `billing_email_failing` after a refusal. The five readiness codes are degraded once billing is meant to be live (`billingLive`: a live key, or a checkout opened before; new `whileBillingNotLive` rule field), so a broken setup after launch no longer shows as info; `stripe_webhook_quiet`, the endpoint mismatch, the portal configurations and the new `legal_facts_pending` keep the checkout open rule. /app/billing shows Update card and the portal whenever the key and a customer exist. The config report runs the billing signals, recipe, cron and size reads at once, and the health route runs the preflight and breaker reads beside it.
- **Released schedules (security 2, law 7).** An upgrade with a schedule attached answers 409 `scheduled_change_pending` ("This cancels your move to Starter on November 3, 2026. Choose Continue to upgrade anyway.") and releases only on Continue; the cancel flow says the same at its top before any choice; every release writes an `events` row `billing:schedule_released:<schedule id>` and emails the founder; a Stripe failure after a release says the move was already canceled.
- **Reconciler (security 8 and 9, law 18).** It lists the whole window, processes the oldest `maxEventsPerRun` and records `resumeFrom`, so the next run carries on from there (health warns `stripe_reconcile_behind` while a run hits the cap). An event rendered at another API version than the pinned one fails as `api_version_mismatch` and is never applied; docs/STRIPE_SETUP.md section 3 says to set the account default version.
- **Security minors 3, 4, 7 and 11.** The Sentry scrubber replaces email addresses. No `tunnelRoute` until P20-14 ships the browser SDK. The restore drill restores the backup the site recorded (new `GET /api/cron/backup-report`, CRON_SECRET) and refuses a download whose size or sha256 differs, a key missing from the bucket or dated in the future, and a pg_restore without the CVE-2025-8714 fix (17.6 or later on 17). The operator grant's events claim carries a neutral label; the note stays in `ops_audit`.
- **Law minors 9, 10, 12, 14, 15, 16, 17 and 19.** Privacy keeps the consent record "3 years after you agree, or 1 year after your plan ends if that is later" (seed `renewalNotices.consentRecordYearsAfterPlanEnds`; P20-39 keeps `billing_consents` and the `billing:email:` rows for max(accepted_at plus 3 years, plan end plus 1 year)). The terms and the negative balance notices no longer say a smaller plan takes credits back mid period. A paused subscriber can still cancel (no offers while paused). The home pricing grid is one row of four. Cloudflare lists the encrypted database copies; the billing help article describes the cancel flow. ALERTS.md and LAUNCH_CHECKLIST.md name all four crons and the backup's 26 hour limit. The billing store's grant and clawback races run through `DbBillingStore` in apps/web/src/lib/billing/ledger-race.pg.test.ts (shared `@curvi/db/race` helper; the CI job runs both suites); both suites passed once on a local Homebrew Postgres 14 cluster with 0027's `security_invoker` stripped for that run only. `pnpm billing:verify` prints the cadence, the consent rows and the plan emails sent.
- **Legal fingerprints.** The privacy, terms and subprocessors text changed, so pages.test.ts records them again under 2026-10-01; move the Last updated dates to the ship day at the final combine (P20-23's rule). `TERMS_VERSION` is unchanged (nothing has shipped).
- **Rule 7.** docs/verification.md, "PHASE_20 (checked 2026-10-02): Release 2 review fixes": the event `api_version`, invoice `total_discount_amounts`, the session `custom_text` and CVE-2025-8714.

**Release 2 status.**
- Built on `p20/integration` (not merged to main, not pushed; PHASE_19 and PHASE_18 merge first): P20-01, P20-02, P20-05, P20-06 (P0 stopgap), P20-07 (P0 part), P20-08, P20-10, P20-11, P20-13 (server side), P20-15, P20-17, P20-20, P20-23, P20-66.
- Partial: P20-03 (the optional `e2e/billing-stripe.spec.ts` that fills Stripe Checkout is not built; the fixtures are written from documented shapes until the founder captures test mode events); P20-04 (the report is built; decision 2's numbers are not recorded); P20-06's P1 schedule and P20-07's P1 notices are Release 3; P20-10 and P20-11 need their first live run; P20-13's browser SDK and tunnel come with P20-14; P20-23's entity, address and governing law are null until counsel (health shows `legal_facts_pending` once Stripe is set up); P20-20's PHASE_18 readers move to `ops:` keys at the final combine.
- Migrations: `0028_ops_switches_and_audit` and `0029_billing_terms` on top of `0027_site_visits` (0029 regenerated on 2026-10-02 with the review's columns, never applied anywhere; `pnpm db:generate` reports no schema changes). After the PHASE_19 and PHASE_18 combine they become `0038_ops_switches_and_audit` and `0039_billing_terms`: regenerate from the merged schema and re-append each hand written block.
- Env vars for Release 2. Web: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, every self serve `STRIPE_PRICE_*`, `STRIPE_PORTAL_UPGRADE_CONFIG_STARTER`, `_STARTER_ANNUAL`, `_GROWTH`, `_GROWTH_ANNUAL` and `_PRO` (the yearly and Pro ones are new today), `BILLING_EMAIL_FROM` and `RESEND_API_KEY` (both now required for checkout), `FOUNDER_ALERT_EMAIL` (reconcile and release emails), `NEXT_PUBLIC_SENTRY_DSN` or `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `CRON_SECRET`, `OPS_EMAILS`; optional `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `STRIPE_TAX_ENABLED`. The `curvi-backup` cron only: `BACKUP_DATABASE_URL`, `BACKUP_AGE_RECIPIENT`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `HEALTHCHECKS_BACKUP_URL`, `CRON_SECRET`, `NEXT_PUBLIC_SITE_URL`. The founder's machine: `OPS_OPERATOR_EMAIL`, a read only `BACKUP_R2_*` token, `CRON_SECRET` and the site URL for the drill. CI: `TEST_DATABASE_URL`. The lines for .env.example are in docs/PENDING.md.
- Rule 6 gate on this branch, 2026-10-02 (code at 743044f): `pnpm lint` clean; `pnpm typecheck` clean; `pnpm test` 4,732 passed and 5 skipped in 340 files (packages/ai 269, specs 34, db 192 plus 2 skipped, pipeline 882, video 50 plus 1 skipped, cli 60, trigger 602, web 2,643 plus 2 skipped; the skipped include both race suites, which need `TEST_DATABASE_URL`); `pnpm e2e` 122 of 122 passed (demo build, Playwright on port 3199); `pnpm db:generate` reports no schema changes.
- Release 2 gate steps only the founder can do (mirrored in docs/PENDING.md, "Phase 20 Release 2 gate"): see that list.

### Final combine (release/2026-10-02, 2026-10-02)

`release/2026-10-02` is `release/p19-p18` (PHASE_19 then PHASE_18) with `p20/integration` merged on top (`git merge --no-ff`). Not pushed.
- **Migrations.** PHASE_19 and PHASE_18 keep 0028 to 0037. Release 2's two became `0038_ops_switches_and_audit` and `0039_billing_terms`: the files and journal entries were renumbered (idx 38 and 39, their `when` values unchanged, both above 0037's), and the two snapshots were rebuilt as 0037's snapshot plus Release 2's own table changes (ops_audit; billing_consents, subscriptions.cadence, cancel_flows.released_schedule_id and the nullable reason), chained 0037, 0038, 0039 by prevId. Each hand written block now uses 0028's `no_oauth_clients` DO block (FOREACH over the new table) instead of the auth.jwt() guarded form, so the every table check in packages/db mcp-connections.test.ts covers ops_audit and billing_consents. `pnpm db:generate` reports no schema changes.
- **Auth callback.** `finishSignIn` (lib/auth/finish.ts) now runs every post sign in step of release/p19-p18 in the same order: the terms record, P18-01's signup confirmation with Google's `attr`, the conversion, and on a fresh verification the free preview and prospect claims, the pending referral and the welcome page with the first run profile, which a ChatGPT consent `next` skips (P19-09). The callback keeps only the exchange and P18-13's `?error=` handling. finish.test.ts runs the extended effect table through both.
- **Shared files, both sides kept.** The Stripe webhook runs PHASE_18's funnel and referral steps, then records the webhook success; the reconciler (P20-02) now runs the same two steps on every replayed event (`afterEvent`, skipped in a dry run; a failed referral step is listed as `after_event_failed` and retried by the next run). `CRON_JOBS` holds all seven jobs. config-health reads PHASE_18's fal balances beside PHASE_20's parallel reads. Pricing keeps PHASE_18's signup links, waitlist gate and per pack line with P20-07's renewal terms and P20-08's On the way list; the home pricing row of four keeps the founding banner. The seed drops the `output_options_enabled` row (P20-20) and keeps PHASE_18's switch rows.
- **Combine notes done.** The legal Last updated dates moved to 2026-10-02 (`TERMS_VERSION` too, since no version after 2026-09-28 has shipped) with new fingerprints; PHASE_19's assistant section sits before the retention table, which gained an `assistant_connections` row, and its retention paragraphs (with "within thirty days") are gone; the assistant section's log days read `LEGAL_FACTS.retention.logDays`; `freePreviewDays` is `freePreview.retentionDays`; the terms keep "Connected assistants" after Credits; support-copy.ts reads the support email and reply time from LEGAL_FACTS. PHASE_18's out of credits email and the referral rules state `CREDIT_TERMS_SENTENCE`, and referral rewards carry no expiry (`referralReward.expiresMonths` removed). `lifecycle_email_not_configured` has a severity row (degraded) and an ALERTS.md row. P20-20's move is done: PHASE_18's six switches (`acquisition_paused`, `deploy_restarts_enabled`, `lifecycle_email_enabled`, `free_preview_enabled`, `referrals_enabled`, `founding_offer_enabled`) are read from their `ops:` keys (the seed constants in growth.ts now hold the `ops:` key, so each reader keeps its own fail closed rule), the `keepStored` rows left growth.ts, a missing free preview row reads as its `opsSwitchDefaults` default (on), and the founder docs flip them with an upsert on the `ops:` key. The founding banner follows `isCheckoutOpen` and the referral card check `hasStripeApiKey` (P20-01 renamed `isStripeConfigured`). PHASE_20's two db migration tests build their database with the shared auth shim, since 0028 runs before them.
- **Left open.** The plan emails stay on `sendBillingEmail`: P18-06's `sendEmail` refuses every send while `lifecycle_email_enabled` is off (it ships off) and dedupes in `email_sends` rather than the events claim, so the move is not a small change. P18-11's Growth line "API keys for the Curvi API and MCP server" is not added: the seed's `apiAccess` is live while the site flag `agentApi` is coming soon, so the card flag and seed sync test would fail; add it with `needs: ["agentApi"]` in the change that flips `agentApi` (P19 step 10). render.yaml still lacks the billing-reconcile and backup crons (P20-21, Release 3).

### Items

One paragraph per item, with a blank line between items, so two lanes never edit neighbouring lines.

**P20-01.** Built on p20/billing-core (Lane 1), 2026-10-01; not merged. apps/web/src/lib/billing/readiness.ts `billingReadiness(readEnv)` returns `{ checkoutOpen, apiKey, problems, environment, keyMode }`; env.ts has `hasStripeApiKey()` (the five non selling uses) and `isCheckoutOpen()` (the nine selling call sites). The webhook records `webhook:stripe:last_success` and the checkout route `checkout:last_opened` (lib/billing/signals.ts); lib/billing/billing-health.ts adds the warnings to config-health.ts in one block; the stripe entry of `/api/health/providers` carries `checkoutOpen` and the problem codes. Deviations: (1) one more code, `stripe_secret_key_missing`, when some Stripe variable is set without the key; with no Stripe variable at all nothing is reported (billing is off on purpose). (2) `stripe_webhook_quiet` is narrowed so an abandoned checkout does not raise it: the checkout must be older than two `billingReconcile.everyMinutes` intervals, and a reconcile run after the checkout that saw no Stripe event created since clears it. (3) The optional `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is checked only when set (the app reads no publishable key today). (4) Self serve tiers are those without `selfServe: false`, so Agency prices stop being required the moment Lane 2's P20-08 seed field lands, with no change here. Tests: readiness.test.ts (every combination, staging and production URL cases), billing-health.test.ts (quiet window, endpoint mismatch, the config report on PGlite), routes.test.ts (503 with a key but no webhook secret, and for a test key on the production URL), billing-render.test.ts and claims.test.ts (pricing, billing and help closed with the key alone), providers route test (`checkoutOpen`). The webhook's success record is asserted in P20-03's flow suite. Test helper lib/billing/test-env.ts (`stubOpenCheckout`, `stubKeyOnly`) replaces the old "secret key alone opens" stubs in six suites.

**P20-02.** Built on p20/billing-core (Lane 1), 2026-10-01; not merged. apps/web/src/lib/billing/reconcile.ts `reconcileStripe({ stripe, store, priceTable, since, maxEvents, lookup, workspaceExists })` replays the handled events oldest first through `processStripeEvent`; `CREDIT_ACTIONS` and `classifyOutcome` decide applied, already applied and ignored; `DryRunBillingStore` (over the new read only `DbBillingStore.isClaimed`) backs `?dryRun=1`; `checkWebhookEndpoint` and `composeReconcileEmail` as planned. lib/billing/reconcile-run.ts runs one pass (replay, endpoint check, founder email through `sendFounderEmail`, now exported as `@curvi/trigger/spend-alerts`, the same subpath PHASE_18 adds), records `billing:reconcile:last_run` and `recordCronSuccess`. Route app/api/cron/billing-reconcile; `CRON_JOBS` entry `billing-reconcile` every `billingReconcile.everyMinutes`. Deviations: (1) the reconciler passes the read only lookup (no actions), so a replayed subscription event writes Stripe's current state instead of an old payload, which would flip `workspaces.plan` back and forth on every run; "makes no Stripe call" is tested as no Stripe write. (2) "Acknowledged" is decided by the workspace the event names (metadata, client_reference_id or the invoice's subscription details) not existing, whatever the error type; an unroutable event that names no workspace stays a failure, since a never linked customer looks the same. (3) A failure that stays failed is emailed once (the reported ids live in the last run record, pruned to the lookback) instead of on every run. (4) The email counts grants ("payments were missing credits") apart from clawbacks, restores and debits. (5) Without a Stripe key the route counts as a successful run, so the cron is not reported as never run while billing is off. (6) When more than `maxEventsPerRun` events are in the window, the newest ones are processed and the run says `truncated`. Tests: reconcile.test.ts on PGlite (two runs apply once, webhook then reconcile, nothing counted for syncs and notes, no Stripe write on a subscription replay, dry run, a throwing event, a deleted workspace, one email per failure, the acceptance case, paging past 100 and the cap, grant before refund, endpoint check cases, email copy), the route test, and cron-health and config-health updated for the new entry. Until P20-38's tick, the founder adds the route to the `curvi-stale-jobs` command (docs/LAUNCH_CHECKLIST.md, "Phase 20 billing core"). Review fixes 2026-10-02 (security 8 and 9): oldest first with `resumeFrom` instead of deviation (6), `stripe_reconcile_behind`, and `api_version_mismatch`; see "Release 2 review fixes and gate".

**P20-03.** Built on p20/billing-core (Lane 1), 2026-10-01; not merged. Flow suite apps/web/src/lib/billing/billing-flow.test.ts posts fixtures signed with `generateTestHeaderString` (timestamp in seconds) to `POST /api/webhooks/stripe` with `DbBillingStore` on `createTestDb`; Stripe's subscription read and the duplicate actions are faked in memory and the actions are asserted unused. Cases: monthly and annual start, renewal, top up paid at once and paid later, upgrade mid period, immediate downgrade (below zero), a full refund of a subscription invoice, partial then full top up refunds, dispute won and lost, duplicate delivery, subscription events out of order (payload only and with Stripe's read), an event that routes to no workspace (500, nothing written, no success recorded), and a signature 301 seconds old (refused). Each asserts the ledger, `workspaces.plan` and the subscriptions row; the first also asserts P20-01's `webhook:stripe:last_success`. Fixtures in lib/billing/fixtures/ (seven JSON templates with `{{PLACEHOLDER}}` values and a loader that refuses a missing value) are written from Stripe's documented basil shapes and the installed SDK types; replacing them with the founder's captured test mode events, scrubbed into the same placeholders, is still a founder step. Race suite packages/db/src/ledger-race.pg.test.ts (20 parallel reserves over a balance of 10, parallel charges of one job and step, parallel identical grant claims, a reserve racing a refund clawback), skipped unless `TEST_DATABASE_URL` is set; CI job `ledger-race` runs it on a `postgres:17` service container. It was run once on this laptop against a throwaway Homebrew Postgres 14 cluster (no Docker), all four passing, with migration 0027's `WITH (security_invoker = true)` stripped for that run only, because Postgres 14 does not know the view option; the committed suite applies the migrations unchanged and needs Postgres 15 or later, so its first unmodified run is the CI job. `pnpm billing:verify --workspace <id>` is built (lib/billing/verify.ts loader and formatter, scripts/billing-verify.ts; verify.test.ts on PGlite). Not built: the optional `e2e/billing-stripe.spec.ts` that fills Stripe Checkout with a test card (`STRIPE_E2E=1`, never in CI).

**P20-04.** Built on p20/billing-core (Lane 1), 2026-10-01; not merged; decision 2 not yet recorded. Seed `economics = { targetGrossMargin: 0.6, paymentFee: { percent: 0.029, fixedUsd: 0.3 }, minGrossMargin: 0.4 }` (packages/pipeline/src/seed/economics.ts; the fee is Stripe's US domestic card rate, checked 2026-10-01; `minGrossMargin` is this lane's default for P20-47's alert, which the plan left unnumbered). Pure math in `@curvi/pipeline/economics`: `creditOffers` (every paid tier at both cadences, every top up, the founding offer at both cadences, and the cancel flow's save offer on monthly plans, each before and after the fee), `priceFloor`, `creditsPerStill` (the rule, rounded up to the next half credit), `percentile`, `distribution`, `buildEconomicsReport`. Reads in apps/web/src/lib/ops/economics.ts, all in one READ ONLY transaction: delivered shots (approved assets of `done` packs, method, cost and attempts from `assets.qc`), undelivered shot cost, packs (`cogs_micros`, `credits_charged`, LLM cost per family from the `llm|job|...` counters) and `job_steps` cost by stage and status. `pnpm report:unit-economics --days 30` prints cost per delivered shot by method, cost per pack at list price and with the OpenAI credit (LLM cost of a family inside `llmCreditWindows` at zero), retry overhead (share of shots retried, mean attempts, cost of shots not delivered), cost by stage, revenue per credit for every offer, the floor before and after the fee, and the rule's answer. Deviation: shot cost by method reads `assets.qc` (which carries the planned shot's exact method) instead of joining `job_steps` to a method (job_steps carries only a stage label); job_steps is reported by stage. Today's floor: with Agency still self serve on this branch it is the Agency monthly save offer ($0.0698 a credit); once Lane 2's P20-08 sets `selfServe: false` it is the founding annual offer ($190 / 2,400 = $0.0792), as the plan says. The worked examples hold: a p90 of $0.08 gives 3 credits, $0.06 gives 2. Tests: packages/pipeline/src/economics/economics.test.ts (offers from the seed, the floor as the minimum over every self serve and promotion offer, Agency off self serve, the rule and the examples), seed billing-core.test.ts, apps/web/src/lib/ops/economics.test.ts (PGlite fixtures: the window, failed packs left out, the credit view, nothing written, the plain copy). Founder: run the report against production (or the golden set live if traffic is thin) and record decision 2 here with its numbers before live keys.

**P20-05.** Built on p20/integration (Lane 2 Billing terms), 2026-10-01. Seed credits.ts: `TopUp.expiresMonths` and `rolloverPolicy` removed, `creditExpiry = { kind: "none" }` added and exported. `PriceMapping` for a top up is `{ kind, credits }`; `CreditGrant` has no `expiresMonths`, and `DbBillingStore.recordGrantOnce` never writes `credit_ledger.expires_at` (the column stays, unused, for a later credit lots item). Migration `billing_terms` (0029 here, shared with P20-07) clears `expires_at` on every `reason = 'topup'` row. One `CREDIT_TERMS_SENTENCE` in lib/marketing-facts.ts replaces `UNUSED_CREDITS_SENTENCE` and `topUpMonths()`; /pricing (the unused credits card, and the top up card loses its lifetime), the /app/billing plans line and the new line under the top ups, the "how credits work" and "billing and cancellation" help articles, the home pricing line, the paywall and the terms (through `LEGAL_FACTS.creditTermsSentence`) all show it. The terms text changed, so its fingerprint in lib/legal/pages.test.ts is recorded again under 2026-10-01. docs/STRIPE_SETUP.md states the rule. Not done here, as the plan says: PHASE_18's `out_of_credits` template and P18-24 reward rows adopt the sentence when they merge, and the operator agent updates docs/marketing.md (C-16, T-DIR-06, the out of credits template) by 2026-10-18 with the founder's approval. Tests: seed billing-terms.test.ts (no expiry or rollover field anywhere in the credit seed), packages/db billing-terms.test.ts (the migration clears top up expiries and changes no amount), db-store.test.ts (a top up and a plan grant write no expiry), stripe-webhook.test.ts (price table), marketing-facts, claims (no lifetime or "expire" in any live copy), billing-render and legal facts tests.

**P20-06.** P0 stopgap built on p20/integration (Lane 2 Billing terms), 2026-10-02; the P1 schedule part waits for Release 3. lib/billing/checkout.ts: `createPlanChangePortalSession` now reads the subscription's current price, compares it with the chosen one (`planChangeDirection`: a bigger plan or monthly to yearly is an upgrade; a smaller plan, yearly to monthly or an unknown current price is a downgrade) and returns `downgrade_by_email` for a downgrade, which the checkout route answers with 409 and "Email us to move to a smaller plan. It takes effect at your next renewal."; an upgrade releases any attached subscription schedule first and opens the portal with `configuration` set to the current tier's upgrade only configuration (`STRIPE_PORTAL_UPGRADE_CONFIG_STARTER` and `_GROWTH`, listing only the plans above, never Agency; Pro needs none). The /app/billing plan picker shows that email line on smaller plans for a subscriber. The cancel flow's smaller plan save offer is hidden by the new seed flag `retentionOffers.smallerPlanOffer: false`; `applyCancelChoice` releases an attached schedule before pause, discount or cancel and records it in the new `cancel_flows.released_schedule_id` (migration `billing_terms`). Health: `stripe_portal_upgrade_config_missing` (a `stripe_*` code) once checkout is open and a configuration variable is unset. docs/STRIPE_SETUP.md section 5: Switch plan off in the default configuration, the two upgrade only configurations, downgrades by email. Deviations: the configurations are read from env vars (the plan names no source), and the cancel record keeps the released schedule in a new column rather than in the existing free text. Tests: checkout.test.ts (directions, targets, configuration on both flows, no portal or release for a downgrade, release before an upgrade, portal home on the same price), checkout-guard.test.ts and routes.test.ts (409 `downgrade_by_email`, nothing opened), cancel-service and cancel-flow tests (offer hidden by default and refused; release before pause, discount and cancel, recorded; nothing changed when the release fails), billing-health.test.ts, billing-render.test.ts (the picker), packages/db billing-terms.test.ts (the column), e2e retention.spec.ts updated. Founder: create the two upgrade configurations and turn Switch plan off in the default configuration (test mode now, live at the gate), set the two variables on Render, and schedule any emailed downgrade in the Dashboard for the period end. Review fixes 2026-10-02 (security 1, 2 and 10; law 3, 7 and 11): five configurations by plan and cadence, yearly to monthly by email, the scheduled change confirm step and release notices; see "Release 2 review fixes and gate".

**P20-07.** P0 part built on p20/integration (Lane 2 Billing terms), 2026-10-02; the P1 notices wait for Release 3. Seed credits.ts `taxDisplay` and `renewalNotices` (exported on their own line). lib/billing/renewal-terms.ts builds the monthly and yearly disclosure, the price change line, the checkbox and the tax line from the seed, with `RENEWAL_DISCLOSURE_VERSION`; components/marketing/renewal-terms.tsx shows it beside every plan buy button (pricing cards, the /app/billing plan picker and the finish upgrading card; dated with the first renewal where the page knows it, "your next renewal date" on the static pricing page); the tax line shows on pricing and billing only while Stripe Tax is on. Checkout (`checkoutDisclosure` in checkout.ts) sets `custom_text.submit` to the same terms and `custom_text.terms_of_service_acceptance` to the renewal checkbox (each within 1,200 characters), and writes `disclosure_version`, `disclosure_sha256` (of the exact text) and the buyer's `userId` into the session metadata; top ups keep the plain terms checkbox. Migration `billing_terms`: tenant table `billing_consents` (owners and admins read, no client writes, `no_oauth_clients`, `workspace_id` set null on delete, unique per Checkout Session, email kept as the 0012 normalized key), `subscriptions.cadence`, and `cancel_flows.reason` nullable. The webhook writes the consent on `checkout.session.completed` when `consent.terms_of_service` is `accepted`, copying the version and hash from the metadata, and writes the cadence from the price interval on every subscription event. Activation email (lib/billing/billing-email.ts): on `invoice.paid` with `subscription_create`, after the grant, `sendBillingEmail` sends from `BILLING_EMAIL_FROM` with replies to hello@curvi.ai through the new `sendResendEmail` in trigger/src/spend-alerts.ts (the founder alert fetch path, with an `Idempotency-Key`), deduplicated by the events claim `billing:email:plan_active:<invoice id>` (no workspace, so it outlives an account deletion); a failed send gives the claim back, so a Stripe retry or the P20-02 reconcile (which now passes the sender, except in a dry run) sends it later; without the sender nothing is claimed and health warns `billing_email_from_missing`. Cancel flow: the reason is optional (route, service, Stripe feedback only when given); after the reason, "Want to see other options first?" asks once, "No, cancel my plan" cancels in one click, the offers step always shows "Cancel my plan" beside the offers, and the done line is "Your plan is canceled. You keep it until {date}." docs/STRIPE_SETUP.md section 6: Stripe's renewal reminder emails off; sections 2 and 4 describe the variables and the Checkout text. Legal facts now read `consentRecordYears` and `annualWindow` from the seed, so the privacy retention table lists the consent and billing email records and the terms promise the yearly reminder; both fingerprints are recorded again under 2026-10-01 (move the dates at the final combine with P20-23's rule; TERMS_VERSION was left alone because a new version needs its own accept step). Deviations: the activation email states the amount charged today and "your plan's price" for renewals instead of a seed list price, so a founding offer or promotion code is never misstated; on the static pricing page the deadline reads "your next renewal date". Tests: renewal-terms.test.ts (seed numbers, dates, rule 9, the 1,200 limit, the hash), checkout.test.ts, billing-flow.test.ts on PGlite (one consent row per session copying the metadata, a replay keeps an old version, the cadence, one activation email across a retry and a renewal, the claim given back on a Resend failure, nothing without the sender), billing-email.test.ts (content, no offers, one send across the webhook and a reconcile replay on one database), cancel flow, service and route tests (reason optional), billing-health.test.ts, packages/db billing-consents.test.ts and billing-terms.test.ts (RLS, no client writes, outlives the workspace, `no_oauth_clients`, cadence read only), seed tests, legal tests; e2e retention.spec.ts updated (not run here). Needs a live run: the test mode acceptance in docs/PENDING.md (Lane 2 step 7). For P20-39: keep `billing_consents` and the `billing:email:` events rows for `consentRecordYears`. Review fixes 2026-10-02 (law 1 to 8; security 6): version `2026-10-02.2` with the yearly cancel and promotion code lines, the renewal price in the emails (the deviation above about "your plan's price" no longer holds), the plan change acknowledgment and consent, the consent row's text, email and customer, `billing_email_not_configured` replacing `billing_email_from_missing`; see "Release 2 review fixes and gate".

**P20-08.** Built on p20/integration (Lane 2 Billing terms), 2026-10-01. Seed `TierDefinition.selfServe` (required; false only for Agency). lib/billing/plans.ts adds `selfServeTiers`, `selfServeTierKeys`, `isSelfServeTierKey`, `LARGER_PLAN_LINE` and `LARGER_PLAN_EMAIL`; readiness and the economics floor now read the field directly, so checkout no longer needs `STRIPE_PRICE_AGENCY_*` and the floor is the founding annual offer. Plan cards (/pricing and the /app/billing plan picker) show Starter, Growth and Pro with live lines only ("Everything in Starter", "Everything in Growth"); every line that does not run yet moves to one "On the way" list under the cards (components/marketing/on-the-way.tsx over `onTheWay()` in plan-features.ts, each line with the smallest plan sold online that gets it and the Coming soon badge), followed by "Need more than Pro? Email us and we will set up a larger plan." with hello@curvi.ai. Checkout and plan requests answer 400 `tier_not_self_serve` for Agency; the plan intent parsers (billing and signup) ignore an Agency link; the paywall never suggests Agency; the home pricing cards, llms.txt and the JSON-LD offers list only the plans sold online. Settings Shopify row: "The Shopify app is on the way. Your packs already use Shopify ready file names." with a link to /help (lib/integration-copy.ts, shared by the database and demo services) until P20-26 ships the article. docs/STRIPE_SETUP.md section 1: three products, Agency prices not created yet. Not done: P18-11's Growth API line (`needs: ["agentApi"]`) lands with P18-11, as the boundary table says. Tests: plans.test.ts (self serve set, no coming soon line in any card, the On the way list, intent parsing, and FEATURES against the seed's `featureStatus` for every flag a card reads), routes.test.ts (Agency refused before Stripe on checkout and requests), billing-render.test.ts (pricing and billing cards, the list, the larger plan line, a crafted Agency link), paywall, readiness, economics, the seed and lib/integration-copy.test.ts; e2e billing.spec.ts and marketing.spec.ts updated (not run here).

**P20-09.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-10.** Built on `p20/data` (Release 2), not merged. ops/cron/Dockerfile (`postgres:17-bookworm` with age, rclone and curl; `PG_MAJOR` build argument), ops/cron/backup.sh, ops/r2/backups-lifecycle.json and ops/r2/backups-lock.json, `POST /api/cron/backup-report` (CRON_SECRET; writes `backup:last` through apps/web/src/lib/ops/backups.ts and records the `backup` cron), the `backup` entry in `CRON_JOBS` and seed `backup` in operations.ts. Deviations: (1) the row count manifest is read from the dump files themselves (the COPY blocks `pg_restore --data-only` prints), not through psql, so the counts match the dump exactly while the site keeps writing; it also carries the credit ledger total in tenths and the newest migration, which the drill compares; (2) `CronJobDefinition` gains an optional `maxAgeMinutes`, so the backup goes overdue after the seeded `maxAgeHours` (26) instead of twice its daily interval; (3) a new variable `BACKUP_R2_ACCOUNT_ID` builds the R2 endpoint, and the report goes to `NEXT_PUBLIC_SITE_URL`; (4) seed `backup` adds `abortMultipartDays` (1) so the lifecycle lint covers every rule. Tests: the report route (auth, validation, size limit, demo, write failure), the PGlite write, the script with fake pg_dump, pg_restore, age, rclone and curl (exit codes, manifest, keys, report, pings, cleanup), the lifecycle and lock files against the seed, and cron freshness. Needs a live run: the server major (`SHOW server_version;`), that the pooler user may read `auth.mfa_factors`, and the first nightly run and decrypt (docs/ops/BACKUP_RESTORE.md, "Setting it up"). Hand to Lane 5b for P20-21: the `curvi-backup` cron service and its variables (docs/PENDING.md).

**P20-11.** Built on `p20/data` (Release 2), not merged. `pnpm ops:restore-drill` (apps/web/scripts/restore-drill.ts, with the steps and target guard in apps/web/src/lib/ops/restore-drill.ts), ops/cron/verify-restore.sql (schema `drill_check`: the grants baseline, `fail_live_jobs` and nine checks), `POST /api/cron/restore-drill-report` (CRON_SECRET; writes `restore_drill:last`), `restore_drill_overdue` from config-health through `restoreDrillWarning` in lib/cron-health.ts (the drill records its pass under `cron:restore-drill:last_success`, so health reads it with the cron read and no extra query), seed `restoreDrill` in operations.ts and the drill sections of docs/ops/BACKUP_RESTORE.md. Deviations: (1) the drill is a TypeScript package script instead of ops/cron/restore-drill.sh, so the guard and every step are unit tested with fakes; it runs on the founder's laptop, not in the cron image; (2) the seed is `restoreDrill.maxAgeDays` (35) in operations.ts, not `healthLimits.drillMaxAgeDays` in monitoring.ts, so this lane and Lane 4 never edit the same constant; at the combine, if Lane 4 added `healthLimits.drillMaxAgeDays`, keep one of the two; (3) beyond the plan: the drill refuses a target that already has tables or users (so it never clears data that was there), checks the target's Postgres major against the backup's, loads the data and fails the live jobs in one psql transaction (Supabase's documented `session_replication_role = replica` restore), and reports each step's time and whether it beat the seeded 120 minute recovery target; (4) the plan's "staging project's URL" is read from `STAGING_DATABASE_URL` and `STAGING_SUPABASE_URL`, which P20-54 should use. Tests: the target guard (DATABASE_URL in any spelling, staging and production refs, hidden hosts, throwaway rules), the drill's steps and their order with fakes, cleanup on every path, the report route, the PGlite writes, and verify-restore.sql on PGlite (faithful restore passes; count, ledger, migration, grants, RLS, orphan and live job failures each caught). Touches config-health.ts with a two line read after the cron check (the serial list names no lane 3 edit there). Needs a live run: the first drill into a local stack, recorded in docs/verification.md and `restore_drill:last` (founder steps in docs/PENDING.md), which also settles whether the local Auth tables match the hosted ones. Review fixes 2026-10-02 (security 7): the drill restores the backup the site recorded (`GET /api/cron/backup-report`), checks its sha256, refuses future keys and a pg_restore without the CVE-2025-8714 fix.

**P20-12.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-13.** Built on `p20/observe` (lane 4), commit "P20-13: Sentry for the server and the inline runner"; not merged yet. `@sentry/nextjs` 11.2.0 (MIT): `apps/web/src/instrumentation.ts` (register plus `onRequestError = Sentry.captureRequestError`), `sentry.server.config.ts`, `sentry.edge.config.ts` and `lib/sentry/` (options, scrubber, limits, job scope, founder alert report); `next.config.ts` wraps the config with `withSentryConfig` (org, project, authToken, release from `RENDER_GIT_COMMIT`, `widenClientFileUpload`, `tunnelRoute: "/monitoring"`, plugin `telemetry: false`). Seed `monitoring.ts` `errorReporting` (20, 60, 150). Deviations: (1) SDK 11 has no `sendDefaultPii`; its replacement `dataCollection` collects user info, cookies, headers, bodies, query strings and local variables by default, so the init turns each off and allows only the scrubber's request headers (checked 2026-10-01). (2) `withSentryConfig` is imported from `@sentry/nextjs/config` (the SDK 11 path). (3) The plan's "enqueue.ts wraps runPack and settle in withScope" is done through a new optional runner dep, `inJobContext`, that runs each job's start, run, time cap timer and the runner's own log lines in `withJobScope`; the settle dep runs in it too. A crash and a time cap are reported as errors by the runner's existing `console.error` lines (the console capture, now tagged), a shutdown's interrupted and not started jobs as explicit warnings, and a failed settle once with its exception. (4) The trigger report hook needs no db-runtime line: spend-alerts.ts, llm-monitor.ts and provider-quota.ts take an optional `report` and default to the process wide hook in `trigger/src/alert-report.ts`, which `sentry.server.config.ts` installs when a DSN is set; this keeps PHASE_18's provider-quota.ts and runtime.ts edits conflict free. Each founder alert is a Sentry issue fingerprinted by kind and period, so each new period emails. Tests: scrubber (every `TOKEN_PATH_PREFIXES` path, the claim token, secret headers and values), limiter and caps, no DSN no op, the middleware matcher never covering `/monitoring` (read through Next's own matcher function), and an end to end file on the real SDK (fake DSN, events read in `beforeSend`) for crash tags, time cap, shutdown warnings, a failed settle, founder alerts, scrubbing and the repeat limit. A local `next build` without `SENTRY_AUTH_TOKEN` succeeds (settles the UNVERIFIED row). Variables for P20-21's render.yaml: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`. Needs a live run: a real error in Sentry with a source mapped stack and its `job_id` (founder step, docs/PENDING.md). Review fixes 2026-10-02 (security 3 and 4): emails scrubbed; `tunnelRoute` removed until P20-14.

**P20-14.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-15.** Built on `p20/observe` (lane 4), commit "P20-15: health status ok, degraded or down"; not merged yet. `HealthBody` gains `status` and `degradedBy` (down codes first); `ok` and the HTTP status are unchanged. The route adds `breaker_open:<stage>` (every configured provider of a pipeline stage open, `stageBreakerWarnings`) and the cached preflight verdict (`packs_paused:<cause>`, `scenes_paused`, read only while the database answers, under the config read timeout). `provider_quota:*` is degraded only when its provider sits in a paused stage (new `whileStageRunning` severity, `pausedProviders` context), otherwise info. Billing codes use `checkoutOpen: isStripeConfigured()` until P20-01 provides `isCheckoutOpen`. config-health gains `db_size_high` from `sum(pg_database_size(datname))` against seed `monitoring.ts` `healthLimits` (500 MB of 1024 x 1024 bytes, 0.7; `memoryStartRatio` 0.6 and `drillMaxAgeDays` 35 are seeded here for P20-34 and P20-11), with `databaseSize` in the detailed report; a failed read is logged and fails open. Tests: the severity table covers every `code:` written by a lib file named *health* or llm-spend.ts (a source scan, so PHASE_18's lib/email/health.ts is covered when it merges) and every code the route adds; unknown codes are degraded; a fal quota trip is degraded with HTTP 200 and ok true; no other public key is named status; e2e/health.spec.ts checks `status`. Known gap: an LLM stage counts as running while any model in its chains or escalations has a closed breaker, so an escalation only model can keep `breaker_open` quiet. Needs a live run: one detailed report in production showing `databaseSize` (Supabase may refuse `pg_database_size` on some database; then it stays null). Review fixes 2026-10-02 (security 5; law 5): reads run in parallel; readiness codes degraded once billing is meant to be live (`whileBillingNotLive`).

**P20-16.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-17.** Built on `p20/observe` (lane 4), commit "P20-17: alerts runbook and monitors"; not merged yet. New docs/ops/ALERTS.md: the channels (monitor A on `"ok":true`, monitor B on `"status":"ok"`, healthchecks.io, Render failed deploy emails, founder emails, Sentry), what to do when each monitor fires, every health code with its meaning and first action, the founder emails with their `alert` tags, the Sentry caps, the founder setup and the production safe checks, and the Resend rule for unverified senders (checked 2026-10-01). apps/web/src/lib/alerts-doc.test.ts fails when a down or degraded row of the severity table has no runbook row. docs/LAUNCH_CHECKLIST.md steps 13 and 15 and docs/PENDING.md ("Phase 20 founder steps: Sentry, health status and monitors") carry the founder steps. Needs a live run: the monitors, checks and drills are founder setup.

**P20-18.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-19.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-20.** Built on `p20/ops-basics` (Lane 5, 2026-10-01); not merged. Migration `ops_switches_and_audit` is 0028 on the lane branch (generated on 0027_site_visits; renumbered after PHASE_18's and PHASE_19's at the combine by regenerating from the merged schema and re-appending the delimited block). It is expand only: one `INSERT ... SELECT ... ON CONFLICT DO NOTHING` copies each stored switch row to its `ops:` key, as stored, and keeps the old key. `pnpm db:seed` refuses any `ops:` row (trigger/src/platform-settings.ts, before writing anything), and `output_options_enabled` left `platformSettingSeedRows`. `DbService.outputOptionsEnabled` reads `opsSwitch("ops:output_options_enabled", platformSettingReader(db))`, so a missing row now reads as the seed default (on, still behind `NEXT_PUBLIC_OUTPUT_OPTIONS`) where the old reader failed closed; production has the row, so the copy keeps its value. Decided at this lane (the contract left it to Lane 5): PHASE_18's `deploy_restarts_enabled` and `founding_offer_enabled` (seeded with `keepStored` on p18/integration) move to `ops:deploy_restarts_enabled` and `ops:founding_offer_enabled` (both default off, read error off), because the founder flips them by SQL; `store_audit_enabled` stays seeded, because PHASE_18 makes it a release gate set in growth.ts. New seed constant `opsSwitchLegacyKeys` maps each `ops:` key to its old key: the copy list, and the exact keys `ops_switches_contract` (Lane 5b) deletes. Deviations: `outputOptionsSwitchOn`, `resetOutputOptionsSwitchForTests` and `OUTPUT_OPTIONS_SWITCH_KEY` stay in lib/features.ts, unused by the app, because tests on p18/integration and p19/integration import them; the reset also clears the `ops:output_options_enabled` cache entry, and Lane 5b deletes all three with the contract migration. The rollback note ("check the old key") is in docs/PENDING.md, Lane 5 step 5, until Lane 5b writes docs/ops/RUNBOOK.md. At the combine: PHASE_18's readers (lib/acquisition.ts, lib/free-preview/gate.ts, lib/referrals/switch.ts, lib/offer/founding.ts, lib/jobs/restart.ts, and packages/email/src/store.ts, which cannot import apps/web and so reads the `ops:` key with `opsSwitchDefaults` itself) switch to their `ops:` keys, and those six keepStored rows leave growth.ts; packages/pipeline operations.test.ts fails until they do. Tests: packages/db ops-switches-and-audit.test.ts (the copy on a fixture with flipped switches, an existing `ops:` row kept, the old key still read, insert only), trigger platform-settings.test.ts (the loader refuses an `ops:` row; a re-seed leaves flipped `ops:` switches), pipeline operations.test.ts and entitlements.test.ts, web db-output-options.test.ts. Live check left: the acceptance run (flip `ops:acquisition_paused`, re-seed, still on) needs PHASE_18 merged and a real database.

**P20-21.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-22.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-23.** Built on `p20/trust` (lane 6, 2026-10-01), not merged yet. No migration, no new env var.
- What shipped: `lib/legal/facts.ts` now feeds every page. New `lib/legal/copy.ts` (reply time, entity and governing law lines, the annual reminder and change notice sentences, `pendingLegalFacts`), `lib/legal/retention.ts` (the privacy retention table rows and the settings sentence), `lib/legal/subprocessors.ts` (the vendor registry) and the page `(marketing)/legal/subprocessors`, linked from the footer and from privacy. Terms gain who we are, plans, renewal and cancellation, credits, refunds, AI outputs and governing law; privacy gains the retention table (`id="retention"`, `data-testid="privacy-retention"`), the processors in use and a contact section; help states the reply time; settings reads the upload window and links `/privacy#retention`. The entity, address and governing law are null and render as a marked "Pending" line (`data-testid="legal-pending"`) until the founder sets them (docs/PENDING.md, "Legal").
- Tests: lib/legal/facts.test.ts, copy.test.ts, retention.test.ts, subprocessors.test.ts, pages.test.ts; e2e/legal.spec.ts. facts.test.ts reads the seed by name, so the lane that seeds `renewalNotices` (P20-07), `backup` (P20-10), `tmpObjectDays` with `isWorkspaceTmpKey` (P20-40) or `freePreview` (P18-12), or adds `@sentry/nextjs` (P20-13), fails until it sets the matching number in facts.ts. pages.test.ts records a fingerprint of each page's text with its Last updated date, so a text change without a new date fails; it also fails when "non refundable", "thirty days", "N days old" or "rollover policy" appears outside lib/legal. The coverage test fails when a provider in `DEFAULT_PROVIDER_ENTRIES` or a health service has no vendor entry.
- Deviations: (1) A vendor is "in use" when this deployment sets the variables the code checks before calling it (Turnstile on `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, Upstash on both REST variables, the OpenAI Ads pixel unless set to an empty string), not by a flag in code; the marketing pages are built at deploy time, so a variable saved with Save only appears from the next deploy. (2) Shopify is a "connected service", not a subprocessor, listed apart and only once the Shopify app is live (FEATURES). (3) The source photo row says what purge.ts does: "We delete them once they are 30 days old and no pack from the last 30 days used them. A photo shown on a share page stays until you take that page down." The account row ends "The rows below say what we keep after that." While `backupMaxDays` is null the backup row states no number (the founder's manual dumps). (4) LEGAL_FACTS gains `annualRenewalReminderDays` (P20-07's `renewalNotices.annualWindow`), `termsChangeNoticeDays` 30 and `subprocessorsLastUpdated`. (5) The terms no longer say "image and video packs" or "before publishing" (video and publishing are coming soon). (6) `TERMS_VERSION` is 2026-10-01, the same line PHASE_19 changed, and terms.test.ts compares it with `LEGAL_FACTS.termsLastUpdated` instead of reading the page source. (7) lib/consent.ts exports `DEFAULT_OPENAI_ADS_PIXEL_ID`.
- For the lanes and the combine: lane 2 swaps the facts.ts import to `CREDIT_TERMS_SENTENCE` (facts.test.ts accepts either name) and sets `consentRecordYears` and `annualRenewalReminderDays` from `renewalNotices`. The billing email row says the record outlives account deletion: true once billing emails are recorded in P18-06's `email_sends` (`workspace_id` on delete set null); an `events` dedupe row is deleted with the workspace, so the combine moves the activation email record there first. Lane 3 sets `backupMaxDays` to the larger of `backup.dailyKeepDays` and `backup.monthlyKeepDays`. Once lane 4 adds Sentry, `logDays` is needed: PHASE_19's `REQUEST_LOG_RETENTION_DAYS` (30) at the combine, else the Sentry Developer lookback (30, decision 13). PHASE_18: `freePreviewDays` is `freePreview.retentionDays`. PHASE_19: in privacy/page.tsx keep this structure, keep `collectAssistants`, `sharingAssistants` and the assistants section before the retention table, replace `retentionAndDeletion` with the table plus a row for assistant connection records ("until you close your account, including after you disconnect"), and drop its "within thirty days after account closure" sentence; privacy-copy's log sentence reads `LEGAL_FACTS.retention.logDays`; terms keeps PHASE_19's "Connected assistants" section after Credits; support-copy.ts reads `LEGAL_FACTS.support.email` and `supportReplyTime(LEGAL_FACTS)`. After the combine, move the three Last updated dates to the ship day and record the new fingerprints.
- Known gaps: no data location per vendor (counsel may ask). California keeps consent records for 3 years or one year after the contract ends, whichever is longer (V-bill section 9, BPC 17602(a)(6)); P20-07 and P20-39 should keep `billing_consents` for the longer, and the row may then say "at least".
- Live run: none; the founder and counsel read the three pages.

**P20-24.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-25.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-26.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-27.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-28.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-29.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-30.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-31.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-32.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-33.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-34.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-35.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-36.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-37.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-38.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-39.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-40.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-41.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-42.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-43.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-44.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-45.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-46.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-47.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-48.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-49.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-50.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-51.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-52.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-53.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-54.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-55.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-56.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-57.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-58.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-59.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-60.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-61.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-62.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-63.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-64.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-65.** Not started. Not built now: waits for Release 2 and for PHASE_18 and PHASE_19 to merge.

**P20-66.** Built on `p20/ops-basics` (Lane 5, 2026-10-01); not merged. `grantCredits(db, { workspaceId, credits, note, operator, key? }, now?)` in apps/web/src/lib/ops/grants.ts and `pnpm ops:grant-credits --workspace <id> --credits <n> --note "<text>" [--key <uuid>]` (apps/web/scripts/grant-credits.ts over grant-credits-command.ts). One transaction holds a transaction scoped advisory lock over every operator grant (so the monthly cap holds under concurrency), the workspace row lock, the cap checks, the `billing:system:ops_grant:<key>` claim in `events` (the 0003 unique index), the ledger row (`grant`, or `refund` for a negative correction, source `system`, step_key `ops_grant:<key>`) and the `ops_audit` row (`credits.grant` or `credits.correct`, detail key, credits, applied, note and balances). A repeat with the same key is found through `ops_audit` (no client role can write it; `events` is member insertable) and writes nothing; the same key with another workspace or amount, or a claim with no audit row, is refused. Every call re-checks the operator against OPS_EMAILS. The CLI prints the key before it writes, so a run that stops part way is repeated with `--key`; negative numbers are written `--credits=-50` (node's parseArgs reads `--credits -50` as a flag). Deviations: the claim and ledger insert follow `DbBillingStore.recordGrantOnce`'s pattern in this module's own transaction instead of calling it, because that method's transaction can hold neither the cap check nor the audit row (and Lanes 1 and 2 edit it); the claim name is `billing:system:ops_grant:<key>` (the store's `billing:<source>:<key>` shape with source `system`), not `billing:ops_grant:<key>`; the seed constant `opsGrants` sits in operations.ts (Lane 5's section) rather than credits.ts, so the seed index exports it with no edit to its shared credits.ts list; the per grant cap applies to corrections too, and only grants count toward the monthly cap. The claim's props hold the credits and the note only, because members can read their workspace's events (the note is customer visible anyway once P20-09 shows `credit_ledger.note`); the audit detail keeps the workspace by id, with no name. A correction takes back at most the balance and is refused when the balance is zero. Tests: apps/web/src/lib/ops/grants.test.ts (one ledger row and one audit row, the repeat, key reuse and a forged claim, both caps with nothing written, the next month, a correction that stops at zero and half credits, the OPS_EMAILS gate, invalid input, rule 9 on the copy), apps/web/scripts/grant-credits-command.test.ts (the printed key and balances, the rerun, refusals, the connection always closed), pipeline operations.test.ts (`opsGrants`), packages/db ops-switches-and-audit.test.ts (`ops_audit` closed to client roles, no foreign key, the policy). New variable `OPS_OPERATOR_EMAIL` (founder's machine only) is in docs/PENDING.md for .env.example; Lane 5b adds it to docs/LAUNCH_CHECKLIST.md with P20-21. Live check left: the founder's first grant of the concierge credits (docs/PENDING.md, Lane 5 step 6) against production, which no test can make. Review fix 2026-10-02 (security 11): the events claim carries a neutral label, the note stays in `ops_audit`.

## Explicitly later and backlog

**PHASE_21 and up:**
- CSV and catalog runs on durable workers (Trigger.dev v4 or a Render worker), with long holds and per row errors.
- Agency client workspaces with a shared credit pool, client review links and white label pages; Agency returns to self serve then.
- The Shopify app (Shopify billing, embedded app, review queue, GDPR webhooks).
- Video (templated, generative, UGC).
- i18n (VAT inclusive prices, other currencies, rule 9 per language).
- A free crop and position editor (fidelity tests per operation).

**Backlog:** Supabase PITR; a log drain or log service; Render preview environments; replicating delivered R2 files; OpenSSF Scorecard; renaming `@curvi/trigger`; an abuse dashboard; Upstash as the breaker store; HTTP load testing beyond the memory test; CSP nonces on marketing pages; a churn score once there are users (the weekly drop wrapper is deleted, not deferred); credit lots with expiry, only if decision 10 changes; a merchant of record if consumer sales outside the US appear; the OCR label check (`semanticChecks`); OpenAI harmonize through the edits endpoint; a live real photo golden set beside P18-17's benchmark; orphaned pack files left when a settle won during an upload.
