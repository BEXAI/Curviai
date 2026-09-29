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
- **Variations:** up to 4 scene variations per lifestyle shot; the seller picks the one that ships. Only the picked one is charged at full price (seed `creditCosts.variation` for extras, rule 2, founder decision).
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

## Data model summary (migration 0024, next free number at implementation)

- generation_jobs: `seller_answers jsonb` (object check).
- asset_variants: `picked boolean not null default true`.
- New tables with workspace_id and RLS: `api_keys`, `favorites`.
- Seed: `packBundles`, A+ module templates and copy slots, ad and carousel templates, `question_planner` recipe, copy_generator new version, `creditCosts.variation` if the founder approves a price.
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

1. Bundle default: Everything (today's pack) or Listing set.
2. Price of an A+ module: 0.5 credits (deterministic) or bundle pricing for the A+ set.
3. Variations price: free extra variations up to 4, or a seed price per extra variation.
4. Carousel scene: one generated canvas per carousel (1 credit) or template backgrounds only.
5. Public API and MCP: which plans get API keys (Growth and up is the suggestion), and rate limits.
6. Skill distribution: publish under a curvi-ai GitHub org (needs creating) and list in the Claude Code and Cursor marketplaces.
7. Whether the question step replaces the note field by default or sits beside it.

## Done when

- Every workstream's tests pass, `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` passes, and `pnpm eval` shows no regression (rule 6).
- A rule 3 test covers every new shot type.
- docs/verification.md has dated rows for A+ module sizes, TikTok and Reels ad specs and text limits, and any directory listing requirements.
- The home page, pricing page and llms.txt describe bundles, A+ modules, carousels, ad packs and the agent skill, with no claim that is not live.
