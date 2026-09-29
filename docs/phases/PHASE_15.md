# Phase 15: seller controls for every output

Date: 2026-09-29. Source: a founder request, revised after two code reviews (see the review log at the end). Every fact under "Starting point" was checked in the code on main.

Sellers decide what Curvi does to their photos:

- Background removal becomes a switch, on by default.
- The background color becomes a choice, White by default.
- A seller who only needs correctly sized files for each channel can keep the original photo. Nothing in it is generated, retouched or cut out.
- Other optional inputs are sorted into P0 (ships with the background controls), P1 (fast follow in this phase) and a backlog for PHASE_16.

## Base and work in flight

- Base: main at 56df4fc. p14/preflight (ad83fce) and p14/provider-resilience (56df4fc) are merged.
- One locked agent worktree exists: `.claude/worktrees/wf_c2ad23a8-a38-4` on branch `home/liquid-metal` at 56df4fc. It has uncommitted changes to apps/web/package.json (adds `@paper-design/shaders-react` 0.0.81) and pnpm-lock.yaml (read from .git/worktrees and the worktree files, 2026-09-29). It overlaps this phase only on those two files. Land it, or rebase after it, before Phase 15 adds any dependency.
- Migrations on main end at 0022_upload_preflights, so 0023 is the next free number today. Take the next free number again at implementation time. Production must have 0022 applied before this phase's migration.
- If an open PHASE_14 follow up (1.6 alerting, workstream 5) is in flight on new-pack-form.tsx, live-runtime.ts, pipeline-runner.ts or job-copy.ts, land it first.

## What the seller gets

- A form section, "How your images look", with three looks: Marketplace ready (today's pack), Keep my photo, and Brand look.
- A "Remove the background" switch, on by default.
- A "Background color" dropdown, White by default: seeded colors, the brand kit colors and a custom color.
- A plain line under each channel that needs a white background, with a one tap "Leave it out".
- Extra images the seller turns on or off: lifestyle scenes, studio backdrops, transparent PNG, graphics with text, social and banner cards.
- An estimate that follows every choice. A pack that does less holds and costs less.
- The same choices on retries and added angles, a "Your choices" card on the job page, and a plain note in the compliance report for every file.

## Starting point (verified on main, 2026-09-29)

| Area | What the code does today | Where |
| --- | --- | --- |
| Every live shot needs the cutout | generateLive throws ShotUnavailableError when `wiring.cutoutLive` is off and always calls productFor before rendering. No shot ships the seller's photo with its background. | trigger/src/live-runtime.ts, generateLive (line 1246) |
| No output option exists | Nothing in the form, JobRequest, CreateJobInput, generation_jobs, GeneratePackInput, ShotContext or PlanOptions holds one. A note like "keep my background" lands in sellerIntent.styleNotes and is ignored. | |
| White is a literal | placeOnWhite fills with `Buffer.alloc(..., 255)` (line 207) and blends edge pixels toward 255 (224 to 226). makeSweep (397) and encodeUnderLimit (536) flatten onto `"#ffffff"`. encodeJpeg flattens onto `"#ffffff"`. makeAmazonMain and makeSweep use `spec.width ?? 2000` (104, 317). | packages/pipeline/src/deterministic/whiten.ts, packages/pipeline/src/raw.ts (143) |
| Four specs need white | amazon.main and walmart.main are solid 255 and get the main class pixel checks. google.merchant.main is white_or_transparent. tiktokshop.main is white_preferred, and TikTok policy asks for a pure white main image. Only planner routing guards the last two; no pixel check measures them. | registry.json, qc/pixelChecks.ts |
| Registry facts | `exactSize` already exists (meta.*, pinterest.pin, amazon.aplus.*, shopify.hero_banner). google.merchant.main already has `overlaysAllowed: false`. google.merchant.lifestyle has no size, megapixel or byte maximum, and google.merchant.main has no size maximum. amazon.aplus.premium_full is coming soon (isSpecLive false), and no shot targets it. | packages/specs, apps/web/src/lib/marketing-facts.ts |
| Credit arithmetic | Every seed price is a multiple of 0.5, which binary floats hold exactly. estimatePackCredits (Math.ceil of a float sum), trimToBudget, validateLlmShotList (`total > budget`) and JobLedgerPlan.assertHolds (`credits > outstanding`) all compare raw floats. A price like 0.2 would drift (0.2 five times sums to 1.0000000000000002). | pack-estimate.ts, planner/deterministic.ts, pipeline-runner.ts, trigger/src/state.ts |
| The hold | estimatePackCredits plans a reference product photographed front, 45 and back, in the form, in createJob and in planDemoShots. Today's default pick (amazon.main, amazon.secondary, shopify.product, meta.feed_1x1) plans 11 shots, 6.5 credits, hold 7. createJob plans on mergePackMedia: this request's uploads, or the product's stored photos, capped at MAX_PACK_PHOTOS (6). | pack-estimate.ts, services/db.ts |
| LLM plan order | runGeneratePack calls validateLlmShotList, which includes the budget check, before fitShotsToChannels. It sends `{ profile, options: planOptions }` to the plan recipe. | pipeline-runner.ts 3266 to 3311 |
| Several products | The form blocks with "Tap the product this pack is for." on a choose preflight. The runner throws MULTIPLE_PRODUCTS_MESSAGE for any ambiguous photo before analysis, including unboxed photos that intake says hold several items. | preflight/copy.ts, pipeline-runner.ts 1126 to 1175 and 3199 |
| Runner LLM calls | analyze (claude-sonnet-5 with vision) runs on every pack. intake runs unless the upload preflight answer is reusable. | pipeline-runner.ts 3066, 3206 |
| Media ids | buildGeneratePackInput sets `mediaId` to the R2 key. The payload carries no photo width or height, though source_media stores both. | apps/web/src/lib/jobs/payload.ts |
| Upload ingest | Metadata is stripped byte for byte only for JPEG, PNG and WebP with EXIF orientation 1. A rotated photo is decoded and written again (JPEG q95 4:4:4, WebP lossless or q95). GIF and TIFF become PNG. The rewritten flag is not stored. | packages/pipeline/src/ingest/image.ts, apps/web/src/lib/trust/ingest.ts |
| Cutout cache | The upload preflight pays one cutout per photo and caches it in R2 for 24 hours. The cache wraps provider.invoke inside callWithFailover, so an open breaker hides a cached cutout. | trigger/src/cutout-cache.ts, packages/ai/src/router.ts (454) |
| Subtask boundary | SerializedPackFile carries specId, base64 bytes, format, the mask PNG and edgeMarginPx only. | pipeline-runner.ts 693 |
| Badge | The packager draws the free tier badge after the runner's checks, re-encodes the file, and keeps it clear of the mask it is given. | packager/index.ts 215, packager/badge.ts |
| Fidelity kind | checkGeneration and encodeForSpec take the kind from qcKindForSpec: "main" only for amazon.main and walmart.main. encodeForSpec starts JPEG at 90, climbs to 95, 98 and 100 when fidelity fails, then tries PNG. | pipeline-runner.ts 1863, trigger/src/shot-outputs.ts 174 |
| Per spec rendering | runShot renders deterministic and template shots once per target spec through runOutput, so one shot can carry a different background per spec. | pipeline-runner.ts runShot |
| Demo and e2e | Playwright runs the web demo services. demoShotImage returns a 400 by 400 SVG, and demoComplianceReport sets `notes: []`. The e2e upload stub is an 8 byte PNG header. | services/demo.ts, compliance-report.ts, e2e/preflight.spec.ts |
| Free resizer | The marketing Marketplace Resizer pads a photo with white for amazon.main and other specs, free behind the email gate. | components/marketing/marketplace-resizer.tsx |
| Flags and tests | CONCEPT_MODE_AVAILABLE is a literal `false`. packages/ui has no test runner. apps/web component tests use renderToStaticMarkup. | lib/features.ts |
| Pauses | packs_paused disables Create pack. PACKS_PAUSED_COPY reads "Packs are paused for a few minutes while an image service recovers. Nothing will be charged." | lib/provider-preflight.ts |

## The model: two layers and one rule

1. **Your photos.** Each photo is removed or kept.
   - Removed is today: the product is cut out and placed on the chosen background color.
   - Kept is new: the stored photo ships as itself, only resized, color converted to sRGB when needed, or given flat added space to fit a channel's shape.
2. **Extra images.** Scenes, backdrops, the transparent PNG, graphics and cards. They are always made from a cut out copy of the product and never touch a kept photo. They default to on with Remove and to off with Keep, and each family can be switched on its own.

**The rule.** The background color is resolved per output spec at render time. A spec whose registry rule requires white always gets white, whatever the seller picked. `requiresWhiteBackground(spec)` in @curvi/specs reads this from the registry (rule 2): true for solid pure white, white_or_transparent and white_preferred.

**Kept photos never reach a white required spec.** Those specs get the same photo with its background removed and placed on white ("made white"), or the seller leaves the channel out.

**Resize only is not a separate mode.** It is Keep with every extra off.

## Controls at a glance

| Priority | Control | Default | Stored as |
| --- | --- | --- | --- |
| P0 | Look | Marketplace ready | `look` (derived by the server) and `lookBase` |
| P0 | Remove the background | On | `background: remove \| keep` |
| P0 | Background color | White | `color` |
| P0 | Channels that need white | Automatic, with Leave it out | Nothing: a server rule |
| P0 | Extra images (five families) | Follow the switch | `extras` |
| P0 | Photo shape (kept photos) | Keep my photo's shape | `fit: auto \| pad` |
| P0 | Already white photos stay as they are | On | Nothing: a server rule |
| P1 | Trim to the channel's shape | Off | `fit: crop` |
| P1 | Background per photo | Pack setting | `uploads[].background` |
| P1 | Number of scenes | 3 | `sceneCount` |
| P1 | Scene style | Auto | `scenePreset` |
| P1 | Logo on graphics | On | `logo` |
| P1 | Product size in the frame | Standard | `productSize` |
| P1 | Never enlarge my photo | Off | `enlarge` |
| P1 | Match my photo's edges | Not selected | `color: edge_match` |
| P1 | Graphics follow your color | Off | `graphicsColor` |
| P1 | Remember choices per product | Automatic prefill | `products.output_defaults` |

The P0 schema accepts only P0 fields and values. Each P1 field is added to the schema in the same pull request as its renderer and tests, so the server never stores a choice the runner cannot honor.

## P0 controls

### 1. Look

- **UI:** three cards in a radiogroup (`role=radiogroup`, each card `role=radio` with aria-checked, arrow keys move the choice). They stack on a phone and sit three across from sm up. Each card has a title and one line of copy.
  - Once any control differs from the chosen look, a quiet chip appears: "Custom, started from Keep my photo", with a "Reset" link. Custom is never a card of its own.
- **Default:** Marketplace ready. With P1 memory, the product's last choices prefill the form.
- **Server trust:** the client sends `lookBase` (the card it started from) for the chip and analytics. The server derives `look` with `lookOf(normalized)`: the preset key when the choices match a preset exactly, otherwise `custom`. The runner never branches on either.
- **Presets:** defined once, in `LOOK_PRESETS` in packages/pipeline/src/output-options.ts.

| Look | Background | Color | Extras | Card copy |
| --- | --- | --- | --- | --- |
| Marketplace ready | remove | White | all on | "Background removed and your product on clean white, with scenes and graphics. Made to each channel's rules." |
| Keep my photo | keep | White, used for added space | all off | "We keep your photo and only resize it. Channels that need a white background still get one." |
| Brand look | remove | Brand color 1 | all on | "Background removed, with your brand color behind your product and your logo on graphics." |

- **Brand look when unavailable:** the card is shown disabled.
  - No kit colors: "Add a brand color first." Links to /app/brand.
  - `tierEntitlements[tier].brandKits` is 0: "Brand kits come with the {plan} plan." Links to /app/billing. `{plan}` is the first tier whose brandKits is above 0 (Starter today), read from the seed, never a literal.

### 2. Remove the background (switch)

- **UI:** a new Switch in @curvi/ui: a button with role=switch and aria-checked, a 44 px target, toggled by Space, Enter and click. Label "Remove the background".
  - Helper when on: "We cut out your product and place it on the color you pick below."
  - Helper when off: "We keep your photo as it is and only resize it for each channel. Nothing in it is redrawn."
- **Default:** on. **Values:** `remove | keep`. A per photo override comes in P1.
- **With remove:** the pipeline runs as today, and the color applies per spec (control 3).
- **With keep:**
  - Each kept photo plans one `original_photo` shot, a new deterministic shot type.
  - White required specs still get a made white shot (control 4).
  - The extras switch to off.
  - The runner skips the LLM plan call and uses the deterministic planner.
  - No cutout is paid unless something needs one, and the paid judge is skipped on originals.
  - A pack that needs no cutout can run while the cutout provider is paused.
- **Price:** a kept photo costs one shot per pack, however many channels it serves (see Pricing).

### 3. Background color (dropdown)

- **UI:** a native @curvi/ui Select (the best picker on a phone). Beside it a 24 px swatch chip that always shows the color's name, so color is never conveyed by the swatch alone.
- **Options, in order:**
  1. The seeded colors (`backgroundSwatches`).
  2. "Your brand colors": "Brand color 1, #1F2A44" and so on, only when the workspace has a kit with colors and the plan includes brand kits.
  3. "Custom color": reveals `<input type="color">` next to a hex Input, validated with `/^#[0-9A-Fa-f]{6}$/`, error "Use a color code like #1F2A44." The last three custom colors are kept in localStorage, every access inside try/catch.
- **Label by mode:** "Background color" with Remove. With Keep it becomes "Color for added space", helper "Used only where a channel needs a set shape, like Meta and Pinterest.", and it appears only when some planned kept output gets added space.
- **Default:** White (seed key `white`).
- **Values (P0):** `{kind:"swatch", key}`, `{kind:"brand", index}` (0 to MAX_BRAND_COLORS minus 1), `{kind:"custom", hex}`. `edge_match` arrives in P1.
- **Snapshot:** createJob resolves the choice to a hex and stores it on the job, so a later kit edit never changes a retry. A brand choice from a plan without brand kits returns `upgrade_required`.
- **Where the color goes with Remove:**
  - amazon_main outputs on specs that do not require white (the Etsy and eBay lead image, and any spec attached by seller off cover).
  - alt_angle_white and collection_thumb.
  - The transparent cutout wherever a spec refuses transparency and it has to be flattened.
- **Where it does not go in P0:** sweep_gray stays studio gray, sweep_brand stays the brand color, template cards keep their preset colors (P1 "Graphics follow your color"), scenes are unchanged.
- **With Keep:** the color fills added space and nothing else.
- **Edges on colored backgrounds:** placeOnBackground blends semi transparent edge pixels toward the resolved color, never toward 255, so a dark background does not get a light fringe. Pixels inside the mask are never changed.
- **Dark swatches:** slate (#3A4556) and charcoal (#1B1F24) ship in P0 only if a golden set review of every seeded swatch and one dark custom color shows no fringe after the blend change. Otherwise they wait for P1, and a custom color below a seeded luminance gets the line "Dark colors can show a light edge around your product."
- **Not in the dropdown:** Transparent. It is the Transparent PNG extra, because transparency is valid only on some specs and feeds show transparent pixels as black.
- **Compliance notes:** specs that require white ignore the choice, with "This channel needs pure white, so this file uses white instead of your color." shopify.product is "consistent", so a non white choice adds the soft note "Shopify suggests one background style across your store."
- **Price:** none.

### 4. Channels that need white (automatic, with Leave it out)

Not a toggle, and the API has no value for it. The server always makes white required specs white, so no request can ask for a file that could never pass.

- **Section 2 chips** (from the registry through `ChannelOption.requiresWhite` and `exactSize`): "Stays white", or "Set shape, 1080 by 1920".
- **Heads up lines.** When the chosen look affects a white required channel, an amber line appears under that row and again in "Heads up for your channels" in section 3, each with a "Leave it out" text button that visibly unticks the channel.
  - amazon.main: "Amazon's main image must be pure white, so this one image has its background removed."
  - walmart.main: "Walmart takes white backgrounds only, so your Walmart images have the background removed." Button "Leave Walmart out".
  - google.merchant.main: "Google's main image must be white or transparent, so its background is removed."
  - tiktokshop.main: "TikTok Shop asks for a pure white main image, so your TikTok Shop images have the background removed." Button "Leave TikTok Shop out".
  - Any other spec where requiresWhiteBackground is true gets a generic line built from specDisplayName, so a new registry entry never ships without copy.
  - With Remove and a non white color, one line names the white required channels picked, built from `listSpecs().filter(requiresWhiteBackground)`: for example "Amazon main image, Walmart, Google main image and TikTok Shop stay pure white. Your color is used everywhere else."
- **Planner with Keep:**
  - The white front shot (amazon_main, or the priority 1 alt_angle_white when amazon.main is not picked) is planned from the front photo and narrowed to the picked white required specs. It renders exactly as today, with isolation and extraItemsFailure.
  - For the other photos, alt_angle_white is narrowed to the picked white required gallery specs: `GALLERY_SLOTS` entries whose spec requires white (walmart.main and tiktokshop.main today), never a literal list.
  - No walmart.secondary or tiktokshop.secondary specs (founder decision 3): every Walmart and TikTok Shop file is white.
- **Price:** each made white shot is its own shot at creditCosts.deterministic, with its own estimate line "Made white for channels that require it".

### 5. Extra images

- **UI:** an "Extra images" group with five native checkbox rows. Each shows its typical cost, formatted from creditCosts (rule 2), for example:
  - "Lifestyle scenes made around your real product. About {generativeStill} credit each."
  - "Studio backdrops in gray and your brand color. {deterministic} credits each."
  - "Transparent PNG of your product. {deterministic} credits."
  - "Graphics with your benefits, sizes, box contents and comparisons. {deterministic} credits each."
  - "Social posts and banners. {deterministic} credits each."
  - With Keep, the group adds: "These are made from a cut out copy of your product. Your own photos stay as they are."
- **Default:** follows the switch: all on with Remove, all off with Keep. Flipping the switch resets them to that side's default; the seller can change them afterwards.

| Family | Shot types |
| --- | --- |
| scenes | lifestyle, shopify_hero |
| backdrops | sweep_gray, sweep_brand |
| transparentPng | cutout_png |
| graphics | infographic, dimensions, in_the_box, comparison |
| cards | social_1x1, social_4x5, social_9x16, social_2x3, aplus_banner |

- **Never switchable:** amazon_main, alt_angle_white, collection_thumb, original_photo.
- **Turning a family off:**
  - Its shots are skipped with `SELLER_OFF_REASON` "turned off by the seller". They hold no channel slot and no credit, their cards are hidden, and the Your choices card lists them.
  - The deterministic planner skips the family.
  - The LLM path treats a disabled family like `excludeMethods`: validateLlmShotList moves those shots to skipped with SELLER_OFF_REASON before the id, limit, coverage and budget checks, so a plan that follows the recipe is filtered, not rejected. fitShotsToChannels applies the same `excludeTypes` filter to both plans. Only `original_photo` is a hard reject.
- **Seller off cover:** a new pure step, `coverSellerOffSpecs`, in packages/pipeline/src/planner, called at the end of planShots and inside fitShotsToChannels (next to the Google main fill), so the estimate, the fallback and the fitted LLM plan all run the same code.
  - It covers only a picked spec whose every candidate shot was removed with SELLER_OFF_REASON. A spec empty for any other reason (no usable front photo, "needs photo") stays empty, so a pack with no options is unchanged.
  - It never covers a white required spec, and never runs with Remove when frontUsable is false.
  - It first attaches the spec to the existing front shot whose image the spec accepts (amazon_main, the priority 1 alt_angle_white, or the front original_photo) at no extra cost. Only when none exists does it add a front alt_angle_white on the chosen color at creditCosts.deterministic.
  - placeOnBackground honors `spec.safeZone`, so meta.story_9x16 keeps the product inside the safe zone.
- **scenes_paused:** the scenes row is forced off and disabled with SCENES_PAUSED_COPY, and nothing is held for scenes. This completes PHASE_14 item 1.5.

### 6. Photo shape (kept photos)

- **UI:** a radio group inside "More options", shown when any photo is kept.
  - "Keep my photo's shape where the channel allows it" (`auto`, default).
  - "Match each channel's shape and add space" (`pad`).
- **auto:** a spec without exactSize keeps the photo's aspect ratio (amazon.secondary, shopify.product, etsy.listing, ebay.listing, google.merchant.lifestyle). Exact size specs get added space.
- **pad:** the whole photo fits inside `canvasSizeFor(spec)` and the rest is filled with the resolved color. On meta.story_9x16 the photo fits inside the safe zone. Pad never fails for size. On specs with the new registry flag `bordersAllowed: false` (ebay.listing, tiktokshop.main) pad falls back to auto, with "eBay does not allow added borders, so eBay images keep your photo's shape."
- **Scale (both fits, per spec):** `s = min(maxW / w, maxH / h, sqrt(maxMP / (w * h)))` with the maximums from dimensionBounds, `maxMP` the smaller of spec.maxMegapixels and seed `originalFit.maxMegapixels` (16), and never above 1 unless a minimum needs it. When the result misses minLongSideFor(spec), spec.minWidth or spec.minHeight, s rises to meet all three, but never above the enlarge cap (MAX_SOURCE_UPSCALE, 1.5). When s is 1 nothing is resampled.
- **Too small:** a kept photo that cannot reach a non exact spec within the cap is left out of that spec at plan time with `SOURCE_TOO_SMALL_REASON` "source too small for this channel". Kept photos never block the form for size (see UI).
- **Price:** none.

### 7. Already white photos stay as they are

Founder decision 8 moved this from P1 into P0, so studio photos on white keep their own pixels on Amazon main and every other white required spec from day one.

- **When it applies:** a kept photo feeding a white required spec, whose pixels outside the cached preflight mask (dilated by QC_EDGE_MARGIN_PX) already pass the main class white background check, and where crop and white pad alone reach spec.fill.
- **What it does:** the white required file is made by crop, resize and white pad only, with no composite and no cutout pixels, through the same original.ts pipeline and the same rule 3 proof as original_photo (placed rectangle mask, fidelityKind "main").
- **Otherwise:** the made white path runs as in control 4. The main class checks still gate every file either way.
- **Needs:** the preflight cutout mask from the upload cache (founder decision 5 keeps that cutout paid at upload), read cache first; a cache miss falls back to the made white path, never to a new provider call just for detection.
- **Copy and notes:** note `original: already white`; copy "Your photo already had a pure white background, so we only resized it."
- **Price:** the same as a made white file, one shot at creditCosts.deterministic. The estimate cannot know in advance which path runs, and both cost the same.

## P1 (fast follow, same phase)

| Control | Default | What it does | Why |
| --- | --- | --- | --- |
| Trim to the channel's shape (`fit: crop`) | Off | The largest window of the target aspect that contains the product box plus seed `originalFit.cropMarginShare` (0.05). The box comes from `source_media.target_box`, then a `productBox` the preflight adds to `upload_preflights.result` (jsonb, no migration). meta.story_9x16 also needs the box inside the safe zone. No box, or a box that does not fit, falls back to pad with a note. Copy: "We never trim your product." | Sellers dislike bars on social posts. Safe only because the box is known. |
| Background per photo | Pack setting | "Pack setting / Remove / Keep as is" next to the angle Select, sent as `uploads[].background` and resolved to `keepMediaIds`. A kept front photo still feeds a white amazon_main when amazon.main is picked. | A clean studio front and a messy back need different treatment. |
| Number of scenes | 3 | A Select, "Off, 1, 2, 3, 4". Bounds move to seed `sceneCountOptions`; `lifestyleScenesFor(profile, n)` plans exactly n scenes for every category, filling category required scenes first; the lifestyle gallery reservation (RESERVED_GALLERY_SLOTS) becomes n. The default is 3, the midpoint of today's 2 to 4 (founder decision 4), so once this lands a default pack holds and plans 3 scenes: the reference product goes from 11 shots, 6.5 charged, hold 7 to 12 shots, 7.5 charged, hold 8, and one more plate and harmonize call. | Fixes today's hold drift (the reference product holds 2 scenes while jewelry plans 4). Scenes are the largest cost lever. |
| Scene style | Auto | "Auto, picked for your product", Minimal studio, Marble, Kitchen, Outdoor, Holiday. Overrides brand.stylePreset per pack in applyBrandStylePreset. Reflective or transparent products still force minimal_studio. | One tap look for scenes with no prompt writing; presets are seeded. |
| Logo on graphics | On | Shown only when the kit has a logo. Off makes logoFor return null. | Some sellers want clean graphics. |
| Product size in the frame | Standard | Standard, Larger, Smaller from seed `canvasDefaults.productSizeFill` {standard 0.875, larger 0.93, smaller 0.75}, clamped to spec.fill and maxAxisShare. Remove only; amazon.main stays between 0.85 and 0.9. | Catalog uniformity; tall thin products look small today. |
| Never enlarge my photo | Off | The enlarge cap drops from 1.5 to 1.0 for kept photos. | Literal source resolution and nothing more. |
| Match my photo's edges | Not selected | A color choice with Keep: the median color of the photo's outer ring (seed `originalFit.edgeRingPx` 2), applied as one flat color, never a blur or an extension. | Added space that blends in. |
| Remember choices per product | Automatic prefill | Each pack that carried outputOptions saves the choice (not the resolved hex) to `products.output_defaults`. pickProduct prefills it with "Using your last choices for {title}." and a "Start from Marketplace ready" link. It is a client prefill only: a request without options always means Marketplace ready, so automatic flows never inherit Keep. Fresh drops (trigger/src/drops.ts) skip scene variants for a product whose remembered choices turn scenes off. | Set a product once, like SKU and box contents. |
| Cutout preview | Shown | The preflight writes a 640 px alpha PNG from the cutout it already made to `ws/{id}/cache/preview/...` in R2 (same retention as the cutout cache, served through a signed URL, never bytes in jsonb). The preview strip shows the real product on the chosen color. | See the result before any credits are held. |
| Graphics follow your color | Off | Template cards use the chosen color instead of presetBackgroundHex. Text flips to seed `stillStyle.textOnDarkHex` below seed `darkBackgroundLuminance`. | Brand look reaches the graphics. |
| "Background matches your color" check | On | CIEDE2000 at most `QC_THRESHOLDS.backdropMaxDeltaE` 2.0 between measured and requested background on colored outputs. | The report can prove the color. |
| Added text on kept photos | On | A new intake_normalizer version adds a per image `addedOverlays` flag (recipe row, pnpm eval, re-seed). A flagged kept photo is left out of specs with textAllowed or overlaysAllowed false, with a heads up. | eBay and Google refuse added text, borders and watermarks. |
| "Keep my background" hint | On | A seeded phrase list (`keepBackgroundPhrases`) matched against the note in the form. When it matches and the switch is on: "It sounds like you want to keep your background. Turn off Remove the background?" | Today that note is parsed and ignored. |
| Free resizer alignment | | The marketing resizer uses `@curvi/pipeline/output-options` (specAcceptsImage with `original`, originalFitFor) and drops white required specs, with "Amazon's main image needs the background removed. Make a pack to get one." | The free tool pads photos with white for amazon.main, which does not meet Amazon's rule. |

## Backlog for PHASE_16 (not in this phase's done criteria)

| Candidate | What it does | Why later |
| --- | --- | --- |
| Soft shadow on colored backgrounds | A contact shadow from seed `stillStyle.backdropShadow` (moving makeSweep's literals), never on white required specs. | A taste option; backgroundWhiteShare risk needs its own tests. |
| File format | "Best for each channel / Match my photo / JPEG / PNG", filtered by spec.formats. | The ladder already picks well. |
| File names start with | A slug of 1 to 60 characters that overrides seoSlug. Amazon keeps {sku}.MAIN and {sku}.PTnn. | Independent of backgrounds. |
| Image order in the listing | The seller orders the gallery (PT01 to PT08 on Amazon). | Needs a sortable UI and packager naming work. |
| Rotate a photo by 90 degrees | Per photo, before any other step. | Geometry only, but touches ingest and preflight. |
| Largest size each channel allows | Render at spec maximums instead of canvasDefaults. | Memory and byte caps need their own tests. |
| Smaller files for my website | Seed `outputSizeTargets.web_small` 1 MB, never above the spec cap, never at a fidelity cost. | Encoder work. |
| Keep my photo's color profile | Embed the source ICC on original_photo outputs, never on amazon.main (the registry says sRGB). | Marketplaces expect sRGB. iPhone photos carry Display P3, so this matters more than it looks. |
| Use my existing transparent PNG | A real alpha channel found at preflight becomes the mask; the fal BiRefNet call is skipped. | A cost win; touches preflight and inventory. |
| Include my original photo in the download | The stored upload in the zip under originals/. | Storage cost only. |
| Alt text | From the ProductProfile through a recipe row, capped per channel, editable, shipped as a CSV sidecar. | Needs a recipe and eval. |
| Default look for new products | A workspace default kept with the brand kit (a migration). | Per product memory covers most of it. |
| Position | Centered or resting low, from seeded shares. | Cosmetic. |
| Photo cards on graphics with Keep | Graphics show the kept photo as an opaque card with a full rectangle mask; dimensions stays off. | Additive. |
| Custom size | A "Custom size" pseudo channel with seeded bounds and no marketplace claim. | Needs naming and QC rules. |
| Skip analyze for Resize only packs | Moderation relies on the intake flags; frontUsable and angles come from seller roles. | Gated on pnpm eval and a moderation test. |
| Automated accessibility check | @axe-core/playwright on section 3. | A new dev dependency; wait for home/liquid-metal to land. |

## Not in this phase, and why

| Option | Why it is out |
| --- | --- |
| AI upscaling of small photos | It invents detail inside the product (text, logos, texture), which breaks rule 3. Deterministic resampling up to 1.5 times plus the size gate stays the answer. |
| Retouch: relight, beautify, wrinkle ironing, compression cleanup, "polish" | Each changes product pixels. Never allowed in Listing Mode or on kept photos. |
| Text or watermark removal | It regenerates pixels, erases real product labels, and could be misused on third party watermarks. |
| AI extend or outpaint of a kept photo | It invents background pixels, which breaks the Keep promise. Flat added space covers the need. |
| Blur or a new background behind a kept photo | It edits the photo the seller asked us to keep. Blur on a cutout could return later under Remove. |
| Perspective correction | A geometric warp of product pixels. |
| Watermarks, borders, outlines or logo overlays on marketplace images | Amazon, eBay and Google prohibit them. The social only badge stays as today. |
| People or hands in scenes | The plate prompt keeps "no people". If that changes, the Amazon synthetic performer tag becomes mandatory (verify under rule 7 first). |
| Custom scene prompts, own backgrounds, style references | A new generative and moderation surface. A separate phase. |
| Face anonymizing crop, CMYK for print | Niche; needs a vision step. |
| Transparent as a color choice | Stays the Transparent PNG extra. |

## Per channel behavior

`specAcceptsImage(spec, "original")` is true only when requiresWhiteBackground(spec) is false and the background rule is undefined, any or consistent. fitShotsToChannels applies the same test.

| Spec | Registry rule | Remove, any color | Keep, photo shape auto |
| --- | --- | --- | --- |
| amazon.main | solid 255 white, tolerance 0, fill 0.85 to 0.9, no text | Always pure white | Made white for this one file, or Leave it out |
| walmart.main | solid white, main class checks; Walmart's only spec | Always white | Made white on every Walmart file, or leave Walmart out |
| google.merchant.main | white or transparent, fill 0.75 to 0.9, no overlays | Always white | Made white for this file, or Leave it out |
| tiktokshop.main | white preferred, pure white main by policy, no added borders; one spec for all 9 images | Always white | Made white on every TikTok Shop file, or leave TikTok Shop out |
| amazon.secondary | any; up to 2000; long side at least 1600 | Your color | Own shape, long side up to 2000. A photo under 1067 px on its long side (1600 divided by MAX_SOURCE_UPSCALE) is left out. |
| shopify.product | consistent; up to 5000 and 25 MP | Your color, with the soft consistency note | Own shape up to 16 MP; often the stored file unchanged |
| etsy.listing | none; up to 2000 | Your color | Own shape, long side up to 2000 |
| ebay.listing | none; up to 1600, long side at least 500; no added borders, text or watermarks | Your color | Own shape; never added space, even with pad; added text heads up |
| google.merchant.lifestyle | none; at least 500 by 500; no text; no maximum today | Your color on angle images | Own shape up to 16 MP, and within Google's limits once verified; added text heads up |
| meta.feed_1x1, meta.feed_4x5 | exact 1080 by 1080, 1080 by 1350 | Social cards, or the front image on your color when cards are off | Front photo with added space in your color |
| meta.story_9x16 | exact 1080 by 1920; safe zone 250 top, 340 bottom | Same as the feeds, product inside the safe zone | Front photo with added space, inside the safe zone |
| pinterest.pin | exact 1000 by 1500 | Same as the feeds | Front photo with added space |
| amazon.aplus.basic_header | exact 970 by 600; 2 MB | Banner cards, or the front image on your color | Front photo with added space; the ladder fits 2 MB or the file goes to review |
| shopify.hero_banner | exact 2400 by 1000; JPEG only | Scene composite, or the front image on your color when scenes are off | Front photo with added space, JPEG |
| amazon.aplus.premium_full | exact 1464 by 600 | Coming soon, not in this phase | Coming soon, not in this phase |

**Defense in depth: `backgroundWhiteOrClear`.** A new pixel check on white_or_transparent and white_preferred specs.
- Outside the mask dilated by edgeMarginPx, the share of pixels that are exactly 255 white or alpha 0 must be at least `QC_THRESHOLDS.whiteOrClearShare` 0.999. It fails closed without a mask.
- describeCheck labels it "White or transparent background", or "White background" for TikTok Shop.
- encodeForSpec gets the same escape to PNG for these specs that solid white specs have today, so JPEG ringing near an edge cannot fail today's white files. Enable the check only after a golden set run passes.
- A new `megapixels` pixel check runs when spec.maxMegapixels is set (only fitsSpecSize checks it today).

## Fidelity guarantee for kept photos

**What "nothing redrawn" means:** no pixel is generated, retouched or cut out. The only changes are geometry, a color managed conversion to sRGB, flat added space and encoding. Byte identity is promised only for the unchanged file, and it is measured against the stored copy.

**The baseline is the stored copy.** Ingest strips metadata byte for byte for most photos, but writes a rotated photo again (JPEG q95 4:4:4) and turns GIF and TIFF into PNG.
- ImageIngestResult gains `reencoded`, and the upload path stores `source_media.ingest` = `{ v: 1, reencoded, sourceFormat }` (migration below).
- The payload carries `reencoded` per photo, so the note can say which case each file is. A null ingest record (older uploads) reads as unknown.

**Allowed operations, in order,** in one sharp pipeline reading the stored upload (packages/pipeline/src/deterministic/original.ts):
1. Crop (P1 crop fit only). The window always holds the product box plus the seeded margin.
2. Resize with PRODUCT_RESIZE_KERNEL (lanczos3), one pass, `fastShrinkOnLoad: false`. No sharpen, modulate or gamma.
3. Conversion to sRGB when the photo is not sRGB: a non sRGB ICC profile (Display P3 from most iPhones), CMYK or YCCK, or 16 bit depth (brought to 8 bit).
4. Flatten, only for a photo with a real alpha channel: transparent areas are filled with the resolved color.
5. Added space in one flat color. Never a blur, stretch, mirror or generated fill.
6. Encode through the existing encodeForSpec ladder (JPEG 90, climbing to 95, 98, 100, then PNG) with the new `fidelityKind: "main"` override, and `preferPng` for PNG and lossless WebP sources. A JPEG that cannot pass the strict row falls to PNG; a file that fits no format and byte cap goes to needs review instead of stepping below the fidelity floor.

**The unchanged file (passthrough).** The stored bytes ship as they are only when all of these hold:
- s is 1, with no crop, no added space and no flatten.
- The format is in spec.formats and the bytes are within spec.maxBytes.
- `w * h` is at most `originalFit.maxMegapixels` and spec.maxMegapixels.
- sharp metadata says space srgb, depth uchar, no CMYK, and either no alpha channel or an alpha that stats show is fully opaque.
- The ICC profile is absent, or its description is in seed `originalFit.srgbProfileNames`.

The runner proves it: the delivered sha256 must equal the stored sha256, and a mismatch fails the output as a fidelity failure. That proof replaces the RGBA fidelity decode, and the pixel checks for these files read the header only (dimensions, megapixels, format, bytes).

**The rule 3 proof on every rendered kept output:**
- The mask is the placed photo rectangle, or the alpha channel for a photo with real alpha.
- productReference comes from a new `buildProductReferenceFromEncoded(sourceBytes, placement, canvas)` in whiten.ts: its own sharp pipeline from the encoded bytes (the same ICC to sRGB transform, extract, resize with the kernel and fastShrinkOnLoad false, alpha replace when present). It shares no code with original.ts, and never decodes the full source frame into JS memory.
- fidelityRequired is true, the erosion comes from stillQcErosion, and `ShotGeneration.fidelityKind` is "main", so checkGeneration uses the strict row (mean CIEDE2000 at most 3.0, any pixel at most 10) whatever the spec.
- Mutation tests show the gate catches drift.

**Color conversion claims.** The reference goes through the same ICC transform, so fidelity isolates geometry and codec loss. A separate test checks the conversion itself against sharp's own output. sharp's defaults (conversion to sRGB for an embedded profile, ICC stripped unless kept, the rendering intent) are recorded with a date in docs/verification.md (rule 7).

**Memory (512 MB workers, Phases 12 and 13).**
- Every kept output, passthrough included, is capped at `originalFit.maxMegapixels` 16. Larger photos take the rendered path.
- Peak budget per rendered output at the cap: rendered RGBA 64 MB, reference 64 MB, shipped decode 64 MB, mask 16 MB, plus libvips buffers. original_photo outputs run one at a time per process (a shot concurrency class in shot-concurrency.ts), and the loaded source is cached as encoded bytes per job and media id, never as RGBA.
- A test on an 80 MP fixture asserts peak RSS stays under a seeded limit. If it fails, maxMegapixels drops to 12.

**Several products in one photo.** A kept photo keeps everything in its frame; Phase 13 isolation cannot apply, and extraItemsFailure cannot see neighbors inside a rectangle mask.
- A photo whose only planned shots are original_photo needs no product target (see `cutoutMediaIds`). The form shows "This photo shows other items. With the background kept, they stay in your images. Turn on Remove the background to show only your product." instead of "Tap the product this pack is for."
- The runner drops such photos from `selection.ambiguous`, so MULTIPLE_PRODUCTS_MESSAGE only fires for a photo that feeds a cutout shot (for example a kept front photo that feeds amazon_main).
- The report adds "Other items in this photo stay in the picture because you kept the background."

**The badge (free tier, social specs only).** Kept photos never carry the free tier badge (founder decision 6): the packager skips applyBadge for original_photo assets and for already white files, with no note. Made white files, scenes and every other output keep today's badge rule. Passthrough therefore never waits on a badge.

**Privacy.** Stored uploads carry no EXIF or GPS. A test asserts no delivered file carries a GPS tag.

**Copy rule.** Rendered originals say "Nothing in your photo was redrawn." Only passthrough files say the file is as uploaded. No UI copy says "identical" or "100 percent".

## Pricing, holds and cost

**Price: a kept photo is one deterministic shot, creditCosts.deterministic (0.5), per pack, however many channels it serves.** Founder decision 1, decided 2026-09-29.
- CURVI_BUILD_PLAN.md 9.1 already prices a resize at 0.5 credit, and the seed comment on creditCosts.deterministic says "White main, cutout, resize or sweep". original_photo has method deterministic, so creditsForShot needs no new branch.
- Every price stays a multiple of 0.5, which binary floats hold exactly. A seed test asserts this for every creditCosts value.

**Unchanged:** a made white file is its own shot, the background color is free, scenes stay at creditCosts.generativeStill (1), and a shot is charged once when any of its outputs passes.

**Fixtures** (become pack-estimate.test.ts cases): default channels (amazon.main, amazon.secondary, shopify.product, meta.feed_1x1), the reference product (front, 45, back) with 3 photos, price 0.5.

| Pack | Shots | Charged if all pass | Hold | Provider calls in the runner |
| --- | --- | --- | --- | --- |
| Marketplace ready (today) | 11 | 6.5 | 7 | intake (unless reused), analyze, plan, cutouts (cached from upload), plates and harmonize for 2 scenes, a judge call per output |
| Marketplace ready, scenes off | 9 | 4.5 | 5 | The same with no image model calls |
| Keep my photo (Amazon main made white) | 4 | 2.0 | 2 | intake (unless reused), analyze, one judge call; front cutout read from the upload cache; no plan call |
| Keep my photo, Amazon main left out | 3 | 1.5 | 2 | intake (unless reused) and analyze only |
| Keep my photo plus 2 scenes | 6 | 4.0 | 4 | As Keep, plus plates, harmonize and judge calls for 2 scenes |
| Keep my photo for Amazon main, Walmart, TikTok Shop, Google main, Etsy and eBay | 6 | 3.0 | 3 | intake, analyze, judge calls on the made white files |

**The hold follows the options.**
- EstimateSellerInputs gains `output` (OutputPlanFlags) and `photos` (count, roles and sizes when known).
- referencePackShots creates synthetic ids `reference_photo_1..n`, the front equal to primaryMediaId, so kept photos are planned from the real photo count.
- The form's count is its uploads, or the product's stored photo count when it has none (ProductOption gains `storedPhotoCount` from listProducts), capped at MAX_PACK_PHOTOS.
- The same inputs reach estimatePackCredits in the form (new-pack-form.tsx near line 267), createJob (db.ts near line 1369) and planDemoShots.
- createJob passes source_media widths and heights, so size skips are known and the hold is exact. The form treats a photo of unknown size as fitting, so its figure is an upper bound.

**Cost of goods:**
- A cutout costs $0.01 on fal BiRefNet, paid once per photo at the upload preflight whatever the seller picks, and cached for 24 hours.
- With Keep and nothing that needs a cutout, takeInventory reads that cache only and never calls a provider.
- original_photo makes no provider call. The paid judge is skipped for it (seed `qcJudgePolicy.exemptShotTypes`), and the pixel checks and fidelity decide.
- Keep packs skip the plan call. analyze still runs on every pack (moderation and the profile need it); skipping it for Resize only packs is in the backlog.
- A credit is worth $0.10 (Agency) to $0.145 (Starter), so a kept photo earns $0.05 to $0.07.

**Summary copy:**
- "We hold 2 credits and give back what is not used."
- "Keep my photo uses 5 fewer credits than Marketplace ready for this pack." Shown only when the difference is positive.
- A "Resize only" badge when Keep is on and every extra is off.

## Data model

### Shared options module

`packages/pipeline/src/output-options.ts`, exported as `@curvi/pipeline/output-options`. Pure, no sharp, safe on the client. The form, API, services, demo, runner, marketing resizer and tests share it.

```ts
const HEX = /^#[0-9A-Fa-f]{6}$/;

ColorChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("swatch"), key: z.enum(SWATCH_KEYS) }).strict(),   // seed backgroundSwatches
  z.object({ kind: z.literal("brand"), index: z.number().int().min(0).max(MAX_BRAND_COLORS - 1) }).strict(),
  z.object({ kind: z.literal("custom"), hex: z.string().regex(HEX) }).strict(),
]);

OutputOptionsInput = z.object({
  v: z.literal(1).default(1),
  lookBase: z.enum(["marketplace", "keep_photo", "brand"]).optional(),
  background: z.enum(["remove", "keep"]).default("remove"),
  color: ColorChoice.default({ kind: "swatch", key: "white" }),
  fit: z.enum(["auto", "pad"]).default("auto"),
  extras: z.object({ scenes, backdrops, transparentPng, graphics, cards: z.boolean() }).partial().strict().default({}),
}).strict();
// P1 fields (crop, edge_match, sceneCount, scenePreset, logo, productSize, enlarge, graphicsColor)
// join the schema only in the pull request that renders them.
```

- MAX_BRAND_COLORS moves from apps/web/src/lib/validation/brand-kit.ts to packages/pipeline/src/seed/brand.ts and is re-exported there.
- **Normalization.** `normalizeOutputOptions(input)` fills missing extras from the background (all true for remove, all false for keep). An absent options object normalizes to today's pack exactly.
- **ResolvedOutputOptions** is the normalized input plus, all JSON safe (it crosses the generate-shot subtask boundary inside ShotContext):
  - `look`: derived by the server with lookOf.
  - `colorHex: string`: resolved at createJob from the seed, the brand kit or the custom value.
  - `brandSweepHex: string`: a snapshot of the sweep_brand color.
  - `keepMediaIds: string[]`: R2 keys of the kept photos, each checked with isWorkspaceSourceKey. No uuid mapping.
- **OutputPlanFlags** = `{ background, keepMediaIds, extras, fit, photos: [{ id, angle?, width?, height? }] }`. Booleans, enums, R2 keys and pixel sizes only. It never reaches the LLM: the runner builds the plan recipe input as `const { output, ...llmOptions } = planOptions`, and a test asserts the recipe input has no `output` key. Passing flags to the plan recipe is a backlog idea gated on pnpm eval.
- **Helpers:**
  - `DEFAULT_OUTPUT_OPTIONS`, `LOOK_PRESETS`, `lookOf(normalized)`.
  - `outputOptionsKey(input)`: canonical JSON of the normalized input with sorted keys, excluding lookBase and every resolved field. Used for idempotency.
  - `planFlagsOf(resolved, photos)`.
  - `cutoutMediaIds(photos, specIds, flags)`: the photos that feed a cutout shot. Every removed photo; the front photo (angle front, else the first) when any extra is on or any picked spec requires white; the in the box photo when graphics are on; any other kept photo when a picked white required gallery spec exists.
  - `packNeedsCutout(specIds, flags)`: `cutoutMediaIds(...)` is not empty.
  - `backgroundFor(spec, resolved)` returns `{ rgb, forcedWhite }`.
  - `originalFitFor(spec, resolved)` and `originalScale(photo, spec, resolved)` returning `{ scale, skip? }`.
  - `conflictsFor(specIds, resolved, photos)` returns codes only: white_required, borders_refused, overlays_refused, mixed_consistent, other_items, too_small.
- Copy for those codes lives in apps/web/src/lib/output-options-copy.ts (rule 9).

### Seed and registry (rule 2)

**packages/pipeline/src/seed/templates.ts:**
- `backgroundSwatches`: white #FFFFFF, light_gray #F4F4F5, studio_gray #D9DADC, warm_white #F3F1ED, sand #EADFCF, sage #DDE4D8, slate #3A4556, charcoal #1B1F24. Every value except white reuses a seeded hex. Slate and charcoal follow the dark swatch gate in control 3.
- `stillStyle.whiteHex` #FFFFFF replaces the four white literals (whiten.ts 207, 224 to 226, 397, 536) and raw.ts encodeJpeg. White required specs still take white from `spec.background.rgb`. `spec.width ?? 2000` becomes `canvasDefaults.width`.
- `originalFit`: `{ maxMegapixels: 16, srgbProfileNames: [...] }` in P0; `cropMarginShare` 0.05 and `edgeRingPx` 2 in P1. No JPEG start quality: originals use the encodeForSpec ladder.
- P1: `canvasDefaults.productSizeFill`, `sceneCountOptions` {min 1, max 4, default 3}, `lifestyleFallbackScenes` (moved from planner literals), `stillStyle.textOnDarkHex` and `darkBackgroundLuminance`, `keepBackgroundPhrases`.

**packages/pipeline/src/seed/recipes.ts:** `qcJudgePolicy = { exemptShotTypes: ["original_photo"] }`, next to the qc_judge recipe (seed/credits.ts has no QC policy today).

**packages/pipeline/src/qc/pixelChecks.ts QC_THRESHOLDS:** `whiteOrClearShare` 0.999. P1 adds `backdropMaxDeltaE` 2.0.

**packages/specs:**
- ChannelSpec gains optional `bordersAllowed`. registry.json sets it false on ebay.listing and tiktokshop.main, and `overlaysAllowed: false` on ebay.listing and google.merchant.lifestyle, after a rule 7 recheck of docs/verification.md rows 224 and 225 and Google's image policy.
- After verifying Google's image limits, add maxMegapixels and maxBytes to google.merchant.main and google.merchant.lifestyle.
- New helpers: `requiresWhiteBackground`, `isExactSize` (reads the existing exactSize), `allowsAddedBorders`, `refusesOverlays` (textAllowed or overlaysAllowed false).
- Bump the registry version, run the seed again so channel_specs rows carry the new fields (staging, then production), and update seed.test.

**Platform setting:** a kill switch row `output_options_enabled` in platform_settings, seeded by pnpm db:seed from the seed (no migration).

### Database (migration 0023, the next free number)

`packages/db/migrations/0023_output_options.sql`:

```sql
ALTER TABLE generation_jobs ADD COLUMN output_options jsonb;
ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_output_options_object
  CHECK (output_options IS NULL OR jsonb_typeof(output_options) = 'object');
ALTER TABLE products ADD COLUMN output_defaults jsonb;
ALTER TABLE products ADD CONSTRAINT products_output_defaults_object
  CHECK (output_defaults IS NULL OR jsonb_typeof(output_defaults) = 'object');
ALTER TABLE source_media ADD COLUMN ingest jsonb;
ALTER TABLE source_media ADD CONSTRAINT source_media_ingest_object
  CHECK (ingest IS NULL OR jsonb_typeof(ingest) = 'object');
```

- All three are existing tenant tables with workspace_id and RLS, so no policy changes (the 0020 and 0021 pattern). Rule 5 still gets a test.
- Drizzle: `outputOptions: jsonb("output_options").$type<ResolvedOutputOptions | null>()`, `outputDefaults: jsonb("output_defaults").$type<OutputOptionsInput | null>()`, `ingest: jsonb("ingest").$type<SourceMediaIngest | null>()`. `pnpm db:generate` keeps the meta snapshot.
- NULL output_options reads as the defaults, so every older pack reads as Marketplace ready. products stores the choice, never the resolved hex. P0 adds the column but writes it only from P1.

### API and service types

- **JobRequest** gains `outputOptions: OutputOptionsInput.optional()` (strict: an unknown key, a bad hex or an out of range index is a 400). P1 adds `uploads[].background`. Both add well under 1 KB against JOB_BODY_MAX_BYTES 64_000.
- **CreateJobResult** gains `invalid_options` (400): "That brand color is no longer in your brand kit. Pick another color." A brand choice on a plan without brand kits is `upgrade_required` (402). Non default options while OUTPUT_OPTIONS_AVAILABLE is off or the kill switch row is false are `feature_unavailable` (422), the same way concept mode is refused.
- **CreateJobInput** gains `outputOptions?`. **JobView** gains `outputOptions?: { look, lines: string[] }` from `outputOptionsSummary` in job-copy.ts. **ProductOption** gains `storedPhotoCount` (and `outputDefaults` in P1).
- **NewPackForm props** gain `brandKit: { colors, hasLogo, stylePreset } | null`, `brandKitAllowed` and `outputOptionsEnabled`, loaded by new/page.tsx through services.getBrandKit, tierEntitlements and the kill switch.
- **ChannelOption** (declared in new-pack-form.tsx, built in apps/web/src/app/app/new/channel-options.ts) gains `requiresWhite`, `exactSize: { width, height } | null`, `bordersAllowed` and `refusesOverlays`, all read from the registry.

### Worker payload

- PayloadMedia and `GeneratePackInput.images[]` gain `width`, `height` (from the ingest check or source_media) and `reencoded`.
- GeneratePackInput, PackFollowUpInput, ShotContext and ShotGenerateArgs gain `output?: ResolvedOutputOptions`. P1 adds `ShotContext.productBoxes` for crop.
- **The runner fails closed.** A missing `output` means the defaults. An `output` that fails the shared schema, or names an unknown `v`, fails the job at the start of runGeneratePack, before any provider call or charge, with "This pack's image choices could not be read, so nothing was charged. Please try again." The failure path releases the hold.

## Pipeline and planner changes

**packages/pipeline**

1. **schemas.ts.** Shot.type gains `original_photo` (shot_type is a text column). New `LlmShot` and `LlmShotList` leave it out; the plan recipe's strict tool schema and validateLlmShotList use them, so the LLM tool schema is unchanged and the LLM can never emit it. Note the change in CURVI_BUILD_PLAN.md 5.2, which schemas.ts copies verbatim.
2. **output-options.ts (new).** As above.
3. **planner/deterministic.ts.**
   - PlannedImageKind gains `original`; PlanOptions gains `output?: OutputPlanFlags`.
   - Each kept photo plans one original_photo, method deterministic, stylePreset none, credits from creditCosts.deterministic. The front photo is priority 1 and targets every picked spec that accepts `original`; other kept photos are priority 2 and target the gallery specs only. Originals are planned whatever `imageQuality.usableForMain` says: they are the seller's own photo.
   - For kept photos: the white front shot narrows to the white required specs, alt_angle_white narrows to white required gallery specs, and collection_thumb is not planned (the front original covers shopify.product).
   - Extras that are off are skipped with SELLER_OFF_REASON before capShotsPerChannel.
   - When any photo is kept, capShotsPerChannel gets a reservation `{ type: "original_photo", count: kept photos }` ahead of RESERVED_GALLERY_SLOTS, so the seller's own photos keep amazon.secondary before generated extras.
   - New pure exports, called from planShots and from fitShotsToChannels: `applyOriginalSizes(shots, flags, skipped)` (runs before orphan cover, the channel cap and the trim, and records `original_photo:{specId}` with SOURCE_TOO_SMALL_REASON) and `coverSellerOffSpecs(shots, skipped, flags)`.
   - None of the new reason strings contains a keyword skippedCopy already matches (needs photo, plan tier, credit budget, benefits, dimensions, contents, comparison).
4. **planner/brand.ts (P1).** applyBrandStylePreset honors `scenePreset` when not auto.
5. **deterministic/original.ts (new).** `makeOriginalFit(sourceBytes, spec, { fit, padRgb, maxUpscale, maxMegapixels, productBox? })` returns `{ raw, mask, placement, passthrough?, treatment }`, following the fidelity section.
6. **deterministic/whiten.ts.** placeOnWhite becomes `placeOnBackground(source, mask, bbox, w, h, { rgb, fill, safeZone? })`, blending edges toward `rgb`. makeAmazonMain stays a wrapper passing `spec.background.rgb` or seed white. encodeUnderLimit takes the flatten color. New `buildProductReferenceFromEncoded`.
7. **raw.ts.** encodeJpeg takes the flatten color.
8. **qc/pixelChecks.ts.** backgroundWhiteOrClear and megapixels. P1 adds backgroundMatchesChoice.
9. **packager/index.ts.**
   - PackAsset gains `treatment?: { kind: "original" | "original_unchanged" | "background", reencodedAtUpload?, padHex?, cropped?, scale?, forcedWhite?, colorConverted?, alphaFilledHex?, otherItems? }`.
   - A shared `treatmentNotes(treatment)` builds the machine notes, used by the packager and by the web demo: `background: kept at seller request`, `original: unchanged file`, `original: stored copy, turned upright at upload`, `original: resized from WxH`, `original: padded #RRGGBB`, `original: cropped around product`, `original: enlarged N.Nx`, `original: color converted to srgb`, `original: transparent areas filled #RRGGBB`, `original: other items kept`, `original: already white`, `background: white required`, `background: color #RRGGBB`.
   - applyBadge skips original_photo assets and already white files (founder decision 6).
10. **ingest/image.ts.** ImageIngestResult gains `reencoded`.

**trigger**

11. **pipeline-runner.ts, start.** Parse `input.output` with the shared schema and fail closed (worker payload above). ctx carries `output`.
12. **pipeline-runner.ts, inventory and targets.** When a photo is not in `cutoutMediaIds`, takeInventory reads its cutout from the cache only (item 16) and never calls a provider; a miss leaves that photo's inventory empty. `selection.ambiguous` is filtered to photos in cutoutMediaIds before the MULTIPLE_PRODUCTS_MESSAGE check.
13. **pipeline-runner.ts, planning.**
    - When any photo is kept, skip the plan call (plannerSource deterministic, planRejection "seller kept the photo background").
    - Otherwise the recipe input has no `output`; validateLlmShotList skips disabled families with SELLER_OFF_REASON before its checks and rejects original_photo; fitShotsToChannels gains `excludeTypes`, applyOriginalSizes and coverSellerOffSpecs; the fallback is planned with the same flags, so the coverage comparison stays fair.
14. **pipeline-runner.ts, per output, for original_photo.** Skip extraItemsFailure and the judge (seed exemption) and decide with the pixel checks and fidelity. Use `fidelityKind: "main"`. For passthrough, verify sha256 and skip the RGBA decode. digitalSourceFor stays `none`. Set PackAsset.treatment. Record the measured background on colored outputs.
15. **pipeline-runner.ts, subtask boundary.** SerializedPackFile, serializeShotOutcome and deserializeShotOutcome carry `treatment` and the passthrough flag, with a round trip test. Check the Trigger.dev task output size limit against the official docs (rule 7, dated in docs/verification.md). If the largest original (16 MP, within spec.maxBytes, up to 20 MB on shopify.product, about 27 MB as base64) can exceed it, the subtask writes the file to R2 under the workspace prefix and passes the key.
16. **live-runtime.ts.**
    - generateLive branches on `shot.type === "original_photo"` before the `wiring.cutoutLive` gate and productFor; original_photo joins DETERMINISTIC_LIVE_TYPES.
    - LiveShotGeneratorOptions gains `cutoutCache?: CutoutCacheStore`, built once in runtime.ts next to installCutoutCache.
    - `inventoryCutout({ cacheOnly: true })`: prepareWorkingSource, then cutoutCacheKey on the same working bytes, then `store.get`, never through the router.
    - fullCutout reads the cache before callWithFailover, so a photo checked at upload still renders while the cutout breaker is open. A cache read is not a provider call; hits are logged as today.
    - P1: logoFor honors `logo`; template backgroundHex follows "Graphics follow your color".
17. **live-original.ts (new).** `renderOriginalShot({ shot, spec, output, photo })` loads the stored upload through loadMedia, checks isWorkspaceObjectKey, calls makeOriginalFit, and returns a StillRender with the mask, productReference, `fidelityRequired: true` and `fidelityKind: "main"`. It throws ShotUnavailableError "source too small for this channel" as a last guard.
18. **live-deterministic.ts.** renderOnWhite becomes `renderOnBackground(product, spec, backgroundFor(spec, output))` for amazon_main, alt_angle_white and collection_thumb. renderCutout flattens onto the same color. sweep_brand uses `output.brandSweepHex` when present, else today's brandHex.
19. **shot-outputs.ts.** EncodeOptions gains `fidelityKind`; the background exactness escape to PNG extends to white_or_transparent and white_preferred specs.
20. **shot-concurrency.ts.** A class that runs original_photo outputs one at a time per process.
21. **follow-up.ts, tasks/generate-shot.ts.** Carry `output`.
22. **runtime.ts.** DemoShotGenerator gains an original_photo branch (a patterned synthetic photo, real fit geometry, rectangle mask) for db mode without providers.

**apps/web**

23. **lib/pack-estimate.ts.** `output` and `photos` inputs; lines use the existing ", n" pattern: "Your photo, resized for each channel" and "Your photos, resized for each channel, 3"; "Made white for channels that require it"; alt_angle_white on a non white color reads "Other angles on your background".
24. **lib/services/db.ts createJob.** Refuse non default options while the flag or kill switch is off. Read the brand kit before the estimate. Resolve the color, check the brand entitlement, snapshot colorHex and brandSweepHex, return invalid_options on a missing index. keepMediaIds are the merged media R2 keys. Pass source_media sizes into the flags. Compute the hold with planFlagsOf. Insert `generation_jobs.output_options`. Concept mode normalizes the options to the defaults. The upload path writes `source_media.ingest`.
25. **replayFor.** sameBody also requires `outputOptionsKey(stored ?? defaults) === outputOptionsKey(input ?? defaults)`, so the same key with different options gets the conflict answer.
26. **followUpPayload, addShotPhoto, shot-ops.ts planAngleShots.** Read `output_options` from the job row and use the snapshotted hexes, never a live kit read. An angle added to a Keep pack plans original_photo.
27. **lib/jobs/payload.ts.** Width, height and reencoded per photo; parse the stored options again with the shared schema and attach `output`.
28. **lib/services/demo.ts, demo-plan.ts, lib/testing/fake-services.ts, compliance-report.ts.** hashBody includes outputOptionsKey; DemoJobRecord stores the options; planDemoShots honors the flags; demoShotImage draws in the spec's aspect and the chosen color, with an original_photo variant; demoComplianceReport emits notes from `treatmentNotes`.
29. **lib/job-copy.ts.**
    - skippedCopy branches before the fallback. SELLER_OFF_REASON: label "Turned off", note "You turned this off for this pack. Not charged." SOURCE_TOO_SMALL_REASON: label "Needs a larger photo", note "Your photo is too small for this channel without enlarging it more than {MAX_SOURCE_UPSCALE} times. Upload the original from your camera, or untick this channel. Not charged."
    - needsReviewNote gains the same branch for the "source too small for this channel" hint.
    - New outputOptionsSummary.
30. **lib/compliance-report.ts.** describeNotes maps each new note to one sentence; describeCheck gains the new labels.
31. **lib/preflight/copy.ts.** preflightBlockReason and sizeShortfalls take the output context: a photo that feeds no cutout skips the choose requirement; kept photos never block on size (heads up instead); removed photos keep today's rules.
32. **lib/provider-preflight.ts, new/page.tsx, new-pack-form.tsx.** The pause reconciliation (below).
33. **lib/features.ts.** `OUTPUT_OPTIONS_AVAILABLE` reads `NEXT_PUBLIC_OUTPUT_OPTIONS === "1"`, with a features test. The kill switch row is read server side with a short cache.
34. **lib/shares/pick.ts, pack-reveal.tsx, pack-downloads.tsx.** HERO_ORDER gains original_photo. When every hero candidate is original_photo, the makeover hides the before and after (it would show the same photo twice) and is titled "Sized for each channel". Reveal and download previews use the aspect box and checkerboard of the job cards.
35. **components/marketing/brand-kit-copy.ts.** "Your first brand color is used for the brand color background and for Brand look."

## UI

### New pack form (phone first)

One column below lg; from lg up, today's two column grid with the sticky summary card. The new UI lives in new components because new-pack-form.tsx is already 1001 lines: output-options-panel.tsx, background-color-select.tsx, output-preview-strip.tsx. Pure helpers and reducers (switch reset, Leave it out, custom state) go in lib/output-options-form.ts.

**Section 1, "Add your product".** Each photo row gains a 48 px thumbnail from its object URL, revoked on remove and unmount. With Keep, a photo showing several items shows the other items line instead of the chooser requirement. P1 adds the per photo Background Select.

**Section 2, "Pick your channels".** Each row gains a gray chip ("Stays white", "Set shape, 1080 by 1920") and, when the look affects it, an amber heads up line with "Leave it out".

**Section 3, "How your images look"** (replaces "3. How it is made"):
1. The Look cards, the Custom chip and Reset.
2. The Remove the background switch and helper.
3. The color Select, swatch chip and custom row, labelled by mode.
4. **Preview strip.** Scrolls sideways with snap on a phone, two or three frames: the first white required spec picked ("Stays white"), the first gallery spec, and the tallest exact size spec picked (for example "Meta story, 1080 by 1920"). Each frame is a div with the spec's CSS aspect ratio on the chosen color. With Keep it shows the seller's photo (object-fit contain). With Remove, P0 shows a neutral silhouette labelled "Your product here"; P1 swaps in the cutout preview. Caption "A quick preview. Your files are made to each channel's exact size and rules." With no photo yet: "Add a photo to see it here."
5. **Heads up for your channels**, only when conflicts exist: white required, borders refused, added text refused, Shopify consistency, other items, and too small ("This photo is 900 by 675 pixels, too small for Amazon other images without enlarging it more than 1.5 times, so it will be left out there. Upload the original from your camera to include it."). Each channel line has "Leave it out".
6. **Extra images**, five rows with costs, disabled with a reason when paused.
7. **More options**, a closed `<details>` whose summary counts changes ("More options, 2 changed"): Photo shape in P0, P1 controls as they land.
8. A Listing Mode line: "Built from your real photo. Your product is never redrawn." The Listing and Concept cards stay only when CONCEPT_MODE_AVAILABLE is true; in concept mode the switch and color are hidden and Remove is forced.

**Added text heads up (Keep, eBay or Google picked):** "eBay and Google do not allow added text, borders or watermarks on photos. If yours has any, leave these channels out or upload a clean photo. Your product's own logo and labels are fine."

**Pack summary.**
- On a phone, a sticky bottom bar: "About 2 credits" and a full width "Create pack". Tapping the total expands the lines, balance, hold and the difference between looks. The bar pads with `env(safe-area-inset-bottom)` and hides while a text input has focus, so it never covers the hex field.
- The total uses aria-live polite.
- From lg up, today's card with a first line such as "Background: removed, on warm white" or "Background: kept as you took it".

**Accessibility and phone details:** visible labels and 44 px targets everywhere; the Switch uses role=switch and the looks a radiogroup; no horizontal scroll at 360 px outside the preview strip; preview images use decoding=async.

**Idempotency and analytics:**
- intentFor gains `options: outputOptionsKey(options)` (and per photo backgrounds in P1), so the Idempotency-Key changes with any choice.
- The POST body gains `outputOptions` (and `uploads[].background` in P1).
- `track("pack_created")` gains look, look_base, background, color_kind, extras_off (count), kept_photos and fit. Enums and counts only, never a hex. New event `pack_look_changed` with `{ from, to }`.

### Copy (rule 9)

| Where | Copy |
| --- | --- |
| Custom chip | "Custom, started from Keep my photo" / "Reset" |
| Remembered choices (P1) | "Using your last choices for {title}." / "Start from Marketplace ready" |
| Custom color error | "Use a color code like #1F2A44." |
| Brand look disabled | "Add a brand color first." / "Brand kits come with the {plan} plan." |
| Several items, kept | "This photo shows other items. With the background kept, they stay in your images. Turn on Remove the background to show only your product." |
| Hold line | "We hold 2 credits and give back what is not used." |
| Shopify soft note | "Shopify suggests one background style across your store." |
| Paused, a pack is possible | "Background removal is paused for a few minutes while an image service recovers. You can still keep your photos as they are for channels that do not need a white background. Nothing will be charged." Button "Keep my photos instead" |
| After that switch | "We left out Amazon main image and Walmart because they need the background removed." |
| Options unreadable (runner) | "This pack's image choices could not be read, so nothing was charged. Please try again." |
| Options paused (kill switch) | "Image choices are paused right now, so this pack uses Marketplace ready." |

All figures in copy (credits, the enlarge limit, plan names, channel names) come from the seed, the registry or specDisplayName.

### Job page, compliance report, reveal and share

- **"Your choices" card** (job-options-card.tsx, new) next to InventoryCard (job-progress-board.tsx near line 411), with lines from JobView.outputOptions, for example "Background kept as you took it, on 3 photos.", "Amazon main image: background removed, because Amazon requires white.", "Added space: white.", "Turned off: lifestyle scenes, studio backdrops, transparent PNG, graphics."
- **Shot card previews** move from `aspect-square object-cover` (near line 450) to object-contain inside an aspect box on a neutral surface, with a checkerboard behind transparent files. Turned off shots are hidden.
- **describeNotes sentences:**
  - "Your photo, kept as you took it. Nothing in it was redrawn."
  - "Your photo file as uploaded, with location and camera details removed."
  - "Your photo file, turned upright when you uploaded it, with location and camera details removed."
  - "Your photo file as stored when you uploaded it, with location and camera details removed." (older uploads with no ingest record)
  - "Resized from 4032 by 3024 pixels."
  - "Space added around your photo in #F4F4F5 to fit this channel's shape."
  - "Trimmed to this channel's shape. Your whole product stays in the picture."
  - "Enlarged 1.3 times to reach this channel's minimum size."
  - "Colors converted to the standard sRGB profile that marketplaces expect."
  - "Transparent areas of your photo were filled with #F4F4F5."
  - "This channel needs a pure white background, so the background was removed for this file only."
  - "This channel needs pure white, so this file uses white instead of your color."
  - "Background color you chose, #1F2A44."
  - "Other items in this photo stay in the picture because you kept the background."
- The "Pure white background" check never shows for original files, since it never runs on their specs.
- Reveal, downloads and the share hero follow item 34.

## Follow ups and retries

- retryShot reruns the stored shot with `output` from generation_jobs.output_options.
- addShotPhoto plans through planAngleShots with the stored output: original_photo on a Keep pack, alt_angle_white on the stored color on a Remove pack.
- Colors on follow ups come from the snapshotted colorHex and brandSweepHex, never a live kit read. This also fixes today's drift where a kit edit changes a retried sweep_brand.
- followUpPayload still sets mode "listing".

## Brand kit integration

- new/page.tsx loads getBrandKit and passes colors, the logo flag and the style preset; brandKitAllowed comes from tierEntitlements.
- A background color never depends on a kit: the free tier gets the seeded colors and a custom color.
- Brand look uses brand color 1, the kit logo and the kit style preset.
- createJob snapshots the resolved hexes and refuses a brand choice the plan does not include.

## Provider pauses (PHASE_14 1.5 reconciled)

- **packs_paused:** the form blocks submit only when `packNeedsCutout(selected, flags)` is true. The banner offers "Keep my photos instead": Keep look, every extra off, white required channels unticked, and a line naming what was left out. The provider-preflight doc comment and PACKS_PAUSED_COPY change to the conditional wording (keeping "Nothing will be charged.").
- **scenes_paused:** the scenes extra is forced off and disabled with SCENES_PAUSED_COPY; the hold excludes scenes.
- **Server side:** any pause check added to createJob uses packNeedsCutout too.

## Flags and deploy order

- `OUTPUT_OPTIONS_AVAILABLE` (env, per environment) shows the form section. The `output_options_enabled` platform setting is a runtime kill switch that needs no deploy.
- While either is off, the server refuses non default options with `feature_unavailable`, so an older runner can never receive a Keep request it would run as a Remove pack.
- Order for every slice that adds a field: deploy the Trigger.dev worker first, then the web app, then flip the env flag in staging, then production.
- A test sends a new web payload to a runner built without the new field handling and asserts the service refuses it while the flag is off; another asserts an invalid `output` fails closed.

## Tests

**Options module, seed and registry**
- output-options.test.ts: `{}` normalizes to remove, white, all extras on, fit auto; Keep normalizes extras off; LOOK_PRESETS round trip through lookOf and any difference reads custom; outputOptionsKey is stable under key order, equal for absent and explicit defaults, ignores lookBase and resolved fields; the schema rejects '#FFF', 'red', '#GGGGGG', a brand index of 6, `fit: "crop"`, `edge_match` and unknown keys; planFlagsOf holds no hex and no free text; cutoutMediaIds and packNeedsCutout truth tables; backgroundFor returns white for exactly the four white specs under every choice (property test over listSpecs()); originalFitFor maps pad to auto on bordersAllowed false specs; originalScale meets minLongSide, minWidth and minHeight within the cap or skips.
- packages/specs: requiresWhiteBackground is true for exactly amazon.main, walmart.main, google.merchant.main and tiktokshop.main; isExactSize matches the registry's exactSize specs; the new flags parse.
- seed.test.ts: swatches are valid unique hexes; the white swatch equals stillStyle.whiteHex equals the amazon.main registry rgb; every creditCosts value is a multiple of 0.5 (or of 0.1 once the tenths step lands); a grep test finds no hex literal left in renderer code; P1: productSizeFill values clamp into the amazon.main and google.merchant.main fill ranges.
- Rule 2 copy test: changing a seed price, MAX_SOURCE_UPSCALE, a tier entitlement or a registry background rule changes the rendered copy.

**Planner and runner**
- planner/deterministic.test.ts:
  - Keep, default channels, 3 photos: amazon_main on amazon.main only plus 3 original_photo; the front original covers amazon.secondary, shopify.product and meta.feed_1x1; no alt_angle_white, sweep, cutout_png, lifestyle, collection_thumb or social card; skipped entries carry SELLER_OFF_REASON.
  - Keep with Walmart and TikTok Shop narrows alt_angle_white to those specs.
  - Property: original_photo never targets a white required spec, for every option combination.
  - Each extra removes exactly its family and holds no slot.
  - coverSellerOffSpecs attaches meta.feed_4x5 to the front shot when cards are off, never covers a spec emptied for another reason, never covers a white required spec.
  - Keep with 6 photos (MAX_PACK_PHOTOS) and every extra on: all 6 originals keep amazon.secondary.
  - Snapshot: default options plan exactly today's shots for every channel preset.
- pipeline-runner.test.ts:
  - With Keep, the plan recipe is never called; without Keep, the recipe input has no `output` key.
  - An LLM plan with lifestyle shots and scenes off is accepted with those shots skipped, and plannerSource stays "llm"; meta.feed_1x1 with cards off is covered on both paths.
  - validateLlmShotList rejects original_photo.
  - A Keep pack with no white channel on a "several items" photo completes; the same photo with amazon.main picked stops with MULTIPLE_PRODUCTS_MESSAGE when unchosen.
  - The judge mock is never called for original_photo and is called for amazon_main; checkGeneration uses the main row for originals.
  - A passthrough whose bytes differ from the source fails; a kept photo is charged once across its channels.
  - With no white required spec and no extras, the pack completes while the fake cutout provider fails every call.
  - An invalid or unknown `v` output fails the job before any provider call and releases the hold.
  - serializeShotOutcome and deserializeShotOutcome round trip `treatment` and the passthrough flag.
- live-runtime.test.ts: original_photo never calls productFor and renders with cutoutLive false, while amazon_main throws ShotUnavailableError; inventoryCutout cacheOnly never calls a provider; fullCutout returns a cached cutout while the breaker is open; P1: logo off draws no logo, a dark template color flips the text.

**Rule 3 and fidelity**
- deterministic/original.test.ts:
  - A 1500 by 1500 sRGB JPEG on etsy.listing passes through with sha256 equal to the stored bytes.
  - A 4032 by 3024 photo on amazon.secondary comes out 2000 by 1500, and inside the mask its pixels match buildProductReferenceFromEncoded.
  - pad on meta.feed_4x5: the added space is exactly the pad rgb and the photo region is exact; meta.story_9x16 keeps the photo inside the safe zone; ebay.listing with pad keeps its own shape.
  - The scale never goes above 1.5 (1.0 with Never enlarge in P1).
  - No sharpening: against an independent sharp lanczos3 resize, max dE at most 0.5.
  - A Display P3 source is not passed through, matches sharp's own conversion within a mean dE of 1, and reports the conversion.
  - Fixtures: CMYK JPEG, 16 bit PNG, alpha PNG (filled on the resolved color, alpha as the mask), grayscale JPEG (rendered, not passed through), a rotated EXIF upload (note "turned upright").
  - A red label fixture passes fidelity through the encode ladder; an A+ output that cannot meet 2 MB losslessly goes to needs review.
  - An 80 MP photo on google.merchant.lifestyle ships at most 16 MP; a 3000 by 400 panorama is skipped or raised to minHeight 500 at plan time, never failed at QC.
  - Peak RSS on the 80 MP fixture stays under the seeded limit.
  - No delivered file carries a GPS tag.
  - P1 crop: property test over random boxes and aspects shows the box plus margin always inside the window, or a fallback to pad.
- live-rule3.test.ts: original_photo passes fidelity with kind "main" on every spec it may target, in auto and pad; mutation doubles applying sharpen(), modulate({ brightness: 1.02 }) or a 1 px shift fail; renderOnBackground with #1F2A44 keeps product pixels identical to the white render inside the eroded mask; amazon_main stays exactly 255 white under every color.
- qc/pixelChecks.test.ts: backgroundWhiteOrClear fails a gray file on google.merchant.main and tiktokshop.main, passes today's white renders and alpha, fails closed without a mask; the megapixels check fails over the limit.
- packager tests: a free tier pack with Keep on a social spec ships original_photo and already white files with no badge, and a passthrough file keeps its sha256; made white files and scenes still get the badge; treatmentNotes covers every treatment.
- Golden set: every seeded swatch plus one dark custom color (fringe review), and a set of Keep photos with zero fidelity failures.

**Pricing, holds and idempotency**
- pack-estimate.test.ts: the fixtures table; the new line labels.
- Parity property test: for random option sets on the same merged media list createJob uses, the form estimate, the createJob hold and planDemoShots agree, and the runner's deterministic plan fits the hold with no "credit budget" skip.
- db-create-job.test.ts, db-seller-inputs.test.ts or a new db-output-options.test.ts: output_options stored resolved with the brand hex snapshotted; the same key with the same options replays and with different options conflicts; no options and explicit defaults are the same body; a brand index beyond the kit returns invalid_options; a brand choice on the free tier returns upgrade_required; non default options with the flag off return feature_unavailable; concept mode normalizes; after a kit color change, followUpPayload and addShotPhoto use the stored hex; an added angle on a Keep pack plans original_photo.
- demo.test.ts: hashBody changes with the options; planDemoShots and demoShotImage handle Keep; demoComplianceReport emits treatment notes.
- packages/db (rule 5): 0023 adds three nullable columns with the object checks; a member of workspace B cannot select or update workspace A's output_options, output_defaults or ingest; old rows read as the defaults.

**API, copy and UI**
- jobs-routes.test.ts and seller-inputs-route.test.ts: valid options accepted; bad hex, unknown key, out of range index or a P1 value return 400; a maximal body stays under JOB_BODY_MAX_BYTES.
- payload.test.ts: width, height and reencoded pass through; the stored options parse again; an invalid stored value throws.
- job-copy.test.ts and compliance-report.test.ts: each new reason has its own copy, and "source too small" never lands in the "needs photo" or "source photo" branches; every new note maps to one sentence; a rule 9 lint over every new string (no emoji, no arrow, no en or em dash, no " - ").
- output-options-copy.test.ts: every conflict code for every registry spec has copy that passes the same lint.
- new-pack-page.test.ts and seller-inputs-form.test.ts (renderToStaticMarkup): channel options carry the registry flags; conflict lines appear only for real conflicts; the Switch renders role=switch and aria-checked; the looks render a radiogroup.
- output-options-form.test.ts: the reducers for switch reset, Leave it out and custom color; the intent key changes with the color or the switch; packsPaused blocks submit only when packNeedsCutout is true.
- preflight.test.ts: a kept photo with several items and no white channel does not block; size never blocks a kept photo.
- features.test.ts: the env flag and the kill switch.
- e2e/output-options.spec.ts (Playwright, demo mode, 390 by 844, uploading a real small PNG):
  1. Upload a photo and tap Keep my photo.
  2. The Amazon main heads up appears and the estimate drops.
  3. Pick a custom color, type a hex, create the pack.
  4. The job page shows the Your choices card, original_photo cards uncropped in their aspect, and a white Amazon main.
  5. The report shows the kept background and added space notes.
  6. A second run picks Sand with Remove; the Amazon main note says white.
  - Throughout: no horizontal scroll outside the preview strip, the sticky bar stays visible, the Switch toggles by keyboard, and Leave it out unticks the channel.
- pnpm eval via prompt-eval.md: the plan tool schema is unchanged (LlmShot), and the golden set shows no regression. Add golden photos already on a lifestyle background for Keep packs, extending PHASE_14 workstream 5.

## Rollout order

Phase 15 branches from main as `p15/output-options` after rechecking `git worktree list` and `ls packages/db/migrations`.

0. **Plan and verification.** This file, written in plan mode (rule 1). Dated docs/verification.md entries: eBay's no added borders, text or watermarks rule; TikTok Shop's pure white main and no borders rule; Google Merchant's white or transparent main, its overlay rule, and its image size and byte limits; sharp's ICC and sRGB behavior and fastShrinkOnLoad; the Trigger.dev task output size limit.
1. **Slice A, foundations with no visible change.** Seed, specs helpers and registry flags, output-options.ts, migration 0023, ingest record, Shot enum with LlmShot, planner (originals, extras, reservations, sizes, seller off cover), estimate, API (refusing non default options while the flag is off), createJob, replay, payload, follow ups, demo, runner parse and fail closed, validateLlmShotList and fitShotsToChannels changes. A snapshot proves the default plan is unchanged. pnpm eval.
2. **Slice B, rendering.** original.ts, live-original.ts, the runtime branch, the cutout cache option, the cache only inventory, the ambiguity filter, the judge exemption, fidelityKind, passthrough proof, the subtask boundary, originals concurrency, the already white path, packager notes and the badge skip, report and skipped copy, backgroundWhiteOrClear and megapixels (enabled after a golden set run), the fringe review. Deploy the worker.
3. **Slice C, UI.** The Switch, section 3, looks, color, chips and heads up, extras, the preview strip (Keep frames), estimate lines, the pause reconciliation, the job card and previews, reveal, downloads and share. Deploy the web app, then flip OUTPUT_OPTIONS_AVAILABLE in staging, then production. e2e.
4. **Slice D, P1**, each control with its schema field, renderer and tests, worker deployed first.
5. The backlog moves to PHASE_16.

Each slice ends with the reviewer agent (security, RLS, cost caps) and the rule 6 gate.

## Success metrics

Measured in PostHog (pack_created properties) and generation_jobs.output_options, 30 days after launch:

| Metric | Target |
| --- | --- |
| Share of new packs that change at least one choice | Measured; tells us whether the controls are found |
| Share of packs using Keep my photo, and Resize only | Measured; the founder's core case |
| Delivered files on a white required spec with a non white background | 0, enforced by the main class checks and backgroundWhiteOrClear |
| Keep packs that deliver every planned file | 99 percent or more |
| original_photo outputs failing fidelity | Under 0.5 percent; each one is investigated as a pipeline bug |
| "credit budget" skips on packs with options | 0, which proves hold parity |
| Provider spend on a Resize only pack | No image model and no cutout provider call; LLM spend is analyze plus intake when not reused, measured in cost_micros to decide the backlog item |
| Time to done for Keep packs | p50 under 30 seconds |
| Second pack of the same product within 24 hours with a different look | Falls against the pre launch baseline |
| Packs started while packs_paused | Above 0, where they were impossible before |

## Founder decisions

Decided 2026-09-29.

1. **Price of a kept photo:** 0.5 credits per photo per pack (creditCosts.deterministic). No new price, no ledger change, and the integer tenths step stays unscheduled.
2. **White required channels with Keep:** the background is removed for those files only, with Leave it out one tap away (control 4).
3. **Walmart and TikTok Shop secondary specs:** not added. Every Walmart and TikTok Shop file stays white.
4. **Default number of scenes (P1):** 3, the midpoint of today's 2 to 4 by category, planned exactly for every category. A default pack gains one scene (1 credit) when sceneCount lands (see the P1 table).
5. **The upload cutout when Keep is chosen before upload:** kept. It feeds the inventory warning, the cutout preview, already white detection and an instant switch back to Remove.
6. **The free tier badge on kept photos:** none. Kept photos never carry the badge; other outputs keep today's rule.
7. **Remembering choices per product (P1):** automatic prefill, like SKU today, and never applied server side.
8. **Already white photos:** P0 (control 7).

## Done when

**P0 (slices A to C):**
- Every P0 control works end to end in demo and live: form, API, job row, runner, follow ups, job page, report, reveal and share.
- A pack with no options plans and delivers exactly today's pack (snapshot).
- Zero fidelity failures on the golden set of Keep photos; the swatch fringe review is recorded.
- The already white path passes the main class checks and fidelity on its golden photos (studio shots on white), and a photo with an off white or shadowed background takes the made white path.
- The docs/verification.md rows from step 0 are dated.
- Every test above passes, `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` passes, and `pnpm eval` shows no regression (rule 6).

**P1 (slice D):**
- Each P1 control has its schema field, renderer, copy, estimate effect and tests, landed worker first.
- Crop never cuts the product box (property test); per photo backgrounds plan correctly with mixed packs; scene count and style change the hold exactly; memory prefill never applies server side; the default pack snapshot moves to 3 scenes in the same pull request as sceneCount, with the pack-estimate fixtures updated; the added text flag passes pnpm eval.
- The rule 6 gate and pnpm eval pass.

## Review log

Two reviews checked the draft against the code. Every factual claim below was confirmed on main before this revision.

**Taken:** float drift with a 0.2 price (answered by recommending 0.5, with the tenths step mandatory for 0.2); disabled families filtered instead of rejected on the LLM path, with cover shared by both plans and no `output` in the plan input; kept photos with several items no longer blocked; the passthrough megapixel cap, a reference built from encoded bytes and originals run one at a time; R2 keys as media ids and real photo counts; photo sizes in the payload and no size blocks for kept photos; treatment carried across the subtask boundary; honest runner call counts; seller off cover limited to seller removals and never white required specs; e2e aimed at the web demo services; the badge only in added space; cache first cutout reads; the main fidelity row and alpha handling for originals; an env flag, a kill switch, fail closed parsing and worker first deploys; corrected file references; premium_full marked coming soon; the in flight worktree; share, reveal and download previews; the stored ingest record; CMYK, 16 bit, alpha and ICC rules; Google size limits and a megapixels check; the existing encode ladder instead of a new one; the added text heads up; a P0 only schema; already white photos (P1); originals ahead of extras on Amazon; copy numbers from the seed and registry; the free resizer; server derived look, brand entitlement and prefill only memory; edge blending toward the chosen color; ICC claims and the Keep card copy; the P2 list moved to a backlog with new candidates; the note hint.

**Not taken, or changed:**
- Integer tenths arithmetic across the ledger is not scheduled, because the founder picked 0.5 and every value stays a multiple of 0.5.
- The suggested copy "turn on Remove the background for these channels" for added text on eBay and Google was changed: removing the background does not remove text or a watermark printed on the photo, and product logos are always allowed (PHASE_14 founder decision), so the copy says leave the channel out or upload a clean photo, and that product logos and labels are fine.
- The "8 kept photos" test uses 6: JobRequest accepts 8 uploads, but mergePackMedia caps a pack at MAX_PACK_PHOTOS (6).
- Separate render and delivery megapixel caps were merged into one seed value, `originalFit.maxMegapixels`, applied to every kept output.
- Grayscale photos are rendered, not passed through, which is the more conservative reading of "space srgb or b-w".
- The axe check moved to the backlog: it needs a new dev dependency while home/liquid-metal holds uncommitted changes to apps/web/package.json. The e2e asserts roles, names and keyboard behavior directly.
- The dark color note for custom colors ships only if the golden fringe review still shows a fringe after the edge blend change.
