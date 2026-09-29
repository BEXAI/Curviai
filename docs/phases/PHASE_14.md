# Phase 14: no dead ends for real sellers

Date: 2026-09-29. Source: an evaluator's session with watch photos, three packs, three different failures, zero files delivered.

| Attempt | What the seller saw | Failure mode |
| --- | --- | --- |
| Messy café photo, watch and sneakers | "Could not find a product" | Input: cluttered multi object photo |
| Official Rolex shot, and a SwissLuxury photo of a watch on white | "Flagged for manual review" | Moderation false positive |
| Clean unbranded silver watch, twice | "This pack stopped because of a problem on our side" | Platform: image service failure |

Credits: nothing was charged. The evaluator reported 6 credits still held by the failed pack; those must be released (verified in 1.1).

## Root causes

1. **Branded products are blocked outright.** The product analyzer's prompt (packages/pipeline/src/seed/recipes.ts, product_analyzer rule 5) says "A famous luxury logo on a low quality photo is possible_counterfeit", and moderationBlockReasons (trigger/src/pipeline-runner.ts) turns possible_counterfeit into a hard stop worded as "needs a manual review". No review queue exists, so the seller hits a dead end. Brand owners and people who work for them are exactly Curvi's customers.
2. **The image service failure is not yet diagnosed.** The copy is honest (nothing charged), but the pack delivered nothing at all, even the files that need no image model (white main, cutout, sweeps). One failing provider takes down the whole pack.
3. **A cluttered photo gets a flat refusal.** Intake decides "no sellable product" when the product shares the frame with other items, and the seller learns this only after starting a pack.
4. **Every failure is discovered after submit.** All three problems could have been caught in seconds at upload, before any hold or wait.

## Workstream 1: the image service failure (P0, first)

**1.1 finding (2026-09-29, read only query on production):** the four most recent failed packs, including both unbranded watch attempts, stopped with `All providers failed for task cutout: photoroom responded 402: You have exhausted the number of images in your plan`. The Photoroom account ran out of its image quota. Every shot starts from the cutout, so one exhausted provider failed every pack. Held credits were released (the evaluator's balance reads 15). Founder action: upgrade or top up the Photoroom plan. Code actions: 1.2 below.


| # | Item | Done when |
| --- | --- | --- |
| 1.1 | Diagnose: read job_steps errors for the two failed watch packs (read only query, founder approved), the Render logs around them, and `/api/health/providers` with the cron secret. Confirm the 6 held credits were released by the failure path or the stale job sweep; release them if not. | The exact provider, status and message are known and written in this file; the evaluator's balance is correct. |
| 1.2 | Quota and billing failures: classify provider 402 and quota responses as provider_quota (never retried, trips the breaker at once, logged loudly, recorded as an event, shown as a /api/health warning) and wire a second cutout provider through fal.ai so an exhausted Photoroom plan fails over instead of failing every pack. Count cutouts per job so one pack never pays for the same cutout twice. | With Photoroom returning 402, packs complete through the fallback, and health shows the quota warning. |
| 1.3 | Degrade instead of failing: when the generative provider chain is down, still deliver every deterministic shot (Amazon main, alternate angles, cutout PNG, sweeps) and mark generative shots "Paused, not charged". The pack ends done with a partial set, never a blank failure. | A test with every image provider returning 5xx delivers the deterministic files and charges only those. |
| 1.4 | Transient errors retry automatically: one delayed re-run of failed generative shots (backoff, same run key) before giving up. | Chaos tests (timeout, 429, 5xx, 401) show retry for transient codes only. |
| 1.5 | Preflight health: before a pack starts, check the provider breaker state and the last probe. If generation is down, the new pack form says so and offers the deterministic only pack. | The seller knows before submitting. |
| 1.6 | Alerting: provider failure rate and breaker opens page the founder (Phase 12 D1 and D4, Sentry DSN needed). | A staging drill fires the alert. |

## Workstream 2: brands and logos are always allowed (P0)

Founder decision, 2026-09-29: sellers use Curvi for their own company brands and for blue chip employers and clients. It is not Curvi's job to validate a seller's employer or their rights to a photo or a brand. Every restriction tied to logos and brands is removed. Moderation keeps only the categories that are prohibited whatever the brand (nudity or adult content, weapons, drugs, prohibited goods).

| # | Item | Done when |
| --- | --- | --- |
| 2.1 | Remove possible_counterfeit as a block: moderationBlockReasons ignores it, and the ProductProfile schema keeps it only for backward compatibility (never set by new recipes). No brand or logo ever stops or delays a pack. | A Rolex on white and a SwissLuxury photo run to a full pack. |
| 2.2 | Product analyzer version 2 (new recipe row, pnpm eval, re-seed): drop the counterfeit rule and every instruction to judge brands, logos or authenticity; brands and logos are simply transcribed into preserveLogos and preserveText as today. | No golden set photo with a brand is flagged. |
| 2.3 | No seller attestation, no ownership check, no brand prompt in the form. | Nothing in the flow asks about brand rights. |
| 2.4 | Remove "needs a manual review" wording everywhere; a prohibited category refusal says plainly why and what to do. There is no review queue. | No seller waits for a review nobody performs. |
| 2.5 | realPersonMainSubject: a product worn on a wrist, hand or body is not "a person as the main subject". Narrow the intake wording and test with a watch on a wrist. | On-wrist product photos pass. |

## Workstream 3: cluttered photos (P1)

| # | Item | Done when |
| --- | --- | --- |
| 3.1 | Intake treats "several items, one of them the product" as sellable and lets the inventory and the seller's note pick (Phase 13 inventory, vision picker). "No sellable product" only when nothing in the frame is a product. | The café photo with "the watch" in the note produces a watch pack. |
| 3.2 | The product chooser at upload (Phase 13 item 5): thumbnails of what was found, tap the product. | Ambiguous photos are resolved by the seller in one tap. |
| 3.3 | Photo guidance on refusal: say what was seen and give two concrete tips (one product, plain background, whole product in frame), with a sample good photo. | Refusal copy is specific, not generic. |

## Workstream 4: preflight at upload (P1)

Run intake, moderation, the inventory and the size gate as soon as a photo is uploaded (cheap Haiku call plus the cutout), before any credits are held, and show the result on the form: "Found: silver watch. Ready for Amazon, Shopify and Meta." or the specific problem with the fix. The pack reuses the preflight result, so the seller never pays for, or waits on, a pack that was going to fail.

## Workstream 5: testing so this does not happen again (P1)

- Golden set additions (Phase 12 B1): branded luxury watch on white, the same watch on a wrist, an unbranded watch, a café scene with a watch and sneakers, sneakers with a big logo.
- A live eval run against staging for each, asserting: every branded photo runs, cluttered photo runs with a note or asks to choose, and every pack delivers at least the deterministic files when generation is down.
- A synthetic "evaluator walk" e2e in staging: upload, preflight, pack, download, with each failure mode forced.

## Order

1. 1.1 and 1.2 now (production outage; needs founder approval for the read only query and log access).
2. Workstream 2 in full (unblocks every branded seller), with eval and a re-seed for the analyzer version 2.
3. 1.3 and 1.4 (degrade and retry), then 1.5 and 1.6.
4. Workstreams 3 and 4, then 5 alongside.

## Founder decisions

- Decided 2026-09-29: brands and logos are always allowed, with no attestation and no review.
- Whether a deterministic only pack (no lifestyle scenes) charges full or reduced credits when generation is paused (the plan assumes only delivered shots are charged, as today).
