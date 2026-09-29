# Phase 16: more of every pack, fewer taps, and Curvi inside AI agents

Date: 2026-09-29. Source: a founder request after reviewing Higgsfield's public GitHub repositories (higgsfield-ai/skills, cli, app-templates, the SDKs) and the look-alike studios (wide-trace/open-higgsfield, Autom8AI/Open-Higgsfield-AI). Ideas only: the look-alike repositories have no detected license, so no code is copied from them. Higgsfield's own skills are MIT, and we read them as a product reference, not as code to vendor.

## Why now

Higgsfield's marketplace cards send the seller's photo through a generative image model (`nano_banana_2`) for every file, including the Amazon main image, and its product photoshoot does the same on GPT Image 2. Curvi never redraws the product (CLAUDE.md rule 3). Phase 16 adds the breadth their packs have (bundles, A+ modules, carousels, ad packs, agent distribution) while keeping every product pixel real. The site already says this since d672d72.

## Principles (apply to every workstream)

1. Rule 3 holds everywhere: every new format places the real product (cutout or kept photo) and passes the fidelity gate. No new shot type may call an image model on product pixels.
2. Rule 2: new templates, module copy slots, bundle definitions, question sets and prices live in the seed and the registry, never as literals.
3. Rule 4: every provider call (copy writing, the question step, logo palette reading) goes through packages/ai with timeout, retry, failover, breaker and cost metering.
4. Rule 5: every new tenant table has workspace_id, RLS and a test.
5. Rule 9 on every user facing string.
6. Builds on Phase 15: Looks, output options, remembered choices and the hold parity rules. Phase 15 must be merged first.

## Workstreams and priority

| # | Workstream | Priority | Size |
| --- | --- | --- | --- |
| 1 | Pack bundles ("how much" presets) | P0 | S |
| 2 | More A+ modules | P0 | M |
| 3 | Pinterest pins, social carousels and ad creative packs | P0 | L |
| 4 | The question step before generating | P0 | M |
| 5 | Curvi inside AI agents (skill, CLI, MCP, SDK) | P1 | L |
| 6 | Reuse, variations and a better gallery | P1 | M |
| 7 | Brand kit from a logo | P1 | S |

## 1. Pack bundles

**What the seller gets.** Four cards above the channel list in the new pack form, answering "how much": Main image only, Listing set (main plus secondary images), A+ set (main plus A+ modules), Everything. They sit beside Phase 15's Looks, which answer "how it looks".

**Model.**
- Seed `packBundles` in packages/pipeline/src/seed/templates.ts: `{ key, label, shotTypes: Shot["type"][], extras, aplusModules?, maxSecondary? }` for `main`, `listing`, `aplus`, `everything`.
- `bundle` joins OutputOptionsInput (Phase 15 schema, strict) with a default of `everything`, which equals today's pack. Normalization keeps `outputOptionsKey` stable for absent and explicit defaults.
- The planner filters shot types by bundle before `capShotsPerChannel`, with skipped reason `BUNDLE_OFF_REASON` "not in the chosen set" (copy: "Not in the set you picked. Not charged.").
- The estimate, createJob hold and planDemoShots take the bundle through `planFlagsOf`, so hold parity holds.

**UI.** A radiogroup of four cards with credit estimates from the seed. Picking a bundle updates the Extras checkboxes; changing an extra shows the Phase 15 "Custom" chip.

**Tests.** Planner snapshot per bundle; the parity property test gains bundles; `everything` equals today's default snapshot; route strictness.

**Implementation notes (built 2026-09-29, founder default: Everything).**
- `packBundles` holds `shotTypes`, `aplusModules`, `extras` and `maxSecondary`; `everything` takes `Shot.shape.type.options`, so new shot types join it without a seed edit. Workstream 2 adds its module types to `aplus.aplusModules`.
- The bundle is intersected with the Extra images switches: a shot type outside the bundle is skipped with `BUNDLE_OFF_REASON` whatever its switch says, and normalization turns off a family the bundle holds nothing of. `maxSecondary` caps other angle images (`alt_angle_white` or `original_photo` above priority 1).
- `bundle` is left out of the normalized options, the resolved row and the plan flags when it is `everything`, so today's packs, keys and snapshots are byte identical. Read it with `bundleOf`.
- Seller off cover never fills a spec the bundle emptied. `skipSellerOffShots` runs `skipBundleOffShots` first, so the runner's `fitShotsToChannels` applies bundles to LLM plans with no runner edit.
- Looks are bundle aware (`lookPresetFor(look, bundle)`), so picking a bundle never shows the Custom chip; changing an extra afterwards does.

## 2. More A+ modules

**What the seller gets.** Seven A+ modules built from templates around the real product photo: hero banner (today's aplus_banner), pain points, features, ingredients or materials, results, how to use, endorsement (reviews or badges the seller supplies).

**Model.**
- New shot types: `aplus_pain_points`, `aplus_features`, `aplus_ingredients`, `aplus_results`, `aplus_how_to`, `aplus_endorsement` (method template). Add them to Shot.type and leave them out of LlmShot unless pnpm eval shows the planner uses them well.
- Registry: each module targets `amazon.aplus.basic_header` sizes today; add the standard A+ module sizes (for example 970 by 300 and 300 by 300 image slots) after a rule 7 check of Amazon's A+ module specs, dated in docs/verification.md.
- Copy slots come from the existing copy_generator recipe (a new version with module slots: headline, three to five bullets, short labels), run through packages/ai. Claims guard: no medical, efficacy or percentage claims unless the seller typed them (reuse the complianceFlags from the analyzer; a `medical_claim` or `food_claim` flag drops the results module with a note).
- Endorsement never invents reviews: it renders only text the seller enters (a new optional `endorsements` seller input, capped length) or is skipped with "Add a review or award to include this module."
- Rendering: packages/pipeline/src/deterministic template cards, the product placed with placeOnBackground and the fidelity gate; text layout reuses the infographic renderer and brand kit fonts and colors.

**Credits.** creditCosts.deterministic per module (0.5), from the seed.

**Tests.** Rule 3 fidelity per module; copy lint (rule 9) on generated slots; a claims test that results never contains a number the seller did not supply; endorsement skipped without input.

**Implementation notes (built 2026-09-29, founder default: 0.5 credits per module).**
- Shot types `aplus_pain_points`, `aplus_features`, `aplus_ingredients`, `aplus_results`, `aplus_how_to`, `aplus_endorsement` (method template, `creditCosts.deterministic`). `LlmShot` leaves them and the new optional `Shot.headline` out, so the shot planner's tool schema is unchanged; the runner adds the deterministic plan's modules to an LLM plan after its first banner (`withAplusModules`).
- Seed `aplusModules` (spec, layout, min and max lines, compliance flags that drop it, brief) and `aplusCopy` (40 character slots, the 7 module page cap, claims guard words). `packBundles.aplus.aplusModules` holds all seven; modules join the `cards` extra family through the bundle only.
- The planner considers a module only when its spec is picked: hero banner, then the modules the profile supports (`moduleSkipReason`), then the second banner, and `capAplusModules` keeps at most 7 A+ files (the second banner goes first). Results is skipped for a `medical_claim` or `food_claim` flag.
- Every module renders at 970 x 600 (`amazon.aplus.basic_header`). The registry gains `amazon.aplus.wide_banner` (970 x 300), `single_image` (300 x 300), `four_images` (220 x 220) and `quadrant_image` (135 x 135), all coming soon in CHANNEL_SPECS until a module targets them.
- Copy: `copy_generator` version 2 (version 1 retired, it never ran) writes every generated module in one call through packages/ai with a strict tool schema (`AplusCopyResult`), booked on the job. `applyAplusCopy` lints each line for rule 9 and drops any line with a figure or claim word the seller did not type; a module falls back to the planner's guarded lines (features, materials) or is skipped, never padded and never charged. A job assigned version 1 runs the compiled version 2.
- Endorsement: Amazon's A+ guidelines do not allow customer reviews (docs/verification.md), so the seller input is press quotes or awards (`products.endorsements`, migration 0025, at most 3 lines of 40 characters), printed exactly as typed. Without one the module is skipped with "Add a press quote or award to include this module."
- Rendering: `renderTemplateStill` places the real product with the fidelity gate and draws the headline (heading font) and lines (body font, dot, square, step number or quote bar). `pnpm --filter @curvi/pipeline eval -- --stage aplus` renders every module around the golden set and checks rule 3 (60 of 60 on 2026-09-29).

## 3. Pinterest pins, social carousels and ad creative packs

**What the seller gets.**
- **Moodboard pin:** a 1000 by 1500 pinterest.pin with the product, its real scene and one short line.
- **Carousel:** 3 to 10 connected 1080 by 1350 slides (meta.feed_4x5) that read as one story: hook, benefits, details, in the box, call to action, with a continuous background across slides.
- **Ad creative pack:** 4 to 6 static ad variants per placement (Meta feed 1:1 and 4:5, Stories and Reels 9:16, TikTok 9:16, Pinterest 2:3) with headline and call to action variations inside each channel's safe zones.

**Model.**
- New shot types `pin_moodboard`, `carousel_slide` (with `slideIndex` and `carouselId` on the Shot), `ad_variant` (with `variantKey`). Method template, or composite_generate for the scene layer only (plates never contain the product; the product is composited and passes the fidelity gate, as lifestyle does today).
- Registry: add `tiktok.ad_9x16` and `meta.reels_9x16` specs with safe zones after a rule 7 check; reuse meta.feed_4x5, meta.story_9x16 and pinterest.pin.
- Carousel continuity: one wide canvas rendered once and sliced into equal slides, so the background flows across the swipe; product placements never cross a slice edge (a planner rule with a test).
- Ad copy: headline and call to action variants from the copy recipe, with each platform's text limits in the registry.
- Packager: carousels ship as a numbered folder (`carousel/01.jpg` ...), ad packs grouped by placement, plus a CSV of headlines and calls to action.
- New Extras family `ads` (pins, carousels, ad packs) in the Phase 15 extras model, off by default, shown in the Everything bundle.

**Credits.** Template slides at creditCosts.deterministic; a generated scene layer at creditCosts.generativeStill once per carousel canvas, not per slide.

**Tests.** Slice seams line up to the pixel; no product crosses a seam; safe zones; fidelity per slide; the hold counts one scene per carousel.

**Implementation notes (built 2026-09-29 on p16/formats, founder decision 4).**
- Registry: `tiktok.ad_9x16` (1080 x 1920, JPG or PNG, safe zone top 269, bottom 484, left 65, right 140, `textLimits.adText` 100) and `meta.reels_9x16` (1080 x 1920, 30 MB, safe zone 269, 672, 65, 65, `primaryText` 44); `meta.story_9x16` widened to the same zone as Reels (primary text 125, headline 40); feed headline 27 and primary text 125; `pinterest.pin` maxBytes 20 MB and title 100. `safeZone` gains optional `left` and `right`, `textLimits` is new, with `safeArea` and `adTextLimit` in @curvi/specs. The white, original, template and badge placements honor the side zones. `tiktok` is its own family (not TikTok Shop, not marketplace).
- Shot types `pin_moodboard`, `carousel_slide` (`carouselId`, `slideIndex`, `slideCount`, `headline`, `callouts`, `cta` on the last slide) and `ad_variant` (`variantKey`, `headline`, `cta`), all left out of `LlmShot`; the runner adds them to an LLM plan (`withAdsShots`). `social_9x16` now serves every 9:16 spec (story, Reels, TikTok), each inside its own safe zone.
- Seed `adsFormats`: pin spec, carousel spec (meta.feed_4x5), 3 to 10 slides, story beats hook, up to 3 benefits, details, in the box (seller lines only), call to action, the gradient share; ad pack placements, 4 to 6 variants, calls to action. Headlines come from the product's name, benefits and features through rule 9 lint and the A+ claims guard; a placement whose registry text limit fits fewer than 4 is left out with a reason.
- Extras family `ads` (the three types), off unless the seller turns it on and left out of the options while off (`compactExtras`, `extraOn`), so every existing `outputOptionsKey`, look and plan snapshot is unchanged; only Everything holds it. While off the planner considers no ads format at all.
- Carousels: `templates/ads-layout.ts` holds the geometry (`carouselGeometry`, `carouselSlideAreas`, `crossesSeam`, `carouselPlacementsValid`, the planner rule); `templates/ads.ts` paints any window of the one canvas (`renderCarouselCanvas`, `sliceCarouselCanvas`, `renderCarouselSlide`), so a slide is exactly its slice. A carousel ships whole or not at all (`dropIncompleteCarousels` in the planner and in `fitShotsToChannels`).
- Credits: template slides, pins and ads at `creditCosts.deterministic` (one ad variant is one shot for every placement it serves); with scenes on, the carousel's first slide carries one `creditCosts.generativeStill` and the other slides 0, and the pin with a scene is one generative still.
- Live: the first slide of a scene carousel makes the one scene layer through the image chain (packages/ai, caps and metering) and keeps it under `ws/{workspace}/cache/carousel/{job}/{carousel}.png`; the runner runs first slides before the others (`runInCarouselOrder`); a later slide never generates and needs review without the layer. The layer is placed under the product and text exactly (no harmonize pass), so rule 3 holds by construction. The pin with a scene is a normal composite with its line drawn after paste back, only where the product is not.
- Packager: carousel slides ship as `carousel/01.jpg` and on, ad variants as `ads/{placement}/v1.jpg`, and each zip with ads carries `ads/ads.csv` (placement, file, headline, call to action, formula safe). The all files zip keeps the folders.
- Web: the Pins, carousels and ads row in Extra images, estimate lines (the carousel is one line), skipped copy, an "Added" line on the choices card, and Carousel and Ads sections on the job page.

## 4. The question step before generating

**What the seller gets.** After upload, at most four short questions with labeled options, skipping anything the photo already answers. Example for the Gatorade photo: "Which product is this pack for? [Blue bottle] [Red bottle] [Both]", "Where will you sell? [Amazon] [Shopify] [Both]", "Scene mood? [Bright outdoor] [Kitchen] [Gym] [Studio]". Answers replace most free text notes, and the note stays optional.

**Model.**
- Built into the upload preflight (upload_preflights, Phase 14): a new `question_planner` recipe (seeded, Haiku class, strict tool output through packages/ai) reads the intake result, the inventory and the product profile draft and returns up to four questions, each `{ id, kind: target | channels | mood | use | audience, options: [{ value, label }] }`. Options for `target` come from the inventory (thumbnails), never from free text.
- Deterministic first: questions already answered by the inventory (single product), the product's remembered choices (Phase 15) or the seller's note are not asked.
- Answers are stored as structured `sellerAnswers` on the job (a jsonb column on generation_jobs in migration 0024, object check, RLS unchanged) and feed chooseInventoryTarget, sellerIntent and the scene planner with higher weight than the note.
- The step is skippable ("Skip, use my note") and never blocks submit.

**Tests.** Question count never above 4; no question whose answer is known; target answers resolve to inventory items; a pack with answers honors "Blue bottle only" without the note; pnpm eval golden set extension.

**As built (p16/questions).**
- Seed: `packages/pipeline/src/seed/questions.ts` holds the question set (prompts, max 4 questions, max options, the "Both" and "All of them" option, the skip label), `channelChoices` (marketplace families with their registry specs) and `moodChoices` (each with its scene preset and first scene). Recipe `question_planner` v1, new stage `question`, Haiku with Sonnet fallback, strict tool `QuestionPlanTool` through `llmJson` (metered, capped, failover).
- `@curvi/pipeline/questions` (client safe): `openQuestionKinds` (deterministic skipping: target only when the rules left 2 to 6 pieces ambiguous or in conflict; channels unless the note names a marketplace; mood unless the note names a mood or intake parsed style notes; use and audience unless style notes), `finalizeQuestions` (target options always the inventory items with their measured color; channel and mood options only seed values; use and audience labels only plain letters, at most 40 characters; deterministic target, channels and mood when the model fails), `SellerAnswers` (the shared schema for `generation_jobs.seller_answers`), `resolveSellerAnswers`, `intentWithAnswers`, `profileWithAnswers`, `applySceneAnswers`, `answerScenePreset`.
- Preflight (trigger/src/preflight.ts): step 4 plans the questions after intake and the inventory; stored in `upload_preflights.result.questions` (jsonb, no migration) and shown on the form. No model call when nothing is open.
- Form: `QuestionStep` under the note field, skippable ("Skip, use my note"), never blocking. The target question stands in for the chooser of its photo while shown; a pick sets that photo's chooser pick, "Both" keeps every item. A channels answer swaps the marketplace ticks. Remembered choices (a picked scene style, scenes off) and in the box photos hide the matching kind. The pack request sends ids and values only (`sellerAnswers: { key, picks }`); createJob resolves them against the stored questions, so every label on the job is the server's.
- Runner: `chooseInventoryTarget` rule 1b `answer` (after the seller's tap and in the box, before the model and the note): "all" features every piece; a picked product's color and label signals stand in for the note's. The merged intent (picked product as featureOnly, the other items excluded, mood, use and audience in style notes) is saved and feeds the picker and the judge. The answered mood and use lead the lifestyle scenes on both planners, and the mood's preset applies unless the seller picked a scene style. Answers never change a price or a shot count.
- Eval: `pnpm eval -- --stage questions` runs the question golden set (eval/questions.ts), no provider.
- Rule 7: no new external API. The call reuses strict tool use (checked 2026-09-28) and the seeded Haiku model.

## 5. Curvi inside AI agents

**What people get.** `npx skills add curvi-ai/skills` (and Claude Code and Cursor plugin marketplace entries) installs a "curvi" skill: give it a product photo and channels, get back a ready pack with the compliance report. A `curvi` CLI and a hosted MCP server expose the same actions.

**Model.**
- Public API v1 under apps/web/src/app/api/v1: `POST /packs` (photo upload or URL, channels, output options, bundle, answers), `GET /packs/{id}`, `GET /packs/{id}/files`, `POST /checks/main-image` (the free checker). Auth by workspace API keys (new `api_keys` table: workspace_id, hashed key, prefix, scopes, last_used_at, revoked_at; RLS and a test), managed at /app/settings/api. Idempotency-Key required, the same rate limits (Upstash) and credit holds as the web form.
- Hosted MCP server (Streamable HTTP) at /api/mcp with tools `create_pack`, `get_pack`, `check_main_image`, `list_channels`, authenticated by the same API keys.
- `packages/cli` (node, published as `curvi`): `curvi auth login`, `curvi pack create ./photo.jpg --channels amazon,shopify --bundle listing`, `curvi pack get`, `curvi check ./main.jpg`.
- `skills` repository: one SKILL.md that routes intent to the CLI (install, auth, bundle choice, deliver file URLs), MIT, in the style of higgsfield-ai/skills.
- SDKs later: a typed TypeScript client generated from the v1 OpenAPI document.
- Discoverability: list the MCP server and the skill in llms.txt, the docs and the directories the rule 7 check finds.

**Security.** Keys shown once, stored hashed, workspace scoped; every file URL signed and short lived; reviewer agent pass on the API.

**Tests.** API contract tests against the OpenAPI document; key scoping and revocation; MCP tool calls in the demo services; CLI e2e against demo mode.

**Implementation (p16/api, p16/cli).**
- Keys (apps/web/src/lib/api-keys): `cv_live_<12 hex>_<43 base64url>` (demo backend: `cv_demo_`). The prefix is the part before the last underscore (unique, `api_keys_prefix_uq`); `key_hash` is the sha256 hex of the whole key, compared in constant time. Scopes `packs:read`, `packs:write`, `checks`. Shown once at /app/settings/api (owners and admins; at most 20 active keys; revoke sets `revoked_at`). The prefix lookup and the throttled `last_used_at` write (at most once a minute) use the owner connection; the key then acts as its maker, with the maker's current role in the workspace. Gated by the seed tier entitlement `apiAccess` (Growth, Pro, Agency). `DEMO_API_KEY` works on the in memory demo backend only.
- Public API v1 (apps/web/src/lib/api-v1, routes under app/api/v1): the source of truth is `schemas.ts` and `openapi.ts` (GET /api/v1/openapi.json). `POST /packs` needs `Idempotency-Key` (at most 200 characters) and takes channels, photos (link or base64, at most 8), product fields, `bundle` and `look` shortcuts and `outputOptions`; answers are not accepted yet. `GET /packs/{id}`, `GET /packs/{id}/files` (signed links, 900 seconds), `POST /checks/main-image`, `GET /channels`. Rate limits reuse the web policies (`jobs.create`, `imports.photo` per workspace, `uploads.preflight`); credit holds are the web form's, through `Services.createJob`.
- Photos sent to the API land under `ws/{ws}/src/api-{sha256}` and are written only when that key is empty (conditional put, `If-None-Match: *`), so a retry or a later pack with the same photo never puts the raw upload back over the copy ingest cleaned. A request that makes no new pack (refused, replayed or in conflict) deletes the photos it wrote itself.
- MCP (`POST /api/mcp`, lib/api-v1/mcp.ts): stateless Streamable HTTP, POST only, protocol `2026-07-28` with the `initialize` handshake kept for `2025-11-25`, `2025-06-18` and `2025-03-26` clients. Discovery (`initialize`, `server/discover`, `tools/list`, `ping`) needs no key; `tools/call` checks the key with the tool's scope. A request without a well formed key is capped at 64 KB before it is read; only a keyed request gets the 40 MB photo body cap. Tools `create_pack`, `get_pack`, `check_main_image`, `list_channels`; `structuredContent` equals the v1 body.
- CLI (packages/cli, `@curvi/cli`, bin `curvi`, not published): `auth login|status|logout`, `pack create`, `pack get`, `check`, `channels`; `CURVI_API_KEY` and `CURVI_API_URL`. Runs its TypeScript directly on Node 22.18 and later; publishing needs a JS build step.
- Skill: skills/curvi/SKILL.md (name `curvi`, MIT) until the curvi-ai GitHub org exists (founder decision 6). `FEATURES.agentApi` and `FEATURES.agentSkill` stay coming soon.
- Review: the reviewer agent pass this section's Security line asks for is still to run before `FEATURES.agentApi` flips (see Rollout). It covers lib/api-keys, lib/api-v1, app/api/mcp, packages/cli (key storage, `--out` path handling) and the workstream 6 tenant writes in services/db.ts (favorites, the picked flip, the zip delete).

## 6. Reuse, variations and a better gallery

**What the seller gets.**
- **Reuse:** "Make this pack again" on any job restores channels, output options, bundle and answers, with a new photo or the same one.
- **Variations:** up to 4 scene variations per lifestyle shot; the seller picks which ones ship. Each extra beyond the first is charged at `creditCosts.generativeStill` (founder decision 3, rule 2).
- **Gallery:** a masonry grid at each image's true aspect ratio, favorites, filters by channel and shot type, in the job page and a new /app/library.

**Model.**
- Reuse reads `generation_jobs.output_options`, `sellerAnswers` and the channel list into the new pack form as a prefill (never server side, same rule as Phase 15 memory).
- Variations: `variants` on a lifestyle shot, generated as extra plates with the same product composite and fidelity gate; asset_variants gains `picked` (migration 0024) and the packager ships only picked ones.
- Favorites: a `favorites` table (workspace_id, asset_id, created_at) with RLS and a test.

**Tests.** Reuse restores every field; unpicked variations are never packaged or charged beyond the seed price; favorites are workspace scoped.

**Implementation (p16/reuse).**
- Seed: `variationOptions` (min 1, max 4, default 1) in packages/pipeline/src/seed/variations.ts. No new price key: each extra version is `creditCosts.generativeStill`.
- Options: `variations` joins the output options like the bundle: present in the normalized, resolved and plan flag objects only past the default, read with `variationsOf`, never part of a look (lookOf ignores it), and part of `outputOptionsKey`.
- Plan: `applyVariations` (packages/pipeline/src/variations.ts) marks each lifestyle shot with `Shot.variations` and adds the extra versions to its credits, in planShots and in the runner's fitShotsToChannels before the budget trim, so the estimate, the hold and the trim agree. The shot keeps one slot per channel. LlmShot leaves `variations` and `variation` out.
- Run: `expandVariations` turns a marked shot into the scene itself plus shots `{id}.v2` to `.v4` (`Shot.variation`), each its own generation through the same composite and fidelity gate. The runner packages only the scene itself; each extra version number is packaged on its own (same checks) into `StoredPack.variations`, never zipped. DbJobStore uploads those files under `files/{channel}/variation-{n}/` and records them with `picked` false. A passing extra version is charged `generativeStill`; one that does not pass is released.
- Web: `pickShotVersion` (PUT /api/jobs/[id]/shots/[shotId]/pick) flips `picked` for one version's files under the workspace lock, refuses a channel past its file limit, drops the stale channel zip rows and never touches the ledger. The file list, the all files zip and the share page read picked files only.
- Reuse: `getReusePrefill` and /app/new?from={jobId} fill the form with the job's channels, options (bundle and versions included), answers (tapped where the new questions offer them) and note. A prefill only.
- Favorites: `setFavorite` (PUT /api/assets/[assetId]/favorite), owners, admins and editors, the workspace's own assets only. Gallery: `GalleryGrid` on the job page and /app/library (`listLibrary`), a masonry grid at each file's measured size, filters by channel family, shot type and favorites. Rate limit policy `assets.write`.

## 7. Brand kit from a logo

**What the seller gets.** Upload a logo at /app/brand and the kit fills in: 3 to 5 brand colors, a suggested background color, and a text color that passes contrast on each.

**Model.**
- Deterministic first: sharp reads the logo, ignores transparent and near white pixels, and clusters colors (k means in Lab); no model call for simple logos.
- A vision call through packages/ai only when clustering is ambiguous, returning names for the colors.
- Suggestions only: the seller confirms before the kit saves. Contrast pairs checked with the existing contrast helper.

**Tests.** Known logo fixtures return their palette within a delta E of 2; transparent logos work; nothing saves without confirmation.

**Implementation (p16/logo).**
- Seed: `brandPalette` in packages/pipeline/src/seed/brand.ts holds every threshold (sample size, alpha and near white cut, k, merge and share limits, ambiguity coverage, background tint, minimum contrast 4.5 per WCAG 2.2, checked in docs/verification.md). Recipe `brand_palette_namer` v1, new stage `brand`, Haiku with Sonnet fallback.
- Pipeline: packages/pipeline/src/brand/palette.ts (`@curvi/pipeline/brand`). `readLogoPalette` bins opaque, not near white pixels, runs a deterministic weighted k means in Lab, merges clusters under CIEDE2000 8, drops clusters under 3 percent, reads each swatch from its densest bins. Ambiguous when more than 5 colors remain or the kit colors cover under 85 percent of the logo within delta E 4. `applyPaletteNaming` keeps only measured candidates. `textColorFor` picks the seeded dark or white text by WCAG ratio and reports whether it passes. Fixtures in src/brand/fixtures.
- Runner: trigger/src/brand-palette.ts `runBrandPalette(deps, { requestId, workspaceId, logoKey })` loads the logo from the workspace prefix and calls the recipe through `llmJson` (packages/ai metering, caps, failover) only when ambiguous.
- Web: `Services.suggestBrandPalette(workspaceId, logoKey)` (owner, admin, editor; plan with a brand kit; key in the source prefix; upload check), server action `suggestBrandPaletteAction` rate limited by `brand.palette`, and a confirm panel on /app/brand. Use these colors only fills the form; the kit saves through the existing save.

## Data model summary (migration 0024, next free number at implementation)

- generation_jobs: `seller_answers jsonb` (object check).
- asset_variants: `picked boolean not null default true`.
- New tables with workspace_id and RLS: `api_keys`, `favorites`.
- Seed: `packBundles`, A+ module templates and copy slots, ad and carousel templates, `question_planner` recipe, copy_generator new version, the `apiAccess` tier entitlement (founder decision 5). Extra variations reuse `creditCosts.generativeStill` (founder decision 3), so no `creditCosts.variation` key.
- Registry: A+ module sizes, `tiktok.ad_9x16`, `meta.reels_9x16`, text limits, all after rule 7 checks.

## Rollout order

1. Workstream 1 (bundles) and 7 (logo palette): small, no new provider surface.
2. Workstream 2 (A+ modules) with the copy recipe version and pnpm eval.
3. Workstream 4 (question step) with its recipe and eval; migration 0024 lands here.
4. Workstream 3 (pins, carousels, ad packs).
5. Workstream 6 (reuse, variations, gallery).
6. Workstream 5 (API, MCP, CLI, skill), after a reviewer agent security pass.

Each step: plan detail in this file first (rule 1), worker deployed before web, the rule 6 gate, and reviewer agent on anything touching tenant tables, providers or billing.

## Founder decisions

Decided 2026-09-29 as defaults. The founder may revise any of them later; a change lands in the seed or the registry (rule 2), not in code.

1. **Bundle default: Everything.** `bundle` defaults to `everything`, which equals today's pack, so an absent bundle and an explicit `everything` give the same plan, estimate, hold and `outputOptionsKey`.
2. **A+ module price: 0.5 credits each.** Every A+ module is charged at `creditCosts.deterministic` (0.5 in the seed today). No bundle discount: the A+ set costs the sum of its modules.
3. **Variations: 1 per scene by default.** The seller can ask for up to 4 variations of a lifestyle scene. The first is included in the shot's normal price; each extra variation is charged at `creditCosts.generativeStill` (1 in the seed today). Only picked variations ship. This replaces the `creditCosts.variation` idea in section 6 and the data model summary: no new price key is added.
4. **Carousel scene: one generated canvas per carousel.** When scenes are on, a carousel gets one generated scene canvas at `creditCosts.generativeStill`, sliced into its slides, never one per slide. When scenes are off, slides use template backgrounds at `creditCosts.deterministic` per slide.
5. **API keys and MCP: Growth plan and up.** A new seed tier entitlement `apiAccess` (true on Growth and higher tiers, false below) gates /app/settings/api, the v1 API and the MCP server. Rate limits reuse the existing Upstash limiter settings; no new limiter numbers.
6. **Skill distribution: in this repo for now.** The skill lives in `skills/curvi/` in this repository under MIT until a curvi-ai GitHub org exists. The CLI is `packages/cli` and is not published to npm yet. Marketplace listings wait for the org.
7. **The question step sits beside the note field.** It is skippable and never blocks submit; the note stays where it is.

## Done when

- Every workstream's tests pass, `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` passes, and `pnpm eval` shows no regression (rule 6).
- A rule 3 test covers every new shot type.
- docs/verification.md has dated rows for A+ module sizes, TikTok and Reels ad specs and text limits, and any directory listing requirements.
- The home page, pricing page and llms.txt describe bundles, A+ modules, carousels, ad packs and the agent skill, with no claim that is not live.

## Implementation status

Recorded 2026-09-29 on the integration branch `p16/integration` (head 38bd279 before the fix passes and this docs commit). Nothing from this phase is live in production: migrations 0024 and 0025, the re-seed, the worker, the web app and the eval run are founder steps (docs/PENDING.md, "Phase 16 founder steps"). All seven founder decisions above are built as their recorded defaults.

### What shipped, per workstream

| # | Workstream | Status | Where |
| --- | --- | --- | --- |
| Foundations | Migration and rule 7 checks | Built | Migration 0024 (`generation_jobs.seller_answers` with an object check, `asset_variants.picked`, `api_keys`, `favorites`, the `assets (id, workspace_id)` unique index) with RLS tests; dated rows in docs/verification.md for A+ sizes, TikTok, Reels and Story safe zones, text limits, MCP and skills. |
| 1 | Pack bundles | Built | Seed `packBundles`, `bundle` in the output options (default `everything`, left out of every key while default), `skipBundleOffShots`, bundle aware Looks, `PackBundleCards` on the form. |
| 2 | More A+ modules | Built | Six template modules, `copy_generator` v2 with the claims guard and rule 9 lint, press quote and award endorsements (migration 0025), four coming soon A+ registry sizes. |
| 3 | Pins, carousels and ad packs | Built | `pin_moodboard`, `carousel_slide`, `ad_variant`; `tiktok.ad_9x16` and `meta.reels_9x16`; one sliced canvas per carousel; `carousel/NN` and `ads/{placement}/vN` folders with `ads/ads.csv`; the `ads` extra family, off by default. |
| 4 | Question step | Built | `question_planner` v1 (stage `question`), deterministic skipping, `SellerAnswers` stored on the job, `QuestionStep` under the note field, skippable. |
| 5 | Curvi inside AI agents | Built, not public | Public API v1 (`/api/v1/packs`, `/packs/{id}`, `/packs/{id}/files`, `/checks/main-image`, `/channels`, `/openapi.json`), hosted MCP server at `/api/mcp` (protocol 2026-07-28), workspace API keys at /app/settings/api gated by `apiAccess`, the `curvi` CLI in `packages/cli` and the skill in `skills/curvi/` (MIT). `FEATURES.agentApi` and `FEATURES.agentSkill` stay coming soon. |
| 6 | Reuse, variations, gallery | Built | "Make this pack again" (`/app/new?from=`), up to 4 scene versions with `picked`, favorites, `/app/library` with the masonry `GalleryGrid`. |
| 7 | Brand kit from a logo | Built | `readLogoPalette` (Lab k means, CIEDE2000), `brand_palette_namer` v1 only when ambiguous, confirm panel on /app/brand, nothing saves without the seller. |

### Deviations from this plan

- Migration 0024 did not hold everything: endorsements needed `products.endorsements`, so migration 0025 was added. The next free number is 0026.
- Extra variations reuse `creditCosts.generativeStill`; no `creditCosts.variation` key exists (founder decision 3).
- Every A+ module renders at 970 x 600 on `amazon.aplus.basic_header`. The four smaller A+ sizes are in the registry as coming soon, since no module targets them yet.
- Endorsements are press quotes and awards, not customer reviews, because Amazon's A+ guidelines do not allow reviews. The module's skip copy says so.
- The A+ modules, the ads formats, `headline`, `variations` and `variation` are left out of `LlmShot`; the runner adds the deterministic plan's modules and ads shots to an LLM plan. Ad headlines and calls to action are planned deterministically, not written by the copy recipe.
- `POST /api/v1/packs` has no answers field. Seller answers cannot go through the API, the MCP server or the CLI yet; supporting them needs a preflight for API uploads.
- The skill and CLI are in this repository, and the CLI is not on npm (founder decision 6). The CLI help and SKILL.md say "Growth plan and up" as text, matching the seed's `apiAccess` tiers with no test tying the two.

### Known gaps

Updated after the review fixes merged into p16/integration (fix-other, fix-trigger, fix-webapi, fix-webui, fix-pipeline, fix-docs). Those passes closed: the bundle seam in `validateLlmShotList`, a scene carousel shipping without slide 1, the ads hold for the richest carousel, the idempotency replay on other photos or notes, the "Reviews" label, API retries overwriting a cleaned photo, the unkeyed MCP body size, the workspace cap on brand palette calls, the question step skip and toggles, gallery transparency, and ad copy from the recipe (copy_generator v3, now wired in the runner copy step).

- A small bundle with only non marketplace channels can plan zero shots and show "About 0 credits".
- The all files zip does not include `ads/ads.csv` and can give a picked extra version a `-2` suffix. Picking a version does not update the compliance report.
- The TikTok safe zone and the A+ sizes other than 970 x 600 come from secondary sources (`tiktok.ad_9x16` is marked verified false).
- Question channel and mood keywords are English only.
- Marketing copy: llms.txt, llms-full.txt and the JSON-LD now describe pack sets, A+ modules and ads formats behind `FEATURES.packBundles`, `aplusModules` and `adsFormats`. The home page, the pricing page and the seed `includeLines` still do not, and the seed `featureStatus.apiAccess` is live while `FEATURES.agentApi` is coming soon. The "Done when" copy item is open.
- The help article and llms.txt say the API and MCP server are coming soon, while /app/settings/api hands Growth workspaces working keys. A founder decision is needed: flip `FEATURES.agentApi` when the API ships, or gate the routes until then.
- Ad placements dropped on a sparse profile (`AD_PLACEMENT_SHORT_REASON`, `ADS_NO_COPY_REASON`) are not refilled from recipe copy, because the plan, estimate and hold are fixed before any model call. The pin headline and the carousel CTA slide still use the planner's lines.
- A carousel slide dropped at packaging time still lets the other slides ship. A per slide retry of a needs review carousel slide in follow-up.ts could ship that one slide alone; the web app should block it or retry the whole carousel.
- No `workspace_day` spend cap exists for any LLM call. Brand palette spend is logged, not metered against the workspace.
- API photo cleanup race: a refused request can delete a photo key a concurrent request with the same photo skipped writing. The retry stores it again. The R2 status for a failed `If-None-Match` put was not confirmed against a live bucket; any status other than 412 fails safe as a 503.
- API answers cover channels and mood only (no target, use or audience), and the CLI has no `--answer` flag yet. Idempotency does not compare title, sku, box contents, comparison facts, endorsements, answers or photo order, and photos are fetched before the key is checked.
- With ads on, the estimate shows the most the seed allows (for example "Carousel, 7 slides"); an "up to" wording may read better.

### Needs a live run

- `pnpm eval` with live keys for `copy_generator` v3 (v2 plus ad lines, now the active copy recipe; production needs a recipe re-seed), `question_planner` v1 and `brand_palette_namer` v1 (none has live fixtures yet), and the `--stage aplus` and `--stage questions` golden sets (the A+ fidelity stage passed 60 of 60 offline on 2026-09-29). There is no eval stage for the ads formats yet.
- A scene carousel against a real image provider, with the R2 cutout cache shared across shot subtasks.
- The MCP server against real clients (only the spec's message shapes are tested).
- `pnpm e2e`: not run on the integration branch. Earlier reports named pre existing failures in e2e/home-hero.spec.ts (3) and e2e/claims.spec.ts (1). There are no Playwright specs yet for /app/library, Make this pack again, version picking, the Carousel and Ads sections or /app/settings/api.
- A reviewer agent pass on the tenant writes (favorites, the `picked` update, the zip row delete in `pickShotVersion`), on workstream 5 (the owner connection prefix lookup, keys acting as their maker, MCP discovery without a key, the `api-{sha256}` source keys, CLI key storage, `--out` path handling) and on the /app/brand vision call. Rollout step 6 requires the workstream 5 pass before the API goes public.
