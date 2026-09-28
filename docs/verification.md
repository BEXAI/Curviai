# Verification log

Every external fact the build depends on, checked against live sources. Per CLAUDE.md rule 7, any new external API shape or price gets a row here with the date checked.

Date of this pass: 2026-09-27. Method: two research agents fetching official pages where reachable, reputable secondary sources where login walled (marked).

## Blocking findings

| Item | Status | Finding | Action |
|---|---|---|---|
| curvi.ai domain | CONTRADICTED | Already registered by a third party since 2025-09-09 (GoDaddy, privacy proxied, expires 2027-09-09). Site returns 503, no visible product. RDAP: rdap.identitydigital.services/rdap/domain/curvi.ai | Name is not registrable. Options: private acquisition attempt, alternate domain (getcurvi.ai, curvi.app, trycurvi.com), or rename. Blocks branding spend. |
| CURVI trademark | UNKNOWN | tmsearch.uspto.gov is a JS app, not fetchable automatically. The Curvi iOS app (AI fashion recolor app, apps.apple.com id6757593245) is live on the US App Store, a direct name collision in consumer AI imaging. | Manual USPTO Trademark Center search for CURVI and phonetic equivalents in classes 9, 42, 35 before any brand spend. |
| Veo 3.1 Lite price | CONTRADICTED | Official Gemini API pricing: $0.05 per second at 720p, $0.08 at 1080p. Plan assumed $0.03 and $0.05. An 8 s 1080p hero loop costs about $0.64, not $0.40. 8 s max confirmed. ai.google.dev/gemini-api/docs/pricing | Cost model updated here; pack COGS with hero loop runs roughly $2.80 to $5.00 instead of $2.50 to $4.50. Margin targets still hold. |
| Kling API terms | PARTIAL | Kling 3.0 about $0.112 per second 1080p confirmed, but direct API access is sold as prepaid packages from $700 with 180 day expiry. | Route Kling through fal.ai or another pay as you go gateway at launch; buy direct only at volume. |

## Confirmed: models and pricing (official pages, fetched 2026-09-27)

| Item | Value | Source |
|---|---|---|
| claude-sonnet-5 | $2 in, $10 out per MTok. Retirement not sooner than 2027-06-30 | platform.claude.com/docs models overview |
| claude-haiku-4-5-20251001 | $1 in, $5 out. Retirement commitment only to 2026-10-15, plan a successor swap | same |
| claude-opus-5-5 | $4 in, $20 out. Cache reads 5 percent of input on Opus | same |
| Batch API | 50 percent off, cache reads 10 percent of input | same |
| gemini-3.1-flash-image (Nano Banana 2) | $0.045 at 512, $0.067 at 1K, $0.101 at 2K, $0.151 at 4K | ai.google.dev/gemini-api/docs/pricing |
| gemini-3-pro-image (Nano Banana Pro) | $0.134 at 1K and 2K, $0.24 at 4K | same |
| gemini-2.5-flash-image | Deprecated, shuts down 2026-10-02. Not used anywhere in this codebase | same |
| FLUX.2 pro / max / klein | From $0.03 create, $0.045 edit per MP; max $0.07; klein 4B from $0.014. No pinned or reproducible endpoint documented: pin via seed plus stored parameters and rely on the eval harness to catch silent model updates | docs.bfl.ai/quick_start/pricing |
| gpt-image-2 | $8 per M image input tokens ($2 cached), $30 per M output, $5 per M text input; batch half price. gpt-image-1 shuts down 2026-10-23 | developers.openai.com/api/docs/deprecations |
| OpenAI Sora API | sora-2, sora-2-pro and the entire Videos API shut down 2026-09-24. Not integrated | same |
| Photoroom API | $0.02 per basic cutout, $0.10 Plus (shadows, relighting). Basic subscribers making Plus calls pay the Plus rate | photoroom.com/api/pricing |
| Remotion license | Free for individuals and companies up to 3 employees. Recheck at hire 4 | github.com/remotion-dev/remotion LICENSE.md |
| .ai domains | 2 year minimum initial term, roughly $70 to $100 per year retail | domainnamewire.com 2026-02-02 |
| Stack entry prices | Supabase Pro $25, Vercel Pro $20 (Hobby bars commercial use), Trigger.dev Hobby $10 Pro $50, Upstash PAYG, Resend Pro $20, Loops from $49 past 1,000 contacts, PostHog and Sentry free tiers. About $55 to $101 per month at zero users, matching the plan estimate | vendor pricing pages |

## Confirmed: channel rules

| Item | Value | Source quality |
|---|---|---|
| Amazon main image | Pure white 255,255,255, product 85 percent or more, no text logos props watermarks, 1000 px zoom minimum, 1600 optimal, 10000 max, JPEG sRGB under 10 MB, up to 9 images, MAIN and PT01 to PT08 naming | Secondary (Seller Central G1881 is login walled). Recheck official wording once a seller account exists |
| Shopify product media | 5000 x 5000, 25 MP, under 20 MB, 2048 square recommended, GLB and USDZ 3D up to 500 MB, video 10 min 1 GB | Official help.shopify.com, exact match |
| Google Merchant IPTC | DigitalSourceType required for AI images. Three accepted values: TrainedAlgorithmicMedia, CompositeSynthetic, AlgorithmicMedia. Never strip embedded metadata. 500 x 500 minimum enforced 2027-01-31, 1500 x 1500 recommended | Official support.google.com/merchants/answer/6324350 |
| Shopify CDN IPTC stripping | Was real (community thread May to Sept 2026); Shopify staff say fixed as of 2026-07-27. | Add an empirical runtime check in Phase 8: upload tagged image via stagedUploadsCreate, fetch from CDN, assert tag survives. Keep the cdn.curvi.ai feed fallback in the design |
| Amazon SP API images | patchListingsItem with main_product_image_locator, other_product_image_locator_1 to 8 confirmed on official docs. $1,400 annual fee cancelled May 2026. Non Amazon CDN URLs can be rejected: serve publish copies from a fetchable public bucket URL | Official developer docs |
| Shopify app economics | 0 percent on first $1M lifetime revenue (from 2025-01-01), 15 percent above, $19 one time registration, PLUS a 2.9 percent processing fee on all billing. New apps should target Shopify App Pricing rather than the legacy Billing API | Official shopify.dev |
| eBay | 500 px minimum longest side, 1600 recommended, no watermarks, borders or added text | Official ebay.com help |
| Etsy | 2000 px shortest side recommended, 4:3 or 1:1 | Official help.etsy.com |
| Walmart, TikTok Shop | Figures in the registry remain secondary sourced and are flagged verified false there | Recheck when seller accounts exist |
| EU AI Act Article 50 | In force since 2026-08-02 for generative output marking. Machine readable marking is the provider duty. Curvi ships IPTC plus planned C2PA from day one | artificialintelligenceact.eu, EC digital strategy FAQ |

## Build environment decisions (2026-09-27)

- Registry now serves TypeScript 7, ESLint 10, Vitest 5, Next 16, Stripe SDK 22, Trigger.dev SDK 4. Pinned instead: TypeScript 5.9, Next 15.5, ESLint 9, Vitest 3, Zod 4, Drizzle 0.44, Trigger.dev SDK 3, sharp 0.34, exiftool-vendored 28. Reason: known good combination; upgrades are deliberate follow ups.
- pnpm 10 ignores dependency build scripts by default; sharp and esbuild load via prebuilt platform binaries, verified working on this machine (vips 8.17.3, exiftool 13.00).
- sharp 0.34 morphology semantics for white foreground masks are inverted on this platform; packages/pipeline/src/mask.ts documents and pins this with tests.

## Unverified adapter endpoint shapes (verify at first live call)

Anthropic /v1/messages field set and current anthropic-version header value; Gemini generateContent image response casing; BFL flux2 pro create and polling contract; OpenAI images generations response; Photoroom multipart contract; fal.ai queue endpoints. Each adapter carries a docstring flag. Record dates here when first exercised with real keys.

## Security audit (2026-09-27)

A read only security review of wave 1 executed exploit probes against the repo's own PGlite harness and composite pipeline. It confirmed 3 critical RLS privilege escalations (member self grant of credits, PUBLIC executable SECURITY DEFINER ledger functions, client role workspace update and delete), 4 high findings (subscriptions self upgrade, unprotected recipes and channel_specs tables, thin product fidelity bypass through mask erosion, silently bypassable cost caps) and 9 medium or low findings. All 16 were fixed the same day: migration 0002_security_hardening.sql (19 regression tests that re-run the exploits and assert denial), fail closed cost estimation in packages/ai, adaptive paste erosion plus a derived QC erosion invariant and a maxDeltaE guard in packages/pipeline, filename sanitization in packages/specs, an events dedupe unique index (migration 0003) making webhook grants atomic, and a fal poll URL allowlist. Ledger SQL functions are callable only by the service role or the owner connection; the web app was reconciled to call them over DATABASE_URL.

## Full audit and P0 remediation (2026-09-27, second pass)

A 22 agent audit compared all 257 plan requirements against the code; docs/AUDIT_2026-09-27.md holds the verified findings. The three P0 findings were fixed the same day:

1. Web to worker bridge: POST /api/jobs now enqueues generate-pack through the Trigger.dev SDK when TRIGGER_SECRET_KEY is set, and otherwise runs the pack inline after the response through next/server after() with the same runner (apps/web/src/lib/jobs/enqueue.ts). A crashed inline run marks the job failed and releases the hold.
2. DB credit settlement: DbJobStore (trigger/src/db-store.ts) persists job state, assets, job_steps, and calls charge_credits per passing asset with the shot id as step key and release_credits per failed shot and remainder. Migration 0004 and 0005 move the ledger to numeric(12,1) so the plan's 0.5 credit deterministic assets bill exactly, and release_credits gained an exact amount parameter. Tested end to end against the real migrations in trigger/src/db-store.test.ts.
3. Pack delivery: buildPack writes loose per channel files, DbJobStore uploads files, zips and the compliance report to R2 under ws/{workspace}/jobs/{job}/, records asset_variants and pack_files rows (new table, member read RLS), and GET /api/jobs/:id/files serves 15 minute signed urls rendered as channel tabs with named downloads and previews (PackDownloads component).

Also landed in the same pass: uploads are now recorded (POST /api/uploads/complete writes source_media; the pack form registers each upload and auto creates a product), Listing Mode refuses to start without a real photo, the client role can no longer create jobs, products or uploads through the app layer, IPTC DigitalSourceType is embedded at package time (composite for composited stills, trained for fully generated and all concept outputs, none for deterministic edits), concept packs structurally exclude marketplace channels in the runner, the rule 3 fidelity gate fails closed when a composite generation omits its product reference or mask, the compliance badge carries measured fill and background from the worker, checkout.session.completed writes workspaces.stripe_customer_id back, and pnpm db:seed (trigger/src/seed-cli.ts) seeds channel specs and recipes into the tables.

Waves 2 and 3 (same day): provision_workspace (migration 0007) creates the first workspace, owner membership and the free 15 credit grant exactly once per user; the runner blocks flagged uploads and flagged products before generation; seller text reaches the LLMs inside user_description tags; generation_jobs stores channels and mode so idempotency replays verify the whole body and cross workspace conflicts stop leaking job ids; every pricing number on the marketing surface derives from packages/pipeline/seed. Spend caps are live on the call path: layered caps hooks in callWithFailover (pack plus global day on every LLM call), per asset, pack and global reservations on each shot generation with the cost capped needs review branch, the onSpendAlert hook at the $50 line, and DAILY_SPEND_HARD_STOP_USD raising the $150 stop. The Anthropic adapter honors the recipe selected model with per model price tables, failing closed for unpriced models.

Merge and production migration (2026-09-28): the deploy branch (worktree-ui-update-plan, previously origin/main) was merged into main. Migration numbers were reconciled: 0004_signup_bootstrap and 0005_brand_logo stay, main's migrations became 0006 to 0009 (so provision_workspace is now 0009). Production Supabase (tmwvjmvzjvpeagatjmud) was checked read only and found at 0005 with no drizzle.__drizzle_migrations table. 0006 to 0009 were applied in one guarded transaction through the SQL editor, and all ten migrations were recorded in drizzle.__drizzle_migrations with sha256 hashes and journal timestamps, so pnpm db:migrate treats production as current. Verified afterwards: pack_files with RLS and its member read policy, numeric(12,1) ledger, generation_jobs channels and mode, numeric ledger functions and provision_workspace executable by service_role only, existing ledger balance unchanged. Functional fix plan from the post merge audit: Update.md.

Live pack safety (2026-09-28, Update.md 2.1, 5.2, 1.6, 3.1), done because production has live Anthropic, Gemini, BFL and Photoroom keys:
- Live mode never substitutes demo images.
- Provider spend is reserved against caps before each live call.
- Credits are charged only after the pack is stored.
- The worker cannot revive a job the stale reconciler failed; the reconciler releases credits only when it wins a conditional update.
- Tests cover each path in trigger/src/live-runtime.test.ts, pipeline-runner.test.ts, db-store.test.ts (real SQL on PGlite) and apps/web/src/lib/services/db.test.ts.
- The reviewer agent confirmed settlement in every path. It then found that spend caps were per process, and that a database-backed run with no keys still charged for demo output. Both are fixed:
  - Migration 0010 adds spend_cap_counters: platform table, RLS on, no client privileges. PgCapStore (trigger/src/cap-store.ts, cap-store.test.ts) is shared across runs.
  - Database-backed runs never use the demo generator unless CURVI_ALLOW_DEMO_GENERATION=1.
- Migration 0010 must be applied to production before the code that uses it is deployed.

## Open follow ups

- DONE 2026-09-28: live paths for deterministic and template stills. LiveShotGenerator cuts each source photo out once per job (per shot task on Trigger.dev cloud, where every task builds its own generator) and renders:
  - Deterministic shots through trigger/src/live-deterministic.ts (whiten helpers): amazon_main, alt_angle_white, cutout_png, gray and brand sweeps, collection_thumb.
  - Template shots through packages/pipeline/src/templates/still.ts (bundled Inter): infographic, dimensions, A+ banners, social 1x1, 4x5 and 9x16.
  - A live pack end to end test passes all 16 planned still shots.
  - Still open: in_the_box and comparison, because the app does not collect box contents or comparison facts. Video and avatar shots also remain open.
  - A Trigger.dev cloud deploy must ship the font file (set CURVI_TEMPLATE_FONT_FILE or add it to the build); the web inline runner resolves it from node_modules. Any Trigger.dev cloud deploy now needs the v4 upgrade first: v3 no longer runs on Trigger.dev Cloud (rechecked 2026-09-28, see "Phase 10 batch 1" below).

- OCR engine and embedding similarity (DINOv2 or CLIP) implementations behind the existing pluggable QC interfaces; semanticChecks is still not invoked from the runner.
- c2pa-node manifest signing once a signing certificate exists.
- compliance-report.pdf rendering (JSON ships now).
- Square video channel spec (video.social_1x1) for 1x1 template renders.
- Half open probe state for the circuit breaker; Upstash backed breaker and cap stores; DB backed cost meter (cogs_micros still not written to the database).
- Badge pixel overlay for social exports and the Concept render corner label (flags are tracked, pixels not composited yet).
- Founder SMS for the $50 spend alert. Email is done in Phase 10 batch 1 (trigger/src/spend-alerts.ts sends through Resend when RESEND_API_KEY and FOUNDER_ALERT_EMAIL are set, and only logs otherwise).
- Write workspaces.stripe_customer_id back from checkout.session.completed so the customer portal works without backfill.
- Live provider wiring (trigger/src/live-runtime.ts, merged from the deploy branch on 2026-09-28) uses the model and price seeds in packages/pipeline/src/seed/models.ts. Adapters still carry VERIFY AT FIRST LIVE CALL notes; recheck model IDs, prices and response shapes against official provider docs on first key setup. Runtime recipe reads still come from the in code seed, not the recipes table, so trafficPct splits stay inert.
- The composite pipeline's scene plate and harmonize calls still invoke providers directly instead of through callWithFailover; wrap them before real image providers land.
- Ingest side revalidation of uploads (presigned PUT cannot enforce byte caps server side; caps are enforced at sign time only; magic bytes, EXIF strip and the 80 MP cap still need an ingest step that reads the object back).
- Credit rollover and top up expiry enforcement (expire ledger rows are still never written; top up expiresAt is recorded but not enforced).
- Templated video rendering (Remotion renderer is not wired to video shots; the demo generator returns stills), video QC frame sampling, and the pnpm eval --stage video stage.
- Cancel flow save offers, churn intervention execution, and the churn score daily job against real signals (Stripe keys and real readers needed).
- Workspace switcher and per request workspace scoping for agency accounts (DbService currently resolves the first membership).
- Legal pages (terms, privacy) before public launch; waitlist email capture currently falls back to mailto.
- Eval regression gates against a stored baseline (3 point pass rate and 0.02 fidelity drop) and eval_runs persistence; golden set is 10 synthetic products, not the plan's 40.
- The light asset editor (/api/assets/:id/edit: crop, shadow strength, background swap), the in app before and after reveal slider, share links from finished packs and the referral grant flow.
- semanticChecks (OCR and embedding gates) still needs real engines and a runner call site.

## Still template font and text rendering (checked 2026-09-28)

- Font: @expo-google-fonts/inter 0.4.2, added to packages/pipeline. npm license field "MIT AND OFL-1.1": package code MIT, Inter font files SIL Open Font License 1.1 (LICENSE_FONT ships in the package). Verified after install that the package ships TTF files, for example 600SemiBold/Inter_600SemiBold.ttf, which the still template renderer uses. The font's name table family is "Inter SemiBold".
- Text shaping: opentype.js 1.3.4 (MIT, deps tiny-inflate and string.prototype.codepointat), with @types/opentype.js 1.3.10 (MIT) as a dev dependency. Glyph outlines are converted to SVG paths and rasterized by sharp (librsvg), so no system font stack is involved.
- Why not sharp text input with fontfile: with sharp 0.34.5 (Pango 1.57, fontconfig 2.17.1) on macOS the fontfile option was ignored and output fell back to a Helvetica like system face, and Linux hosts do not guarantee fonts. Glyph paths from the bundled TTF render identically on every host.
- Resolution: packages/pipeline/src/templates/font.ts resolves the TTF with createRequire from the module, then from the working directory, then by walking up node_modules layouts. CURVI_TEMPLATE_FONT_FILE overrides the path for hosts whose bundler does not ship node_modules files (a Trigger.dev cloud deploy bundles code and may not include the TTF; set the env var or keep the package external there).

## SEO, GEO and AEO metadata (checked 2026-09-28)

Marketing metadata lives in apps/web/src/lib/seo.ts (titles, descriptions, canonical URLs, social cards, JSON-LD) and apps/web/src/lib/llms.ts (/llms.txt). An independent review checked these facts at official sources:

| Item | Finding | Source |
|---|---|---|
| OpenAI crawler tokens | GPTBot (training), OAI-SearchBot (ChatGPT search), ChatGPT-User (user actions; robots.txt may not apply) | developers.openai.com/api/docs/bots |
| Anthropic crawler tokens | ClaudeBot (training), Claude-SearchBot (search quality), Claude-User (user fetches); all respect robots.txt | support.claude.com article 8896518 |
| Perplexity crawler tokens | PerplexityBot (search, respects robots.txt), Perplexity-User (user fetches, generally ignores robots.txt) | docs.perplexity.ai/guides/bots |
| Google-Extended | Control token only, no crawler of its own; governs Gemini training and grounding | developers.google.com/search/docs/crawling-indexing/google-common-crawlers |
| Apple | Applebot crawls for Spotlight, Siri and Safari; Applebot-Extended never crawls, it only controls model training use | support.apple.com/en-us/119829 |
| Amazon | Amazonbot (product improvement, may train models), Amzn-SearchBot (search in Amazon products), Amzn-User (user actions) | developer.amazon.com/amazonbot |
| Meta | meta-webindexer (Meta AI search), meta-externalagent (training), meta-externalfetcher (user fetches, may bypass robots.txt) | developers.facebook.com/docs/sharing/webmasters/web-crawlers |
| DuckDuckGo and Common Crawl | DuckAssistBot (AI answers, not used for training); CCBot honors robots.txt | duckduckgo.com help pages; commoncrawl.org/ccbot |
| FAQ rich results | Google stopped showing FAQ rich results on 2026-05-07. FAQPage markup stays valid schema.org and is kept for answer engines | developers.google.com/search/docs/appearance/structured-data/faqpage |
| Software app rich result | Requires name, offers.price and aggregateRating or review. Curvi has no ratings and must not invent them, so it will not get the rich result; the markup still describes the product | developers.google.com/search/docs/appearance/structured-data/software-app |
| schema.org | Every type and property used in seo.ts exists and is current | schema.org/version/latest |
| llms.txt format | H1, optional blockquote, body without headings, then H2 sections that are lists of [name](url) links | llmstxt.org |
| Next.js 15.5.26 behavior | A page that sets openGraph drops the root opengraph-image, so pageMetadata sets the image explicitly; dynamic params arrive percent encoded; child robots metadata replaces the parent's | installed next source under apps/web/node_modules/next/dist |

Honesty rules applied: SoftwareApplication offers list paid plans only when STRIPE_SECRET_KEY is set, and FAQPage markup includes only answers that describe shipped features (see the structured flags in the home page and help page).

## Phase 10 batch 1: external facts (recorded 2026-09-28)

CLAUDE.md rule 7 record for every external API shape, price or setting the batch 1 code and docs rely on (docs/phases/PHASE_10.md). The packages that wrote the code could not edit this file, so their checks were collected here by the docs fix pass on 2026-09-28.

How each row was checked (the "Checked by" column):

- **Implementer**: checked on 2026-09-28 by the batch 1 package that wrote the code, against the source named, as reported in its hand off. Recorded as reported, not refetched here.
- **Reviewer**: also confirmed on 2026-09-28 by the independent batch 1 reviewer.
- **Rechecked**: refetched in this docs pass on 2026-09-28 because two sources disagreed.
- **Installed package**: confirmed in this docs pass on 2026-09-28 against the source or type definitions of the package version in pnpm-lock.yaml.

### Stripe (package P2 billing)

| Fact the code relies on | Where | Source | Checked by |
|---|---|---|---|
| API version pinned to `2025-08-27.basil`. The installed SDK, stripe 18.5.0, declares the same `ApiVersion`, so the SDK types match the objects Stripe sends. Register the webhook endpoint on this version too (docs/STRIPE_SETUP.md section 3). | apps/web/src/lib/billing/stripe.ts | stripe/cjs/apiVersion.js in stripe 18.5.0 | Installed package |
| Basil invoice shapes read by the webhook: line `pricing.price_details.price`, line `parent.subscription_item_details.proration` (and `parent.invoice_item_details`), line `period.start` and `period.end`, invoice `parent.type = "subscription_details"` with `parent.subscription_details`, and `current_period_end` on the subscription item rather than the subscription. | apps/web/src/lib/billing/stripe-webhook.ts | stripe 18.5.0 types (InvoiceLineItems.d.ts, Invoices.d.ts, SubscriptionItems.d.ts); docs/STRIPE_SETUP.md section 3 | Installed package, Implementer |
| `invoicePayments.list({ payment: { type: "payment_intent", payment_intent } })` finds the invoice a refunded or disputed payment paid. | apps/web/src/lib/billing/stripe.ts | stripe 18.5.0 types (InvoicePaymentsResource.d.ts) | Installed package |
| Checkout terms consent: `consent_collection.terms_of_service = "required"` plus `custom_text.terms_of_service_acceptance`. Session creation fails unless a terms of service URL is set in Dashboard, Settings, Public details. | apps/web/src/lib/billing/checkout.ts | docs.stripe.com/payments/checkout/custom-components (as recorded in docs/STRIPE_SETUP.md) | Implementer |
| Stripe Tax in Checkout: `automatic_tax.enabled`, `billing_address_collection = "required"`, `tax_id_collection.enabled`, and `customer_update: { address: "auto", name: "auto" }` for an existing customer. Off unless `STRIPE_TAX_ENABLED=1`. | apps/web/src/lib/billing/checkout.ts | docs.stripe.com/tax/checkout/page | Implementer |
| Portal deep link for plan changes: `flow_data.type = "subscription_update_confirm"` with `subscription` and `items: [{ id, price, quantity }]`, `after_completion` redirect; fallback flow `subscription_update`, then the portal home. | apps/web/src/lib/billing/checkout.ts | docs.stripe.com/customer-management/portal-deep-links; flow types present in stripe 18.5.0 types | Implementer, Installed package |
| Portal configuration: a downgrade can be scheduled for period end only between prices of the same product. With one product per tier, every portal downgrade applies immediately. | docs/STRIPE_SETUP.md section 5 | docs.stripe.com/customer-management/configure-portal and the billing_portal configuration API reference | Implementer, Reviewer |
| Smart Retries recommended policy (8 tries within 2 weeks), Checkout discounts, Stripe Billing pricing. | docs/STRIPE_SETUP.md sections 4 and 6 | docs.stripe.com/billing/revenue-recovery/smart-retries, docs.stripe.com/payments/checkout/discounts, stripe.com/billing/pricing | Implementer (discovery sweep) |

### Rate limits, auth and analytics clients (package P3 security)

| Fact the code relies on | Where | Source | Checked by |
|---|---|---|---|
| @upstash/redis 1.39.0: `new Redis({ url, token, retry: { retries, backoff }, signal })`, where `signal` is an AbortSignal or a function returning one, and `redis.eval(script, keys, args)` returning `Promise<TData>`. The implementer also found EVAL listed as supported in the Upstash REST docs (page URL not recorded). | apps/web/src/lib/rate-limit.ts | @upstash/redis 1.39.0 type definitions | Implementer, Installed package |
| Upstash env names `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the names the SDK reads). The getting started page did not show where the console lists the REST values. | docs/LAUNCH_CHECKLIST.md step 11 | upstash.com/docs/redis/overall/getstarted | Implementer (P7) |
| @supabase/auth-js 2.117.2 (through supabase-js 2.117.2) throws `AuthRetryableFetchError` with status 0 when no response arrives, and also for HTTP 500 to 504 and 520 to 530. The comment in auth-call.ts names only 502, 503 and 504; the check matches the error name, so every one of these shows the network message. | apps/web/src/lib/auth-call.ts | node_modules/@supabase/auth-js/dist/main/lib/fetch.js | Installed package |
| `supabase.auth.signUp({ options: { data } })` stores `data` as user metadata. The signed in user can rewrite it through `updateUser({ data })` with the public anon key, so `terms_accepted_at` there is not a trustworthy acceptance record. | apps/web/src/components/marketing/auth-form.tsx | supabase-js | Reviewer |
| posthog-js 1.434.16 exposes `posthog.__loaded` (boolean) and `posthog.capture(event, props)`. | apps/web/src/lib/track.ts, apps/web/src/lib/auth-call.ts | posthog-js 1.434.16 dist/module.d.ts | Installed package |

### Email (packages P4 credits and P7 platform)

| Fact the code or checklist relies on | Where | Source | Checked by |
|---|---|---|---|
| Resend send API: `POST https://api.resend.com/emails`, header `Authorization: Bearer <RESEND_API_KEY>`, JSON body `{ from, to (string or string array), subject, text }`, success response `{ id }`. The default alert sender `Curvi Alerts <alerts@curvi.ai>` only works once that domain is verified in Resend. | trigger/src/spend-alerts.ts, trigger/src/digest.ts | resend.com/docs (the implementer recorded the site, not the page) | Implementer (P4) |
| Resend sending domain: a subdomain is recommended; MX and SPF TXT on `send.<subdomain>`, DKIM TXT on `resend._domainkey.<subdomain>`; DMARC on the organizational domain. | docs/LAUNCH_CHECKLIST.md step 2 | resend.com/docs/dashboard/domains/introduction, resend.com/docs/dashboard/domains/cloudflare, resend.com/docs/dashboard/domains/dmarc | Implementer (P7) |
| Supabase Auth without custom SMTP sends only to pre-authorized addresses (the project team), at 2 messages per hour, with no delivery SLA. With custom SMTP the email rate limit starts at 30 messages per hour and can be raised. | docs/LAUNCH_CHECKLIST.md step 3 | supabase.com/docs/guides/auth/auth-smtp | Implementer (P7) |
| Resend SMTP for Supabase: host `smtp.resend.com`, port 465, username `resend`, password a Resend API key. | docs/LAUNCH_CHECKLIST.md step 3 | resend.com/docs/send-with-supabase-smtp | Implementer (P7) |
| Cloudflare Email Routing for hello@ and dmarc@ adds its own MX, SPF and DKIM at the root. | docs/LAUNCH_CHECKLIST.md step 4 | developers.cloudflare.com/email-routing/get-started/enable-email-routing/ | Implementer (P7) |

### AI providers (packages P6b AI layer and P6c runner)

| Fact the code relies on | Where | Source | Checked by |
|---|---|---|---|
| Claude image tokens: `ceil(w/28) x ceil(h/28)` visual tokens after downscaling to fit the long edge and token limits. High resolution tier (Claude 4.7 and later): 2576 px long edge, 4784 tokens per image. Standard tier: 1568 px, 1568 tokens. The cost estimate uses the high resolution limits for every model as an upper bound. | packages/ai/src/adapters/anthropicLLM.ts (ANTHROPIC_IMAGE_TOKEN_LIMITS) | https://platform.claude.com/docs/en/build-with-claude/vision | Implementer, Reviewer |
| Claude `stop_reason: "refusal"` (safety decline, HTTP 200): a non retryable error that still meters the billed tokens. | packages/ai/src/adapters/anthropicLLM.ts | platform.claude.com stop reason docs; also listed, with `stop_details`, in the Claude API reference bundled with Claude Code | Implementer |
| Gemini `promptFeedback.blockReason` values: BLOCK_REASON_UNSPECIFIED, SAFETY, OTHER, BLOCKLIST, PROHIBITED_CONTENT, IMAGE_SAFETY. Any value other than unspecified is treated as `content_blocked`. | packages/ai/src/adapters/geminiImage.ts | https://ai.google.dev/api/generate-content; Generative Language API v1beta discovery document (https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta), revision 20260927 | Implementer; enum list confirmed in this pass against the saved copy of that revision |
| Gemini `candidates[].finishReason` values treated as a safety or policy block: SAFETY, RECITATION, SPII, PROHIBITED_CONTENT, BLOCKLIST, IMAGE_SAFETY, IMAGE_PROHIBITED_CONTENT, IMAGE_OTHER, IMAGE_RECITATION. Other values (for example OTHER and NO_IMAGE) give `empty_output`. Neither is metered, since the price is per returned image. | packages/ai/src/adapters/geminiImage.ts | same as the row above | Implementer, Reviewer (IMAGE_OTHER wording); enum list confirmed in this pass against the saved discovery document |
| Gemini `generationConfig.imageConfig.aspectRatio`: supported values 1:1, 1:4, 4:1, 1:8, 8:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9; without it the model picks a shape from the reference images. The code sends only the ten common ratios (GEMINI_ASPECT_RATIOS), nearest to the canvas by log ratio; 1:4 to 8:1 are model specific. The field returns an error on models that do not support it. `imageConfig.imageSize` accepts 512, 1K, 2K and 4K (default 1K). | packages/ai/src/adapters/geminiImage.ts, trigger/src/live-runtime.ts | Generative Language API v1beta discovery document, revision 20260927, schema ImageConfig | Implementer (P6c); ratio and size lists confirmed in this pass against the saved discovery document |
| OpenAI image moderation refusal: HTTP 400 with `error.code` `moderation_blocked` (the older `content_policy_violation` is matched too) maps to `content_blocked`; not metered. | packages/ai/src/adapters/openaiImage.ts | https://developers.openai.com/api/docs/guides/image-generation | Implementer |
| BFL job statuses: Ready, Pending, Error, Content Moderated, Request Moderated, Task not found. Content Moderated and Request Moderated map to `content_blocked`; Error and Task not found fail the attempt. The result URL (`result.sample`) expires after 10 minutes, so the adapter downloads it at once. | packages/ai/src/adapters/bflFlux.ts | https://docs.bfl.ai/api_integration/integration_guidelines | Implementer |

### Hosting, deploys and background jobs (package P7 platform)

| Fact the code, render.yaml or checklist relies on | Where | Source | Checked by |
|---|---|---|---|
| Blueprint field `autoDeployTrigger: checksPass` replaces the deprecated `autoDeploy: true`; the dashboard setting is Auto-Deploy, "After CI Checks Pass". Render reads the GitHub checks of the commit: success, neutral and skipped pass; any failure, or zero checks found, means no deploy. | render.yaml, docs/LAUNCH_CHECKLIST.md step 5 | render.com/docs/deploys (Automatic deploys), render.com/docs/blueprint-spec | Implementer |
| Health checks (`healthCheckPath`): each check times out after 5 s; Render stops routing to an instance after 15 s of failures and restarts it after 60 s; a deploy whose new instance never passes within 15 minutes is canceled and the old version keeps serving. | render.yaml, apps/web/src/lib/service-health.ts, docs/LAUNCH_CHECKLIST.md step 8 | render.com/docs/health-checks | Implementer, Reviewer (15 s and 60 s) |
| Graceful shutdown: Render sends SIGTERM to the old instance 60 s after the new one is live. `maxShutdownDelaySeconds` (SIGTERM to SIGKILL) accepts 1 to 300, default 30, and is set in render.yaml or through the API (`PATCH https://api.render.com/v1/services/{id}` with `{"serviceDetails":{"maxShutdownDelaySeconds":300}}`), not in the dashboard. | render.yaml, apps/web/src/lib/jobs/inline-runner.ts, docs/LAUNCH_CHECKLIST.md step 8 | render.com/docs/deploys (Graceful shutdown), render.com/docs/blueprint-spec, api-docs.render.com/reference/update-service | Implementer |
| Free instances spin down after 15 idle minutes, run on 0.1 CPU and 512 MB, and Render says not to use them in production. Plan IDs since August 2026: `0.5c-512mb` (Starter), `1c-2g` (Standard), `2c-4g` (Pro); older names still work. | render.yaml, docs/LAUNCH_CHECKLIST.md step 9 | render.com/docs/free, render.com/docs/compute-plans | Implementer |
| Supabase migrations should use the direct connection (port 5432). The transaction pooler (6543) does not support prepared statements. The direct host is IPv6 only without the IPv4 add on; from IPv4 only networks use the session pooler (5432). | docs/LAUNCH_CHECKLIST.md step 6 | supabase.com/docs/guides/database/connecting-to-postgres | Implementer |
| Trigger.dev v3 is shut down on Trigger.dev Cloud: "v3 triggers and deploys no longer run." Self hosted 4.5.0 is the last version that runs v3. The code pins @trigger.dev/sdk 3.x, so `TRIGGER_SECRET_KEY` must stay unset on Render until the v4 upgrade, and the scheduled tasks do not run in production. | apps/web/src/lib/jobs/enqueue.ts, docs/LAUNCH_CHECKLIST.md step 14 | https://trigger.dev/docs/migrating-from-v3, https://trigger.dev/docs/upgrade-to-v4 | Implementer; Rechecked (earlier entries in this file and Update.md still assumed a v3 cloud deploy was possible; the migrating-from-v3 page confirms the shutdown) |
| Sentry Next.js setup through `npx @sentry/wizard@latest -i nextjs`; the SDK is not installed, so `SENTRY_DSN` does nothing yet. | docs/LAUNCH_CHECKLIST.md step 13 | docs.sentry.io/platforms/javascript/guides/nextjs/ | Implementer |

### Batch 1 fix pass: further external facts (recorded 2026-09-28)

| Fact | Where | Source | Checked by |
|---|---|---|---|
| Customer Portal downgrades can be scheduled for the end of the billing period only between prices of the same product; the default updates immediately. Portal configuration takes `features.subscription_update.products`, `proration_behavior` (none, create_prorations, always_invoice) and `schedule_at_period_end.conditions` (decreasing_item_amount, shortening_interval). | docs/STRIPE_SETUP.md sections 1 and 5 | docs.stripe.com/customer-management/configure-portal; docs.stripe.com/api/customer_portal/configurations/create | Implementer (F1) |
| Prorations are computed to the second over the subscription's current billing period; proration lines carry `parent.subscription_item_details.proration`. | apps/web/src/lib/billing/stripe-webhook.ts | docs.stripe.com/billing/subscriptions/prorations | Implementer (F1) |
| Dispute events: `charge.dispute.funds_withdrawn` when funds are removed, `charge.dispute.funds_reinstated` when they return, `charge.dispute.closed` on lost, warning_closed or won. Inquiry statuses (warning_needs_response, warning_under_review, warning_closed) withdraw no funds. The disputed amount can differ from the charge. | apps/web/src/lib/billing/stripe-webhook.ts, docs/STRIPE_SETUP.md section 3 | docs.stripe.com/api/events/types; docs.stripe.com/disputes/how-disputes-work | Implementer (F1). This supersedes item 4 under "Still unverified". |
| A negative invoice total is credited to the customer balance and the invoice closes as paid, so a downgrade debit relies on `invoice.paid` firing for it. | apps/web/src/lib/billing/stripe-webhook.ts | docs.stripe.com/billing/customer/balance (search summary, not the page itself) | Implementer (F1); confirm in test mode (docs/STRIPE_SETUP.md section 8) |
| Etsy: up to 20 photos per listing. | packages/specs/src/registry.json etsy.listing maxCount | help.etsy.com "How to Create a Listing" (page blocks direct fetch; text from Etsy Help search results) | Implementer (F2b) |
| eBay: up to 24 pictures, at least 500 px on the longest side, about 1600 px recommended, 12 MB each; no added borders, text, artwork or watermarks. | ebay.listing maxCount, size, bytes, textAllowed | ebay.com/help/selling/listings/adding-pictures-listings?id=4148; ebay.com/help/policies/listing-policies/picture-policy?id=4370 | Implementer (F2b) |
| TikTok Shop US: up to 9 square images, one selected as main; main on pure white showing the product front; at least 600 x 600; no added logos, text, borders or watermarks. | tiktokshop.main maxCount, textAllowed | seller-us.tiktok.com Product Listing Policy (knowledge_id 3196690250417921) and listing quality guidelines (knowledge_id 481891871868714) | Implementer (F2b). Replaces the "secondary sourced" note for TikTok Shop in the channel rules table above. |
| Walmart: main image on seamless white (RGB 255,255,255); added text and graphics only on additional images. Maximum image count not confirmed, so walmart.main has no maxCount. | walmart.main | marketplacelearn.walmart.com image guidelines (search snippets; the page did not render) | Implementer (F2b); still secondary sourced |
| Supabase Nano and Micro computes allow 60 direct connections and 200 pooler clients (Small 90 and 400, Medium 120 and 600); up to 80 percent of max connections can go to the Supavisor pool. The app pool is 10 and the worker pool 5. | apps/web/src/lib/services/db.ts, trigger/src/db-runtime.ts | supabase.com/docs/guides/platform/compute-and-disk; supabase.com/docs/guides/database/connection-management | Implementer (F4) |
| Render environment variables: "Save only" applies new values at the next deploy; `sync: false` values are prompted only when a Blueprint is first created and ignored on later Blueprint updates. | docs/phases/PHASE_10.md Before deploy step 2 | render.com/docs/configure-environment-variables; render.com/docs/blueprint-spec | Implementer (F4) |
| drizzle-orm 0.44.7 `migrate()` records each migration's journal `when` in `drizzle.__drizzle_migrations.created_at` and applies only migrations newer than the newest row. | /api/health schema check, docs/phases/PHASE_10.md step 5 | installed source node_modules/drizzle-orm/pg-core/dialect.js | Implementer (F4) |

### Batch 1 integration pass (recorded 2026-09-28)

| Fact | Where | Source | Checked by |
|---|---|---|---|
| "When calculating proration credits or debits, Stripe uses the subscription's discounted price, not the original price." Proration line items are `discountable=false`, so no further discount appears on them. | apps/web/src/lib/billing/stripe-webhook.ts prorationShare, docs/STRIPE_SETUP.md | docs.stripe.com/billing/subscriptions/prorations ("Prorations and discounts"); docs.stripe.com/api/invoice-line-item/object (`discountable`: "Always false for prorations") | Orchestrator, fetched 2026-09-28 |
| stripe-node 18.5.0 retries network errors twice by default (`maxNetworkRetries` 2); per request `RequestOptions.maxNetworkRetries` and `timeout` are honored. | apps/web/src/lib/billing/stripe.ts STRIPE_LOOKUP_OPTIONS | installed apps/web/node_modules/stripe source | Implementer (G1) |

### Batch 2, b2/reveal (recorded 2026-09-28)

| Fact | Where | Source | Checked by |
|---|---|---|---|
| `navigator.clipboard.writeText()` is available only in secure contexts (HTTPS) and rejects with a `NotAllowedError` DOMException when writing is not allowed. The reveal falls back to showing the link selected for a manual copy. | apps/web/src/components/app/pack-reveal.tsx | developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText | Implementer (b2/reveal), fetched 2026-09-28 |
| sharp `resize(w, h, { fit: "contain", background })` keeps the aspect ratio and letterboxes inside both dimensions with the background color, never cropping. | packages/pipeline/src/reveal/side-by-side.ts | sharp.pixelplumbing.com/api-resize | Implementer (b2/reveal), fetched 2026-09-28 |
| sharp's constructor accepts `limitInputPixels` (number or boolean). | packages/pipeline/src/reveal/side-by-side.ts | installed sharp lib/index.d.ts | Implementer (b2/reveal) |

### Batch 2: product link import, b2/url-import (recorded 2026-09-28)

| Fact | Where | Source | Checked by |
|---|---|---|---|
| Shopify storefront product JSON: `GET https://{store host}/products/{handle}.json` answers 200 `application/json` with `{"product": {...}}`. The product has `id`, `title`, `body_html` (HTML string), `vendor`, `product_type`, `handle`, `tags`, `variants[]`, `options[]`, `images[]` and `image`. Each image has `id`, `product_id`, `position`, `src` (absolute `https://cdn.shopify.com/...?v=...`), `width`, `height`, `alt` (nullable) and `variant_ids`; `image` is the featured one. It works on a store's own domain, not only on `*.myshopify.com`. | apps/web/src/lib/url-import/parsers.ts parseShopifyProduct, product-url.ts | Live response from www.allbirds.com/products/mens-tree-runners.json, fetched 2026-09-28. Shopify does not document the `.json` form; its documented sibling is the Ajax API `GET /{locale}/products/{handle}.js` (shopify.dev/docs/api/ajax/reference/product, checked 2026-09-28), which returns `title`, `description`, `images` and `featured_image` as protocol relative `//cdn.shopify.com/...` URLs. The parser therefore also accepts protocol relative `src` values and reads them as https. | Implementer (b2/url-import) |
| cdn.shopify.com picks the image format from the Accept header: with `Accept: image/jpeg,image/png,image/webp,...` (no AVIF) a `.png` src came back as WEBP. The photo import sends no AVIF in Accept and proves the type from magic bytes, not from the extension or header. | apps/web/src/lib/url-import/image.ts importPhoto | Live fetch of a cdn.shopify.com product image, 2026-09-28 | Implementer (b2/url-import) |
| Amazon product pages (`/dp/{ASIN}`) carry the title in `<span id="productTitle">`, bullets in `#feature-bullets` as `<span class="a-list-item">` items, the main photo as `<img id="landingImage">` with `data-old-hires` and a `data-a-dynamic-image` JSON map of URL to `[width, height]`, and the gallery in a script block `'colorImages': { 'initial': A.$.parseJSON('[{"hiRes":..., "large":..., "main":{...}}]') }` where `hiRes` can be `null`. No `og:image` tag was present. Pages were 1.4 to 1.6 MB of HTML. Amazon's robot check page posts to `/errors/validateCaptcha`. None of this is a documented API: Amazon offers no public product page contract, so the import treats every Amazon field as best effort and falls back to the name in the link. | apps/web/src/lib/url-import/parsers.ts parseAmazonPage, isAmazonBlockPage | Live pages www.amazon.com/dp/B07FZ8S74R and /dp/B0BSHF7WHW fetched 2026-09-28 with the import's own user agent (both answered 200 with the full page) | Implementer (b2/url-import) |

### Still unverified (batch 1)

1. **Harmonize output sizes behind the aspect tolerance.** `HARMONIZE_ASPECT_TOLERANCE = 0.04` (packages/pipeline/src/composite/index.ts) is the implementer's own figure. Neither the Gemini API reference nor the image generation guide lists output pixel sizes per aspect ratio (the guide at ai.google.dev/gemini-api/docs/image-generation was rechecked on 2026-09-28: it lists the ratios and the 512, 1K, 2K and 4K sizes, but no per ratio pixel table), and no BFL output size table was checked. The outcome depends on those sizes. Example: shopify.hero_banner is 2400x1000 (2.4:1) and its nearest Gemini ratio is 21:9. An output of 1584x672 drifts 1.8 percent and passes; 1536x672 drifts 4.8 percent and the shot fails. To close: at the first live key, run a harmonize call for a 1:1 and a 2.4:1 canvas on each image provider in the chain (the Gemini and BFL models in the seed), record width x height here with the date, and set the tolerance from those figures.
2. **Client IP header on Render behind Cloudflare.** `clientIp()` in apps/web/src/lib/rate-limit.ts trusts `cf-connecting-ip`, then `true-client-ip`, then `x-real-ip`, then the first `X-Forwarded-For` entry, and its comment says a Cloudflare edge overwrites any value the client sent. Cloudflare's HTTP headers reference (developers.cloudflare.com/fundamentals/reference/http-headers/, rechecked 2026-09-28) says CF-Connecting-IP carries the IP of the client connecting to Cloudflare; that True-Client-IP is the same value under another name, available only on the Enterprise plan through the "Add True-Client-IP header" Managed Transform; and that Cloudflare appends to an existing X-Forwarded-For rather than replacing it, so its first entry can be whatever the client sent. The page does not say whether Cloudflare replaces a CF-Connecting-IP value sent by the client. Nothing checked says what Render's own edge sets or strips, or whether curvi.ai traffic passes through a Cloudflare proxy before Render. Until this is tested, treat the per IP limit as spoofable; the per user limits still hold. To close: from outside, send requests with forged `cf-connecting-ip`, `true-client-ip`, `x-real-ip` and `x-forwarded-for` headers to a production route that logs the request headers it receives, record which values arrive, and make `clientIp()` trust only headers the edge sets.
3. **Whether BFL and fal charge for moderated or failed jobs.** Neither documents it. The adapters treat any failure after a successful create or submit as billed at the per image price (an upper bound for the spend caps). Confirm at the first live call.
4. **Stripe dispute lifecycle (closed by the fix pass, see the table above).** The P2 review proposed returning clawed back credits on `charge.dispute.closed` with status `won` or on `charge.dispute.funds_reinstated`, and skipping inquiries (statuses starting with `warning_`). None of these event names or statuses was checked against Stripe docs in batch 1; check them before building that handler.
5. **Redis script atomicity.** The Upstash limiter relies on EVAL running its INCR plus PEXPIRE script atomically. That is standard Redis scripting behavior but was not checked against a source in batch 1.
6. **`RENDER_GIT_COMMIT`.** /api/health reports it as `commit`, on the assumption that Render sets it at runtime. Not checked in batch 1; the first batch 1 deploy confirms it when `commit` is not null.
7. **Adapter request shapes.** The VERIFY AT FIRST LIVE CALL items listed under "Unverified adapter endpoint shapes" above are still open (anthropic-version value and field set, Gemini request casing, BFL create path, OpenAI response encoding, Photoroom multipart contract, fal queue fields).

### Production spot checks to record after the batch 1 deploy

Record each with its date here once done (order in docs/phases/PHASE_10.md, Before deploy):

- 0011: the four `*_r2_key_workspace_prefix` constraints exist (NOT VALID), and the audit query run before the migration returned no rows, or the rows it returned were fixed.
- 0012 plus `pnpm db:seed`: `platform_settings` has `free_signup_credits`, and a new confirmed signup outside the Supabase team gets exactly one `signup_grants` row and one signup grant in the ledger.
- 0013: the unique index `source_media_workspace_r2_key_uq` exists.
- `/api/health` on the new deploy returns 200 with `"schema":"current"` and a non null `commit`.
- The Update.md Wave 0 gate (docs/LAUNCH_CHECKLIST.md step 16, full version).

## 2026-09-28: LLM structured output and image memory

- Anthropic structured outputs (platform.claude.com/docs/en/build-with-claude/structured-outputs): strict tool use is `"strict": true` on a tool definition, no beta header. Supported on claude-haiku-4-5-20251001 and claude-sonnet-5 among others. Strict schemas reject numeric bounds (minimum, maximum, multipleOf), string bounds (minLength, maxLength, pattern) and recursive schemas; objects need `additionalProperties: false`; array minItems supports only 0 and 1. The SDKs strip these and validate client side; our raw HTTP adapter does the same through strictToolSchema plus Zod.
- sharp (sharp.pixelplumbing.com/api-utility, /install): `sharp.cache()` defaults to 50 MB, 20 files, 100 items and `false` removes caching. `sharp.concurrency()` defaults to the CPU count, except 1 on glibc Linux without jemalloc.
- Image adapters audited against current docs the same day (Gemini generateContent, OpenAI Images, BFL FLUX.2, Photoroom segment, fal queue): no call shape errors. Fixes applied: BFL "Failed" is terminal, Photoroom sends a typed file with Accept image/png, fal errors reported on COMPLETED are raised, Gemini interim thought images are skipped. Still open: OpenAI harmonize could use /v1/images/edits; BFL edit pricing above 1.33 MP is metered low; the gpt-image-1 shutdown date is now 2026-12-01.

### Batch 2 trust (branch b2/trust, recorded 2026-09-28)

| Fact | Where | Source | Checked by |
|---|---|---|---|
| R2's S3 API implements HeadObject, GetObject with a `Range` header, PutObject, ListObjectsV2 (`prefix`, `max-keys`, `continuation-token`) and DeleteObjects. The 1000 key batch size for DeleteObjects is the AWS S3 API limit, not re fetched in this pass; the R2 page does not state its own limit. | apps/web/src/lib/trust/storage.ts | developers.cloudflare.com/r2/api/s3/api/ | Implementer (b2/trust), fetched 2026-09-28 |
| `auth.admin.deleteUser(id, shouldSoftDelete?)` "Requires a `service_role` key" and "should only be called on a server". | apps/web/src/lib/trust/auth-admin.ts | supabase.com/docs/reference/javascript/auth-admin-deleteuser | Implementer (b2/trust), fetched 2026-09-28 |
| sharp removes all metadata on output by default, "which includes EXIF-based orientation"; `keepIccProfile()` keeps only the ICC profile; `rotate()` with no angle applies the EXIF orientation. JPEG `chromaSubsampling: '4:4:4'` avoids chroma subsampling. | packages/pipeline/src/ingest/image.ts | sharp.pixelplumbing.com/api-output | Implementer (b2/trust), fetched 2026-09-28 |
| sharp `limitInputPixels`: "Do not process input images where the number of pixels (width x height) exceeds this limit", default 268402689. sharp refuses even `metadata()` of an image over the limit, so the ingest reads the header with the limit lifted and applies the 80 MP cap itself (tested). | packages/pipeline/src/ingest/image.ts | sharp.pixelplumbing.com/api-constructor; behavior of installed sharp 0.34.5 | Implementer (b2/trust) |
| The prebuilt sharp binaries support "JPEG, PNG, Ultra HDR, WebP, AVIF, TIFF, GIF and SVG (input)"; HEIC is not listed, so HEIC uploads are recognized by their ftyp brand and refused with a plain notice. | packages/pipeline/src/ingest/image.ts | sharp.pixelplumbing.com/install | Implementer (b2/trust), fetched 2026-09-28 |
| WebP container: VP8X flag byte bits are Rsv(2) I L E X A R, so EXIF is 0x08 and XMP 0x04; metadata chunks are `EXIF` and `XMP ` (trailing space); odd sized chunks carry one zero padding byte; the RIFF size counts from offset 8. | packages/pipeline/src/ingest/image.ts stripWebpMetadata | developers.google.com/speed/webp/docs/riff_container | Implementer (b2/trust), fetched 2026-09-28 |
| PNG chunks are length (4), type (4), data, CRC (4), with the CRC over type and data only, so dropping whole chunks leaves the rest valid. tEXt, zTXt, iTXt, tIME and eXIf are ancillary. | packages/pipeline/src/ingest/image.ts stripPngMetadata | w3.org/TR/png-3/ | Implementer (b2/trust), fetched 2026-09-28 |
| QuickTime and MP4 atoms: a 32 bit size including the header, then the type; size 1 means a 64 bit extended size follows the type; size 0 (top level only) runs to the end of the file. The movie header `mvhd` holds version (1), flags (3), creation (4), modification (4), time scale (4) and duration (4) in version 0. | packages/pipeline/src/ingest/video.ts | developer.apple.com/documentation/quicktime-file-format (Atoms; Movie header atom) | Implementer (b2/trust), fetched 2026-09-28 |
| `mvhd` version 1 uses 64 bit creation, modification and duration fields (time scale stays 32 bit). Apple's page documents version 0 only. | packages/pipeline/src/ingest/video.ts mvhdDurationSeconds | ISO/IEC 14496-12 (ISO base media file format), not fetched: the standard is paywalled | Implementer (b2/trust); unverified against the text, covered by a synthetic fixture test |
| Render cron job schedules use cron expressions in UTC, commands must exit when done, a run is stopped after 12 hours, and each cron job service costs at least $1 a month. | docs/LAUNCH_CHECKLIST.md, "Schedule the 30 day source purge" | render.com/docs/cronjobs | Implementer (b2/trust), fetched 2026-09-28 |
