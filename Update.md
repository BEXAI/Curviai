# Curvi.ai update plan: make existing features work as intended

Date: 2026-09-28. Scope: correctness of features that already exist. No new features. Items the plan audit (docs/AUDIT_2026-09-27.md) or the open follow ups in docs/verification.md already track are left out unless a fix here depends on them.

## Where things stand

| Check | Result |
|---|---|
| `pnpm typecheck` (8 workspace packages) | Pass |
| Root `e2e/` specs and `playwright.config.ts` (not covered by any tsconfig) | Pass when checked ad hoc |
| `pnpm lint` (206 files) | Pass, 0 warnings |
| `pnpm test` | 405 passed, 1 skipped |
| `pnpm e2e` (fresh production build) | 12 of 12 passed |
| `drizzle-kit generate` after the merge | No schema drift |
| Stricter compiler flags (`noUncheckedIndexedAccess`) | About 150 latent errors, mostly typed array pixel loops; about 25 in app code (see wave 7) |

How this plan was built: the full check suite above, then four parallel code reviews of the merged tree (web API and services; worker and ledger; pipeline, video and specs; AI layer and UI). Every finding was confirmed by reading the code, and several by running the code. Duplicates across reviews are merged below. In total there are 78 raw findings, which collapse to 64 items.

### What changed on 2026-09-28 before this plan

- `origin/main` (what Render deploys, b8c3307) and local main had split. Local main held the three audit remediation waves, which were never pushed. The branch `worktree-ui-update-plan` held 14 commits of UI, Render, signup and live provider work. The two were merged in 929f2fc.
- Migration numbers collided. The branch's `0004_signup_bootstrap` and `0005_brand_logo` kept their numbers, because production already has them. Main's migrations became 0006 to 0009, with journal timestamps later than 0005.
- Two merge regressions were found by the review and fixed in 7669203:
  - Runner guards (`excludeShotMethods`, asset and pack cost caps) are restored on the db runtime.
  - `saveProfile` now runs after the moderation block.
- Two iCloud duplicates were moved out of `.git` (`refs/heads/main 2`, `index 2`). The broken ref was making `git fetch` fail.

## Wave 0: release blockers (do first, in this order)

1. **Apply migrations 0006 to 0009 to production Supabase** (project tmwvjmvzjvpeagatjmud).
   - A read-only check on 2026-09-28 found production at 0005:
     - `credit_ledger.delta` is still integer.
     - There is no `pack_files` table.
     - There is no `generation_jobs.channels` or `mode` column.
     - `provision_workspace` does not exist.
     - The ledger functions still take integer amounts.
   - Run the four files in `packages/db/migrations/` in order, inside one transaction.
   - Record all ten migrations in `drizzle.__drizzle_migrations`, using sha256 of each file and the journal `when` value. That table does not exist yet, so a bare `pnpm db:migrate` would try to replay 0000 and fail.
2. **Push main only after step 1.** Render auto-deploys main, and the merged code calls the numeric ledger functions and writes `pack_files`, `channels` and `mode`.
3. **Repair any dev or staging database that ran the pre-merge main migrations.**
   - Drizzle only compares against the last applied `created_at`. A database whose last row is the old `0007_provision_workspace` will re-run 0004 and 0005, then fail on 0006 `CREATE TABLE pack_files`.
   - Either fix those journals by hand, or make 0006 and 0007 idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`).
4. **Delete or archive the merged worktree** at `.claude/worktrees/ui-update-plan` so `pnpm lint` at the root stops walking a second copy of the repo.

Gate: the production health check (`/api/health`) returns ok, one real signup gets its free grant, and one Listing Mode pack runs to done with pack files downloadable.

## Wave 1: money and credits

These affect what customers pay or receive. Fix before any paid traffic.

| # | Problem | Where | Fix |
|---|---|---|---|
| 1.1 | Paid plans never take effect. `upsertSubscription` writes `subscriptions` only; nothing sets `workspaces.plan`, so `tierKeyOf` always returns free. Estimates and the worker `tier` are free tier for paying users. | apps/web/src/lib/billing/db-store.ts:79-106; apps/web/src/lib/services/db.ts:496 | Set `workspaces.plan` to the tier on active or trialing, back to free on cancel, through the service role. |
| 1.2 | Annual subscribers get one month of credits per year. Annual prices map to `creditsPerMonth` and grants only happen on `invoice.paid`. | apps/web/src/lib/billing/price-table.ts:43; stripe-webhook.ts:159-170 | Grant 12 months on annual invoices, or add a monthly grant job for annual subscriptions. Decide which against the plan's rollover rules. |
| 1.3 | A Stripe grant can be lost for good. The `events` dedupe row is committed before the ledger insert, so a failed insert plus Stripe's retry looks like a duplicate. | apps/web/src/lib/billing/db-store.ts:35-63 | Put the dedupe insert and the ledger insert in one `db.transaction`. |
| 1.4 | Top ups are granted before payment clears. | stripe-webhook.ts:146-156 | Grant only when `payment_status === "paid"`; also handle `checkout.session.async_payment_succeeded`. |
| 1.5 | Checkout makes a new Stripe customer every time and allows a second active subscription. The second subscription hits `subscriptions_one_active_per_workspace_uq`, and the webhook 500s until Stripe gives up. | apps/web/src/app/api/billing/checkout/route.ts:82-92; billing/db-store.ts:64-97 | Reuse `stripe_customer_id`. Send tier changes for existing subscribers to the portal. Upsert subscription status on the workspace. |
| 1.6 | Customers are charged for packs that never shipped. `charge_credits` runs per passing asset before `buildPack` and `savePack`, and the catch block only releases what is still held. | trigger/src/pipeline-runner.ts:1002-1031 | Charge after `savePack` succeeds, or refund the charges in the catch block. |
| 1.7 | The LLM planner sets its own prices and can break the ledger. `validateLlmShotList` sums `s.credits` exactly as returned, with no unique ids, no minimum and no channel check. Duplicate shot ids leave credits held forever. `credits: 0` fails the pack after generation. Concept mode can plan `amazon.main`. | trigger/src/pipeline-runner.ts:813-827; packages/pipeline/src/schemas.ts:28-35 | Recompute credits from the `creditCosts` seed by method. Require unique ids. Keep channels inside `effectiveChannels`. Require `sourceMediaId` to be one of `input.images`. Enforce the planner's required shots (for example `amazon_main` when Amazon is selected). |
| 1.8 | Any `reserve_credits` error, including a DB outage, is reported as 402 "Not enough credits". A throwing `release_credits` in the enqueue catch hides the real error. | apps/web/src/lib/services/db.ts:524-564 | Map only the insufficient balance exception to 402. Wrap the release in try/catch and log it. |
| 1.9 | The signup grant ignores the seed. `bootstrap_workspace` (0004) hardcodes 15 credits with source `'signup'`, which is not in `LedgerSource`. On Supabase it always runs before `provision_workspace`, so changing `creditsOnce` does nothing. | packages/db/migrations/0004_signup_bootstrap.sql:24-26; packages/db/src/schema.ts:43 | New migration: have `bootstrap_workspace` call `provision_workspace` with an amount stored in a seeded table, or drop one path. Add `'signup'` to `LedgerSource` or switch to `'system'`. |

Tests to add: webhook grant atomicity (inject a ledger failure, retry, credits arrive exactly once); annual invoice grant; plan change updates `workspaces.plan`; LLM plan with duplicate ids, zero credits or a foreign channel is rejected; a pack whose `savePack` throws ends with net zero charge. Also the concurrent reserve and charge race test the audit already asks for.

## Wave 2: output integrity (the product promise)

| # | Problem | Where | Fix |
|---|---|---|---|
| 2.1 | Live mode ships and bills demo placeholder images. `LiveShotGenerator` sends every method except `composite_generate` and `edit_generate` to `DemoShotGenerator`, including `amazon_main`, alt angles, cutout, sweeps and infographics. It also does this when the R2 loader returns null, since every load error becomes null. The synthetic rectangle is built to pass pixel QC, so it passes, gets charged and is packaged as `{sku}.MAIN.jpg`. | trigger/src/live-runtime.ts:303-311, 346-352; trigger/src/runtime.ts:231-233 | In live mode, return needs_review or skipped for unsupported methods and missing sources. Never fall back to demo output on a paid run. Surface loader errors instead of null. |
| 2.2 | Thin products (chains, cables, rings) can never pass fidelity. QC erodes 7 px by default, but the paste erosion is clamped lower and is not passed along. Each shot burns 4 paid attempts, then goes to needs_review. | pipeline-runner.ts:632; packages/pipeline/src/qc/fidelity.ts:90; live-runtime.ts:423-429 | Carry `effectivePasteErodePx` on `ShotGeneration` and derive the QC erosion from it, with an area floor. |
| 2.3 | QC checks the raw image, not the file that ships. JPEG-only specs are encoded after fidelity, pixel checks and packaging have already run. | live-runtime.ts:417-421; pipeline-runner.ts:620, 632; packager/index.ts:137 | Decode `encoded.buffer` for QC, as eval/run.ts:235 already does. |
| 2.4 | Dark halo around the pasted product. The feather spreads past `canvasMask` onto pixels that premultiplied resize turned black. | packages/pipeline/src/composite/index.ts:198-217, 257-263 | Cap `pasteAlpha` with `canvasMask` so the feather only works inward. |
| 2.5 | Cutout transparency is thrown away (binary mask at alpha > 8, reference forced opaque), giving hard fringes on hair, fur and glass. | live-runtime.ts:315-321; composite/index.ts:210-213 | Multiply `pasteAlpha` by the resized cutout alpha. |
| 2.6 | Fidelity can pass on bad buffers: lengths are not checked, and a NaN deltaE is never greater than the threshold. | qc/fidelity.ts:81-128 | Check `data.length === w*h*4` and the mask length. Fail when the mean or max is not finite. |
| 2.7 | Main image checks pass when the mask is missing (white background and fill are skipped). | qc/pixelChecks.ts:123, 152 | For main-kind specs, fail those checks when no mask is supplied. |
| 2.8 | The dimension check only enforces an upper bound, so 1080x1080 passes `meta.feed_4x5`. | packages/specs/src/index.ts:133-137 | Require an exact match when the spec sets width and height. |
| 2.9 | PNG bytes ship with `.jpg` names (`SKU.MAIN.jpg`). | packages/specs/src/registry.json:19, 32, 65; packager/index.ts:226-234 | Replace the template extension with the actual encoded format. |
| 2.10 | `amazon.secondary` `maxCount: 8` is never enforced, so the packager emits PT09 to PT13. | planner/deterministic.ts:66-200; packager/index.ts:237-241 | Cap per spec in the planner or packager and move extras to `skipped`. |
| 2.11 | Only `channels[0]` of each shot is generated, QC'd and packed, so Shopify and Google zips miss the secondary shots when Amazon is also selected. | pipeline-runner.ts:569, 697, 709; live-runtime.ts:370 | Emit one output per channel spec, or plan one shot per channel. |
| 2.12 | `amazon.main` names can collide when two assets target it. | registry naming `{sku}.MAIN.jpg`; packager/index.ts:130, 259 | Reject a second main in plan validation (see 1.7), and dedupe names defensively. |
| 2.13 | A failed segmentation (fully opaque cutout) pastes the whole source photo as the "product", and fidelity passes. | live-runtime.ts:368 | Reject masks above about 95 percent coverage or touching all four borders. |
| 2.14 | Harmonize output with a different aspect ratio is centre-cropped and lands out of register. Gemini scene plates ignore the requested size. | composite/index.ts:364-375; live-runtime.ts:119-122 | Reject or letterbox a mismatched aspect ratio. Pass the aspect ratio to the Gemini request. |
| 2.15 | The "measured" background in the compliance badge is the spec constant, not a measurement. Trigger-mode reports also drop pixel measurements, because `deserializeShotOutcome` loses `raw`, `mask` and `edgeMarginPx`. | pipeline-runner.ts:272-283, 675-683 | Use pixelChecks' measured value. Serialize the measured values across the task boundary. |
| 2.16 | Apparel lifestyle can drop to one scene, and 4+ contexts cut off the ghost-style scene. | planner/deterministic.ts:384-388 | Fall through to the shared dedupe and minimum-scene logic. |

Tests to add:
- A live-mode run with a failing loader ends needs_review with no charge.
- A thin-bar fidelity case passes.
- A halo regression: pixels just outside the mask are unchanged from the scene plate.
- A mask-null main image fails.
- 1080x1080 against `meta.feed_4x5` fails.
- The PNG file name extension is correct.
- A pack with 9+ secondary shots is capped at 8.
- Rule 3 stays enforced: extend the existing mask-invariant tests to the live generator path.

## Wave 3: job lifecycle reliability

| # | Problem | Where | Fix |
|---|---|---|---|
| 3.1 | The stale-job check kills live runs and can leave jobs stuck (all three reviews found this). `getJob` fails any non-terminal job with no `updated_at` bump for 30 minutes, then releases all credits. `DbJobStore` only bumps `updated_at` on state changes, and Trigger `batchTriggerAndWait` or failover chains can run longer. When the worker resumes, `setJobState` overwrites `failed`, `charge_credits` raises "exceeds held", the failure path's release raises too, and the job sits in `qc`. The reconcile UPDATE also has no status condition, so it can overwrite a `done`. | apps/web/src/lib/services/db.ts:79, 307-325; trigger/src/db-store.ts:58-66, 89-118 | (a) Heartbeat `generation_jobs.updated_at` in `saveAsset` and step writes. (b) Make the reconcile UPDATE conditional (`WHERE status NOT IN terminal AND updated_at < cutoff RETURNING`). (c) Make `setJobState` refuse to leave a terminal state, and have the worker stop when it sees one. (d) In Trigger mode, check the run status before reconciling. |
| 3.2 | The stale sweep only runs when one job page is opened. Crashed inline runs keep their hold on the dashboard and balance. | db.ts:277-298 | Run the sweep from a scheduled Trigger task, or also in `listRecentJobs` and `creditBalance`. |
| 3.3 | One failing shot fails the whole pack (for example a Photoroom outage throws `AllProvidersFailedError`). Sibling shots keep spending and writing `approved=true` rows into a failed job. | pipeline-runner.ts:995; trigger/src/tasks/generate-pack.ts:41-43 | Catch per shot and return a needs_review outcome, as plan 5.6 describes. |
| 3.4 | The failure path can itself fail. A throw after `state` is `done` makes `transition("done","fail")` throw `IllegalTransitionError`, and the row stays in `packaging`. `applyLedger` also runs before `setJobState`. | pipeline-runner.ts:1034-1060 | Write the failed state first, wrap the release in try/catch, and skip the transition when the state is already terminal. |
| 3.5 | needs_review shots are saved as step status `failed`, so the board shows a red Failed chip. | trigger/src/db-store.ts:115 | Save `needs_review`; `toShotStatus` already maps it. |
| 3.6 | Compliance badges are keyed by `shotType`, so two lifestyle shots show the same verdict, and a passing shot can show a failed sibling's badge. | apps/web/src/lib/services/db.ts:335-352 | Key by `qc.shotId`, as the thumbnail mapping now does. |

Tests to add: a job left idle 31 minutes with a live worker heartbeat is not reconciled; a reconciled job cannot be revived by the worker; one throwing shot gives needs_review while siblings finish; a failure after done leaves a consistent terminal state.

## Wave 4: security and tenancy

| # | Problem | Where | Fix |
|---|---|---|---|
| 4.1 | Cross-tenant file read through R2 keys. RLS `FOR ALL` member policies let any member, including the client role, write `source_media`, `assets` and `asset_variants` rows with any `r2_key` through the browser Supabase client. The pack route then fetches those keys with owner credentials. The client role can also flip `assets.approved`. | packages/db/migrations/0001_rls_and_functions.sql:66-69, 96-105; apps/web/src/app/api/jobs/[id]/pack/route.ts:59; db.ts:476-480 | New migration: make these tables member read-only (writes by the service role only), or add `CHECK (r2_key LIKE 'ws/' \|\| workspace_id \|\| '/%')`. Also filter by `isWorkspaceSourceKey` when reading media. Add RLS tests for both. |
| 4.2 | `saveBrandKit` trusts a client-supplied `logoKey` and skips the role check on first insert. `getBrandKit` then presigns any key. | apps/web/src/lib/services/db.ts:700-734; app/app/brand/actions.ts:6-13 | Require owner, admin or editor, require `isWorkspaceSourceKey(workspaceId, logoKey)`, and zod-parse the kit. |
| 4.3 | Open redirect after login and in the auth callback: `/%5Cevil.com` passes the `startsWith("/")` guard. | apps/web/src/app/auth/callback/route.ts:11-16, 35; components/marketing/auth-form.tsx:35, 106 | Reject backslashes and control characters, and require `new URL(next, origin).origin === origin`. |
| 4.4 | The client role can start checkout and open the billing portal (plan 4.3 says clients cannot bill). | apps/web/src/app/api/billing/checkout/route.ts:74-78; portal/route.ts:26-30 | Return 403 for `role === "client"`. |
| 4.5 | Seller description can close the `<user_description>` tag, allowing prompt injection. | trigger/src/pipeline-runner.ts:770-775 | Escape `<` and `>` in the description before wrapping. |
| 4.6 | The jobs route checks the `ws/{id}/` prefix but the service keeps only `ws/{id}/src/`, so other keys are silently dropped and the user gets a misleading needs_photo. | apps/web/src/app/api/jobs/route.ts:78; db.ts:466 | Use `isWorkspaceSourceKey` in the route and return 403. |
| 4.7 | Non-UUID ids return 500 (Postgres 22P02) instead of 400 or 404. | api/jobs/route.ts:18; uploads/complete/route.ts:15; jobs/[id]/*, files, pack | Use `z.union([z.literal("new"), z.string().uuid()])` for `productId`, and uuid-check route params with a 404 on failure. |

## Wave 5: AI layer and spend caps

| # | Problem | Where | Fix |
|---|---|---|---|
| 5.1 | A timeout makes the router pay for another generation. The router aborts at 60 s while BFL polls for up to 120 s and fal for up to 300 s. The timeout is retryable, so each retry sends a new paid create. Failed attempts are metered at 0. | packages/ai/src/router.ts:42, 334, 344-356; adapters/bflFlux.ts:75-136; adapters/falGateway.ts:81-166; live-runtime.ts:185-186 | Treat a timeout after a successful async create as non retryable (or resume polling the same URL). Give image and video tasks a timeout longer than their polling window. Pass the abort signal into downloads. |
| 5.2 | Live generation skips SpendCaps reservations. The cutout, scene plate and harmonize calls pass no `caps`, and the only check runs after spending. A blocked reservation also drops the spend already made from the global counter, so the $150 hard stop does not stop spend. | live-runtime.ts:354-366, 396; pipeline-runner.ts:577-619; packages/ai/src/caps.ts:91-99 | Pass `image_asset`, `pack` and `global_day` caps into those calls. Always add actual spend to the totals, even when blocked. |
| 5.3 | The Anthropic cost estimate counts base64 image data as text, about 300k tokens per photo. About 75 concurrent analyze calls reach the $150 global stop and every LLM call is then refused. | packages/ai/src/adapters/anthropicLLM.ts:131-140 | Estimate image blocks from pixel size (about w*h/750 tokens) and exclude base64 from the character count. |
| 5.4 | A safety block or empty reply is retried as a transient failure and trips the shared breaker for every workspace. | adapters/geminiImage.ts:112-114; openaiImage.ts:99-101; anthropicLLM.ts:172-174 | Check the block reason and treat it as non retryable. Meter billed usage on failed attempts. |
| 5.5 | An estimate or reserve error escapes the failover chain and leaks the first layer's reservation. | router.ts:133-150, 233, 264 | Wrap both in try. Release the layers already held and continue to the next provider. |
| 5.6 | Success reconciliation can release a reservation twice, driving totals negative. | router.ts:310-320, 359-366 | Set `succeeded` before reconciling. |
| 5.7 | The $50 alert only fires on the generation path, and `alert` is set even on blocked reservations. | router.ts:263-283; caps.ts:151-153 | Add an `onCapAlert` callback to `CallWithFailoverOptions`, and set `alert` only when the reservation is allowed. |

Verify every adapter request and response shape against the provider's official docs before the first paid key (CLAUDE.md rule 7). The merged adapters still carry VERIFY AT FIRST LIVE CALL notes. Record the dates in docs/verification.md.

## Wave 6: app UI and free tools

| # | Problem | Where | Fix |
|---|---|---|---|
| 6.1 | A new Idempotency-Key is generated on every click, so a retry after a lost response creates a second job and a second hold (found by two reviews). | apps/web/src/components/app/new-pack-form.tsx:132 | Keep one key per submission intent in a `useRef`. Reset it after success or when the inputs change. |
| 6.2 | "Create pack" works while the photo is still uploading, so the upload is dropped or an older photo is used. | new-pack-form.tsx:139-141, 359-364 | Disable submit while `upload.phase === "uploading"`. |
| 6.3 | A rejected "New product" job leaves an empty product and its uploads behind; retries add more. Retries also duplicate `source_media` rows, which sends duplicate images to the worker. | apps/web/src/lib/services/db.ts:445-534 | Validate first, then create the product, uploads and job in one transaction. Add a unique index on `(workspace_id, r2_key)` with `onConflictDoNothing`. |
| 6.4 | Job board polling never stops on 401 or 5xx and shows no error. | components/app/job-progress-board.tsx:131-146 | Handle `!response.ok`. Show an error for 401 and 403, and stop after N consecutive failures. |
| 6.5 | Two download buttons disagree. The "Download pack" zip renames files (`main_white-SKU.MAIN.jpg`), ships raw QC as `report.json` and silently skips missing objects. PackDownloads directly below is correct. | job-progress-board.tsx:193-197 vs 243; app/api/jobs/[id]/pack/route.ts:59-79 | Remove the /pack button, or rebuild it from `pack_files` keeping channel folders and original names. |
| 6.6 | Download links expire after 15 minutes on an open page. | components/app/pack-downloads.tsx:32-57; lib/r2.ts:14 | Re-fetch `/files` on click or before expiry. |
| 6.7 | Demo mode rejects products created through `/api/products` and ignores `mode`, so Concept packs reserve marketplace shots. | apps/web/src/lib/services/demo.ts:381, 387 | Include `extraProducts` in the lookup and pass `mode` to `planDemoShots`. |
| 6.8 | Wrong status codes: `uploads/complete` returns 400 for forbidden and unknown product; the portal returns 503 when there is no customer yet; provisioning errors show as 401 "Sign in". | uploads/complete/route.ts:52-54; billing/portal/route.ts:38-45; db.ts:214-218 | Return typed reasons from the service and map them to 403, 404 and 409. Let provisioning errors surface as 500 or 503. |
| 6.9 | Free tools mishandle transparency. The checker reads transparent pixels as black (fill 100 percent), and the fixer keeps the transparent background. | components/marketing/main-image-checker.tsx:59-80; white-background-fixer.tsx:36-42 | Fill the canvas white before `drawImage`. |
| 6.10 | The main image checker hardcodes the 0.85 fill minimum and ignores the 0.90 maximum, so it disagrees with pipeline QC. | main-image-checker.tsx:22-25, 103 | Read the thresholds from `getSpec("amazon.main")`. |
| 6.11 | Auth forms stay stuck on "Sending" after a network error. | components/marketing/password-forms.tsx:27, 99; auth-form.tsx:90-93 | Wrap the Supabase calls in try/catch and set an error state. |
| 6.12 | The dashboard promises "paste a product URL", but the form has no URL input. | apps/web/src/app/app/page.tsx:100 | Drop the URL clause. |
| 6.13 | Returning from Stripe shows no confirmation. | app/app/billing/page.tsx; checkout/route.ts:85-86 | Read `status` and show a success or canceled notice. |
| 6.14 | Accessibility: a Button nested in an anchor, tabs with no tabpanel, and mode buttons without `aria-pressed`. | pack-downloads.tsx:87-115; new-pack-form.tsx:304-331 | Style the anchor with `buttonVariants`, wire tabpanels, and add `aria-pressed`. |

User-facing copy passes rule 9 today; keep it that way in every fix above.

## Wave 7: hygiene that prevents regressions

1. **Video templates cannot pass `video.amazon_listing`.** Its `minWidth` is 1280, but templates render 1080 wide. The `creditsKey` values (`video.template.*`) are not in the `creditCosts` seed. Where: packages/video/src/templates.ts:32-57; remotion/schemas.ts:39-41. Fix: add a 1280+ 16:9 format or drop the target, and point the keys at `templatedVideo`.
2. **Spin360 throws** when there are more images than frames (for example 72 images at 12 fps for 2 s). Where: Spin360.tsx:21, 48; timing.ts:48. Fix: check this in the schema or in `calculateMetadata`.
3. **`extractFrames` returns stale frames** from a reused folder. Where: packages/video/src/ffmpeg.ts:100-106. Fix: use a fresh temp dir.
4. **CLAUDE.md rule 2:** move the scene fallback, the repair prompt prefix and the canvas and fill defaults out of trigger/src/live-runtime.ts:372-381 into the seed templates and the spec registry.
5. **`.env.example`:** add the dynamic `STRIPE_PRICE_{TIER}_{MONTHLY|ANNUAL}` and `STRIPE_PRICE_TOPUP_{N}` names (generate them from `tiers` and `topUps`), plus `NEXT_PUBLIC_POSTHOG_HOST`.
6. **Type safety:** turn on `noUncheckedIndexedAccess` for app code first (apps/web/src/lib/services, trigger/src). About 25 sites, including unguarded `const [inserted] = ... .returning()` in db.ts and `specId` in trigger/src/runtime.ts:146. Pixel loops in packages/pipeline can opt out per file.
7. **Type-check the root files:** add a root `tsconfig.json` covering `e2e/` and `playwright.config.ts` so `pnpm typecheck` checks them.
8. **Smaller items:** deterministic/whiten.ts:323 returns a JPEG still over `maxBytes` without flagging it, and packages/pipeline/src/raw.ts:31 ignores EXIF rotation (only eval uses these today).
9. **iCloud:** the repo lives on an iCloud synced Desktop, which keeps creating `name 2.ext` duplicates in `.next`, `test-results` and even `.git`. Move the working copy off iCloud, or exclude the folder from sync.

## Suggested order and gates

| Order | Wave | Gate before moving on |
|---|---|---|
| 1 | 0 | Production migrated, main pushed, one real pack done end to end |
| 2 | 1 and 4 together | New ledger, billing and RLS tests pass; reviewer agent signs off on RLS and cost caps |
| 3 | 3 | Lifecycle tests pass; no job stuck in a non-terminal state after a forced failure |
| 4 | 2 and 5 | Rule 3 tests extended to the live path; `pnpm eval` shows no regression |
| 5 | 6 | Playwright covers upload then submit, retry idempotency and polling errors |
| 6 | 7 | Strict flags on for app code with zero errors |

Every wave ends with `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` (CLAUDE.md rule 6). Every new table or policy gets an RLS test (rule 5). Record each wave in docs/verification.md.
