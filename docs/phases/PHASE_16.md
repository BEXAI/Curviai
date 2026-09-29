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
