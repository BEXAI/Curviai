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
  - A Trigger.dev cloud deploy must ship the font file (set CURVI_TEMPLATE_FONT_FILE or add it to the build); the web inline runner resolves it from node_modules.

- OCR engine and embedding similarity (DINOv2 or CLIP) implementations behind the existing pluggable QC interfaces; semanticChecks is still not invoked from the runner.
- c2pa-node manifest signing once a signing certificate exists.
- compliance-report.pdf rendering (JSON ships now).
- Square video channel spec (video.social_1x1) for 1x1 template renders.
- Half open probe state for the circuit breaker; Upstash backed breaker and cap stores; DB backed cost meter (cogs_micros still not written to the database).
- Badge pixel overlay for social exports and the Concept render corner label (flags are tracked, pixels not composited yet).
- Founder email or SMS for the $50 spend alert (onSpendAlert currently logs a console warning).
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
