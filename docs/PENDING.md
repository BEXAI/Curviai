# Pending work

Date: 2026-09-28. Production: main 939dc1b on Render, database at migration 0013 and seeded.

The discovery sweep of 2026-09-28 found 205 open items (docs/phases/PHASE_10.md). Batch 1 addressed 88 of them. The 117 items below have not been started. Duplicates across the sweep are merged here. Nothing in this file is built yet.

## Site visitor count founder steps (cookieless, first party)

Added 2026-10-01. The code is on `site-visitors`. Render's dashboard reports no visitors and PostHog only counts people who accept cookies, so the site now counts page views itself without cookies (apps/web/src/lib/visits) and shows them at `/app/ops/visitors` to the people listed in `OPS_EMAILS` (or `OPS_EMAIL`). The details are in docs/LAUNCH_CHECKLIST.md, "Site visitor count". Do these in order.

1. **Apply migration 0027 in production** with pnpm db:migrate, staging first. It adds the `site_visits` and `site_visit_salts` tables (RLS on, no client privileges) and the `site_visits_daily` view. It is additive: the code before it keeps working, and the new code stores nothing until the tables exist (the beacon route always answers 204 and logs the failure).
2. **Set `OPS_EMAILS` on Render** (Environment, Save only): your sign in email, or several separated by commas. Server only; never a `NEXT_PUBLIC_` name. If you already set `OPS_EMAIL` (singular), that works too: it is read whenever `OPS_EMAILS` is unset or empty, and `OPS_EMAILS` wins when both are set. With neither, nobody can open the page.
3. **Set `VISITS_HASH_KEY` on Render** (Environment, Save only): run `openssl rand -hex 32` and paste the output. Server only, never in the repo, never a `NEXT_PUBLIC_` name. Without it nothing is counted, and `/app/ops/visitors` says counting is off.
4. **Add these lines to .env.example by hand** (env files are blocked for the agents):

   ```
   # Operator emails (comma separated) that may open /app/ops/visitors. Server only. Unset: nobody.
   # OPS_EMAIL (singular) is read the same way when OPS_EMAILS is unset.
   OPS_EMAILS=
   # Secret key for the cookieless visitor count, for example openssl rand -hex 32. Server only. Unset: nothing is counted.
   VISITS_HASH_KEY=
   ```

5. **Schedule `/api/cron/stale-jobs`** every 10 to 15 minutes if it is not scheduled yet (docs/LAUNCH_CHECKLIST.md, "Batch 2 platform", item 3). It now also deletes visitor salts older than yesterday, so they go on time even on a quiet day.
6. **Deploy the web app,** then open https://curvi.ai/app/ops/visitors signed in with that email. Anyone else gets a 404. The counts start from the deploy; there is no history before it. Your own visits to `/app/ops` are not counted.
7. **Optional:** in the Supabase SQL editor, `select * from site_visits_daily order by day desc;` gives the same daily numbers.
8. **Later:** check which client IP header Render passes (docs/verification.md, "Site visitor count") and make `clientIp()` trust only edge set headers. Until then a script that forges that header gets past the per IP limits, and only the 3 in flight and 100,000 a day bounds hold.

## Phase 17 founder steps (every LLM call moves to OpenAI, Claude last)

Added 2026-10-01. The code is on `p17/integration`; the full status is in docs/phases/PHASE_17.md, "Implementation status". No migration is needed. The OpenAI credits expire on December 31, 2026 (founder decision 4). Haiku 4.5's retirement commitment runs only to 2026-10-15, so finish the canary for the Haiku recipes (step 6, groups 1 to 3) before then. Do these in order.

1. **Check the keys.** `OPENAI_API_KEY` on the worker and the web app must belong to a project whose permissions allow the Responses API (`/v1/responses`) and model reads. Keep `ANTHROPIC_API_KEY` set: Claude is the last fallback in every chain.
2. **Deploy the Trigger.dev worker first, then the web app.** The worker carries the OpenAI adapter and wiring; the web app carries the health entry, config-health and job copy. Keep TRIGGER_SECRET_KEY unset on Render until the v4 upgrade, as docs/LAUNCH_CHECKLIST.md step 14 says.
3. **Re-seed with pnpm db:seed, staging first, then production,** right after the deploys. The re-seed must leave every new version active at `traffic_pct` 0 beside the serving Claude version at 100: intake_normalizer v7 (v6 serves), product_analyzer v4 (v3), shot_planner v3 (v2), copy_generator v4 (v3), qc_judge v2 (v1), target_picker v2 (v1), brand_palette_namer v2 (v1), question_planner v2 (v1). Nothing changes for sellers yet. Then check that `/api/health/providers` shows `openai-llm` green with the real key and that config-health lists no uncovered stage.
4. **Measure the image multipliers with one real request each,** for gpt-6-luna and gpt-6.1-sol. Send `POST /v1/responses` with `store: false`, one plain 1024 x 1024 JPEG at `detail: "high"` and a one word text part, then the same request with the text part only. The image's tokens are the difference in `usage.input_tokens`, and the multiplier is that difference divided by 1,024 (32 x 32 patches). Record each value and the date in docs/verification.md, replace the 1.72 placeholders in `llmImageTokenMultipliers` (packages/pipeline/src/seed/models.ts), and deploy the worker again.
5. **Run the live eval on both providers,** with live keys in the shell, never in CI. First `pnpm eval --live --provider anthropic --record-baseline` to store the Claude answers, then `pnpm eval --live --provider openai`. Add `--record path` to keep each run for rescoring with `--replay`. Every recipe must meet the pass bar in PHASE_17.md workstream 4 item 2, and the injection fixtures must pass on OpenAI wherever they pass on Claude. Sign off on the report before step 6.
6. **Canary, one group at a time,** in this order: (1) brand_palette_namer and question_planner; (2) copy_generator and target_picker; (3) intake_normalizer; (4) qc_judge; (5) product_analyzer; (6) shot_planner. For each recipe go to 10% (new version `trafficPct` 10, serving version 90), then 50 and 50, then 100% (new version 100, old version `active: false`). Each step needs a day of clean metrics: failure rate, truncation, refusals, fallback rate, cost per pack and seller visible errors. Make each step a seed change plus a re-seed, staging first: pnpm db:seed upserts `traffic_pct` and `active`, so a weight set by hand in the Supabase SQL editor is undone by the next re-seed unless the seed matches it.
7. **Rollback** at any step: set the new version's `trafficPct` to 0 (or the previous version active at 100) and re-seed. No deploy needed.
8. **When every recipe is at 100%:** Claude stays the last fallback. Watch the OpenAI credit balance; a `credit_balance_exhausted` answer opens the breaker and traffic falls to Claude by itself. Decide by 2026-12-24 whether to stay on paid OpenAI or move Claude back to primary (the credit reminder emails go out on the first LLM call on or after 2026-12-01 and 2026-12-24, and config-health warns from 2026-12-01). Confirm the Claude fallback alert floor of 20 OpenAI first calls per hour (`llmFallbackAlertPolicy.minCallsPerHour` in packages/pipeline/src/seed/monitoring.ts). After a week at 100%, trim each recipe's `maxTokens` from the measured reasoning tokens in the `llm_call` log lines and the per recipe counters (workstream 6).
9. **Before calling Phase 17 done:** the full `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` gate on the integration branch, and a reviewer agent pass on the cost caps and metering (cache writes are metered at the input rate today, see PHASE_17.md, "Known gaps").

## Phase 16 founder steps (bundles, A+ modules, ads formats, questions, agents)

Added 2026-09-29. The code is on `p16/integration`; the full status is in docs/phases/PHASE_16.md, "Implementation status". Production is at migration 0023. Do these in order.

1. **Run pnpm eval with live keys** before anything is re-seeded, and check for no regression (rule 6). It must cover `copy_generator` version 2, `question_planner` version 1 and `brand_palette_namer` version 1, plus `pnpm eval -- --stage aplus` and `pnpm eval -- --stage questions`.
2. **Apply migrations 0024 and 0025 in production** with pnpm db:migrate, staging first. 0024 adds `generation_jobs.seller_answers`, `asset_variants.picked`, the `api_keys` and `favorites` tables with RLS, and a unique index on `assets (id, workspace_id)` built without CONCURRENTLY, so run it at a quiet time (it locks writes to assets while it builds). 0025 adds `products.endorsements`. Both are additive, so the old worker and web keep working after them.
3. **Deploy the Trigger.dev worker first.** An older worker refuses a non default bundle, `extras.ads`, `variations` and recipe stage `question`, and ignores endorsements and seller answers. Keep TRIGGER_SECRET_KEY unset on Render until the v4 upgrade, as docs/LAUNCH_CHECKLIST.md step 14 says.
4. **Re-seed with pnpm db:seed, staging first, then production,** together with or right after the worker deploy. The re-seed must leave:
   - channel_specs with the 24 registry specs: `tiktok.ad_9x16` and `meta.reels_9x16` new, `meta.story_9x16` with the wider safe zone, feed and pin text limits, and the four coming soon A+ sizes;
   - recipes with `copy_generator` version 2 active and version 1 retired, `question_planner` version 1 (stage `question`) and `brand_palette_namer` version 1 (stage `brand`).
   Bundles (`packBundles`), the `apiAccess` tier entitlement, A+ module copy slots, `adsFormats` and `variationOptions` live in the code seed, not in a table, so they go live with the deploys in steps 3 and 5.
5. **Deploy the web app** second.
6. **Before calling Phase 16 done:** the full `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` gate, a scene carousel tried against a real image provider, and a reviewer agent pass on the new tenant writes and on the API, MCP server and CLI.
7. **Before the API goes public:** the reviewer pass in step 6, then flip `FEATURES.agentApi` to live, try the MCP server with a real client, and add pricing and llms.txt copy for API access on Growth and up.
8. **Create the curvi-ai GitHub org and publish the skill and CLI when ready.** Move `skills/curvi/` to a public `curvi-ai/skills` repository (MIT), choose the npm package name, add a build step to JavaScript (Node does not strip types under node_modules) and publish the CLI. Then flip `FEATURES.agentSkill` to live, update the skill's Status and Install sections, and list the skill and the MCP server in the plugin directories.
9. **Marketing copy:** once each feature is live in production, describe bundles, A+ modules, carousels, ad packs and scene versions on the home page, the pricing page and llms.txt, with no claim that is not live.

## Phase 15 founder steps (seller controls for every output)

Added 2026-09-29. The code is on `p15/output-options`; the full status is in docs/phases/PHASE_15.md, "Implementation status". Migration 0023 is already applied in production (2026-09-29), so do not run db:migrate for it again.

1. **Run pnpm eval with live keys** before anything is re-seeded. It must cover intake_normalizer version 5 (the per image `addedOverlays` flag) and show no regression against version 4 (rule 6).
2. **Deploy the Trigger.dev worker first.** It reads the new output options, the kept photo renderer and the intake version 5 schema. Keep TRIGGER_SECRET_KEY unset on Render until the v4 upgrade, as docs/LAUNCH_CHECKLIST.md step 14 says.
3. **Re-seed with pnpm db:seed, staging first, then production,** together with or right after the worker deploy. The re-seed must leave:
   - channel_specs on registry version 2 (Google byte and megapixel limits, `bordersAllowed`, the eBay and Google overlay rules);
   - the `output_options_enabled` platform setting present and true (the kill switch fails closed without the row);
   - intake_normalizer version 5 active and version 4 retired. The worker's strict intake schema expects `addedOverlays`, so version 5 and the new worker must go live together.
4. **Deploy the web app** second.
5. **Set NEXT_PUBLIC_OUTPUT_OPTIONS per environment,** last: "1" in staging, check a Remove pack, a Keep pack and a mixed pack there, then "1" in production. Leave it "0" or unset anywhere the steps above have not run. Add `NEXT_PUBLIC_OUTPUT_OPTIONS=0` to .env.example by hand.
6. **To turn the controls off without a deploy,** set `output_options_enabled` to false in platform_settings. Non default options are then refused and the form section hides.
7. **Before calling Phase 15 done:** the golden set of Keep photos, the swatch fringe review (which decides whether slate and charcoal return), the 80 MP peak memory test and the full `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` gate.
8. **Housekeeping:** expiry for the R2 objects under `ws/{id}/cache/preview/` and `ws/{ws}/jobs/{job}/handoff/` (these keys have the workspace first, so an R2 prefix rule alone cannot match them; a cleanup job may be needed), and removing the stale worktrees that still hold p15/p1render, p15/p1web and p15/p1overlays.

## Can build now (no account or founder decision needed)

### Conversion and activation
- In-app before and after reveal, with a "Share this makeover" prompt.
- Out of credits and upgrade prompts at paywall moments; credit balance display.
- Start a pack from a pasted Shopify or Amazon product URL.
- Pack ready notice in the app (email needs Resend).

### Core app
- Seller inputs the planner needs: multiple photos with angle roles, SKU, box contents, comparison facts. Unlocks the in_the_box and comparison shots.
- Products library with pack history.
- Retry a needs review shot, add a missing angle, cancel a running pack (POST /api/jobs/[id]/cancel).
- Brand kit fonts, logo and style preset used in packs (today only colors are).
- Readable compliance report view and compliance-report.pdf.
- Light editor: crop, shadow strength, background swap (/api/assets/:id/edit). Largest item.
- Concept Mode that really renders labeled concept images, or keep it hidden (hidden today).

### Growth
- Real share pages at /s/[slug] and an opt-in customer gallery.
- Store email captures (leads table, /api/leads) and email gate the free tools' full results.
- Free tool fixes: transparent pixels read as black (Update.md 6.9); checker ignores the 90 percent fill maximum (6.10).
- Store catalog audit with a paid "fix all" step, grown from the free checker.
- SEO depth: hub pages, internal links, more help articles.
- "Made with Curvi" badge on social exports only.

### Trust and platform
- Self serve account deletion and data export, plus a 30 day source media purge.
- Server side upload ingest: magic bytes, 80 MP cap, EXIF strip, video length.
- Cookie consent for analytics and unsubscribe links.
- Read recipes from the recipes table at runtime (A/B splits), and model failover so models swap without a deploy.
- noUncheckedIndexedAccess for app code (Update.md 7.6).
- Server side terms acceptance record (today it lives in editable user metadata).
- Report only Content Security Policy.
- Scheduled stale job sweep (cron route) and the (status, updated_at) index.

### Retention
- Cancel flow with save offers: pause, downgrade, discount. UI can be built now; live offers need Stripe.
- Team invites, seats, workspace switcher and client review links (Agency tier).
- Video template fixes (Update.md 7.1 to 7.3), ready for when rendering is turned on.

## Blocked on accounts or founder decisions

### Stripe (keys, prices and portal setup, docs/STRIPE_SETUP.md)
- Everything that takes money: founding member offer, trials, paywall checkout, referral and affiliate rewards, churn score, real MRR in the weekly digest.
- Tax handling decision (Stripe Tax or a merchant of record).

### Pricing decisions
- Reprice generative stills (1 credit sells for about $0.08 to $0.145; each costs about $0.17) and top up packs.
- Rollover and expiry policy, then enforce it with credit lots (cap annual plans by months paid).
- Mix for Amazon's 8 secondary image slots (default today: 2 lifestyle scenes and the infographic keep their slots).

### Legal
- Terms and privacy fit for paid customers: refunds, cancellation, credit clawback on downgrade (the balance can go below zero), company details, counsel review.
- Disclosure for AI generated people in ads; Amazon policy check.

### Hosting and messaging
- Render paid plan: done 2026-10-01, `1c-2g` (1 CPU, 2 GB, $25 a month). Still set `CURVI_INLINE_PACK_CONCURRENCY` = `2` in the Render dashboard (the hand made service does not follow render.yaml), and confirm `maxShutdownDelaySeconds` 300 (docs/LAUNCH_CHECKLIST.md steps 8 and 9).
- Resend sending domain (SPF, DKIM, DMARC) and Supabase custom SMTP, so signup and pack ready emails arrive.
- Loops for lifecycle email; PostHog key and funnel; Sentry; Upstash for shared rate limits and the landing page preview.

### Jobs and video
- Durable pack runs and scheduled jobs: Trigger.dev v4 on Trigger.dev cloud, or a Render cron service.
- Templated video rendering, then generative video (Veo and fal.ai access).

### Integrations
- Shopify embedded app and billing, Shopify auto packs.
- Amazon SP API publishing and a public cdn.curvi.ai path (Cloudflare DNS and an R2 custom domain).
- Google Drive, Dropbox and Canva exports.

### Quality tooling
- C2PA content credentials (signing certificate).
- OCR and embedding QC engines; cutout failover through fal.ai.
- Eval golden set of 40 real products (photos Curvi has rights to).

### Other
- Backups: Supabase paid plan or point in time recovery decision.
- Domain and trademark confirmation.
- Staging database for full end to end and load tests.

## Small leftovers from batch 1
- Add the new variable names to .env.example by hand (env files are blocked for the agents). The list is in docs/LAUNCH_CHECKLIST.md, "Environment variables added in batch 1".
- The shot_planner prompt does not mention Etsy, eBay, Walmart, TikTok Shop or Pinterest yet, so those packs use the deterministic fallback. Prompt changes need a pnpm eval run.
- Verify the harmonize aspect tolerance and the client IP header behind Render at the first live check (docs/verification.md, "Still unverified").
- Partial disputes claw back the whole grant; scaling by the disputed amount needs a Stripe lookup.
- Site accent color is still orange; the new logo is teal and pink.

## Suggested next order
1. Conversion: before and after reveal, paywall and upgrade prompts, URL import.
2. Founder setup that unblocks revenue: Stripe, Render paid plan, Resend domain, legal pages.
3. Retention: cancel flow, products library, shot retry.
4. Growth: share pages, lead capture, catalog audit.
