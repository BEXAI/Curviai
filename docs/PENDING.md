# Pending work

Date: 2026-09-28. Production: main 939dc1b on Render, database at migration 0013 and seeded.

The discovery sweep of 2026-09-28 found 205 open items (docs/phases/PHASE_10.md). Batch 1 addressed 88 of them. The 117 items below have not been started. Duplicates across the sweep are merged here. Nothing in this file is built yet.

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
- Render paid plan (the free plan sleeps and kills running packs on every deploy).
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
