# Phase 12: make every feature provably work in production

Date: 2026-09-28. Production: main 448e822 on Render (paid plan), database at migration 0018.

## Why this phase

Every gate passed today (lint, typecheck, 2,100+ unit tests, 71 e2e tests) and production still failed a real seller four times in a row:

| Failure | Why the gates missed it |
| --- | --- |
| Anthropic 401, invalid key | No check that production keys work before a customer spends credits. |
| Intake schema validation failures | Tests use mock providers that always answer in shape. Nothing calls the real model. |
| Instance out of memory, pack stuck in Generating | Tests use tiny synthetic images on a large machine. Nothing runs a 12 to 48 MP phone photo on a 512 MB instance. |
| Pack built from a screenshot, and packs mixing in old uploads | e2e runs in demo mode with a fixed photo. No real device, no real camera roll. |
| Stuck pack never settled | The stale job sweep exists but nothing schedules it. |

The pattern: we verify code, not the running product. This phase adds the checks that would have caught each of these, then walks every feature through them.

## Goals and exit criteria

1. A real product photo, uploaded from a real iPhone and a real Android phone, produces a correct pack on production for each seeded channel, and a person has looked at the output.
2. Any production failure is visible within 5 minutes without anyone opening Render logs by hand.
3. Production configuration (keys, recipes, crons, migrations) matches what the code expects, and the health endpoint says so.
4. Every feature in the matrix below has a named verification method that runs on each deploy or nightly, and each one is green.

## Workstream A: production parity (do first, about 1 day)

| # | Item | Done when |
| --- | --- | --- |
| A1 | Resync recipes. Production reads recipes from the database first; the rows were seeded before today and lack the planner's 8192 token budget and the fallback models. Run `pnpm db:seed` against production (founder approval), and add the new intake prompt version (A5) the same way. | The recipes table matches packages/pipeline/src/seed/recipes.ts; health reports no drift. |
| A2 | Health endpoint reports config drift: recipe rows versus seed (key, version, model, body hash), provider keys present per stage, cron last run times, `CURVI_SHOT_CONCURRENCY`, and the instance memory limit. | `/api/health` lists every mismatch under `warnings`. |
| A3 | Provider key probe: a protected `/api/health/providers` route that makes the cheapest possible call to each configured provider (Anthropic token count, Photoroom account, Gemini model get, BFL credits) and reports ok or the HTTP status. | A bad key shows up before a customer pack, not during one. |
| A4 | Schedule the crons on Render: stale job sweep every 10 minutes, source purge daily, spend digest weekly. Set `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY`. | Health shows each cron's last success within its interval. |
| A5 | Intake screenshot flag as a new intake_normalizer recipe version: `screenshot: boolean` in IntakeImageResult; the runner drops screenshot images and fails with plain copy when none remain. Backs up the ingest check for captures without metadata. Requires `pnpm eval` per the prompt rule. | Eval passes; a screenshot from any phone is refused at ingest or at intake. |
| A6 | Map every runner failure message to seller copy in job-copy.ts (no sellable product, flagged upload, screenshot, cutout refused). Raw provider errors never reach the page. | A test feeds every thrown message through publicJobError and none falls to the generic line unintentionally. |

## Workstream B: real input testing (about 3 days)

| # | Item | Done when |
| --- | --- | --- |
| B1 | Real photo golden set: 20 products Curvi has rights to, shot on phones. Cover a bottle with a label (the Gatorade case), clear glass, shiny metal, apparel flat lay, a small item, a dark item on dark, a multi item photo, a rotated EXIF photo, a 48 MP photo, a JPEG from iOS Safari, a PNG export and 3 screenshots (must be refused). | Files and a manifest with expected outcomes live in eval/golden/real (git LFS or R2, not the repo). |
| B2 | Live eval stage: `pnpm eval --stage live` runs the full pipeline with real providers on a sample of the golden set against staging, and scores label fidelity (OCR of preserveText), product fidelity (the existing fidelity report), channel rules and cost per pack. | A report with pass rate, cost and failures per product; it fails the run on any regression from the last baseline. |
| B3 | Memory test: run B1's 48 MP photos through a pack in a container capped at 512 MB and at the paid plan size, and record peak RSS per stage. | Peak stays under 70 percent of the limit at the chosen `CURVI_SHOT_CONCURRENCY`; the number is in docs/verification.md. |
| B4 | Visual review page: an admin page that shows each golden product next to its outputs, so a person signs off on quality before a release. | Founder sign off recorded per release. |

## Workstream C: staging and release process (about 2 days)

| # | Item | Done when |
| --- | --- | --- |
| C1 | Staging: a second Supabase project and a Render service on a `staging` branch, with low spend caps on real provider keys. | Staging mirrors production config (A2 health is green there). |
| C2 | e2e in db mode: run the Playwright suite against staging with a real database, real uploads to R2 and the live pipeline on one tiny product, not only demo mode. | CI runs it on every merge to staging. |
| C3 | Release flow: merge to staging, run migrations there, C2 and B2 pass, then promote to main. Production migrations stay a founder approved SQL editor step with the guarded bundle used today. | Written in docs/LAUNCH_CHECKLIST.md and followed for the next release. |
| C4 | Post deploy smoke: after each production deploy, a script checks health (commit, migration, warnings), the provider probe (A3) and loads the key pages. | Failure pages the founder. |

## Workstream D: observability (about 1 day)

| # | Item | Done when |
| --- | --- | --- |
| D1 | Sentry for web and runner, with job id, workspace id and stage tags. Needs the founder's Sentry DSN. | A thrown runner error appears in Sentry with its job id. |
| D2 | Record every step failure on job_steps: schema validation issue paths, stop_reason, provider status, which source photo. Today some failures only reach Render logs. | Every failed job has a readable reason in the database. |
| D3 | Admin job timeline: `/app/admin/jobs/[id]` (founder only) showing steps, providers, cost, source photo thumbnail and errors. | Today's investigation would take one page view instead of SQL. |
| D4 | Alerts: pack failure rate above 20 percent in an hour, any job stuck past 30 minutes, daily spend over the cap. Email via Resend when set up, until then a log line plus Sentry. | Each alert fires in a staging drill. |

## Workstream E: device testing (about 1 day, repeat each release)

Test on a real iPhone (Safari) and a real Android phone (Chrome), signed in as a free user:

- Photo picker: camera photo, HEIC original, 48 MP photo, screenshot (must be refused), a photo from the Files app.
- A pack from start to finish with the phone locked part way (polling resumes, the pack ready notice appears).
- Reveal slider, share panel, downloads (zip and single files open on the phone).
- Paywall dialog when out of credits, header balance, low balance nudge.
- Product link import from a Shopify and an Amazon URL.
- Retry a shot, cancel a pack, add a missing angle.
- Settings: data export downloads, account deletion flow (on a throwaway account).

Record results in docs/verification.md with the device, OS and date.

## Feature verification matrix

| Feature | Unit | e2e demo | e2e staging (C2) | Live eval (B2) | Device (E) | Known gap to close |
| --- | --- | --- | --- | --- | --- | --- |
| Upload and ingest (type, 80 MP, EXIF, screenshot) | yes | partial | add | yes | yes | Real HEIC behavior on iOS Safari unverified |
| Product link import | yes | yes | add | no | yes | Amazon pages are best effort; add a blocked page test |
| Intake, analysis, plan (LLM) | mocks | demo | add | yes | no | No real model call in any test (B2 fixes) |
| Cutout, deterministic stills, templates | yes | demo | add | yes | no | Fidelity on real labels unmeasured (B1, B2) |
| Composite and lifestyle (image models) | mocks | demo | add | yes | no | Harmonize on OpenAI is a no op (use /v1/images/edits) |
| QC and fidelity gates | yes | demo | add | yes | no | Thresholds tuned on synthetic images only |
| Packaging, downloads, compliance report | yes | yes | add | yes | yes | Card labels versus file content: the cutout card showed a sweep render on production, check |
| Credits: reserve, charge, release, settle | yes | yes | add | yes | yes | Stale sweep not scheduled (A4) |
| Retry, add angle, cancel | yes | yes | add | no | yes | Follow ups do not update the compliance report |
| Reveal, share, gallery | yes | yes | add | no | yes | Public share pages are off (PUBLIC_SHARE_PAGES_LIVE); gallery has no moderation |
| Paywall and billing | yes | yes | add | no | yes | Stripe not configured, so checkout, portal, cancel offers are untested live |
| Trust: deletion, export, purge, terms record | yes | partial | add | no | yes | Needs SUPABASE_SERVICE_ROLE_KEY and CRON_SECRET |
| Growth: leads, free tools, badge | yes | yes | add | no | yes | Leads are not sent anywhere yet (Loops) |
| Platform: recipe A/B, failover, CSP report, consent | yes | partial | add | no | yes | Recipe drift (A1); CSP only reports |
| Brand kit fonts, logo, preset | yes | partial | add | yes | yes | Logo placement on real products unreviewed |
| SEO, llms.txt, social cards | yes | yes | n/a | n/a | yes | Search Console not connected |

## Order and ownership

1. A1 to A6 now, since they fix live problems or blind spots (engineering, founder approves A1 and A4).
2. D1 and D2 next, so the testing below is observable (founder provides the Sentry DSN).
3. B1 (founder supplies the 20 products and photos) and B3 in parallel with C1.
4. B2, C2, C3, C4 once staging exists.
5. E before every release from then on, D3 and D4 when there is time.
6. Then resume docs/PENDING.md, starting with the Stripe setup, since billing is the largest untested live surface.

## Founder decisions and inputs needed

- Approve running `pnpm db:seed` against production (A1).
- Set `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` and create the Render cron jobs (A4).
- A Sentry project and DSN (D1).
- 20 products to photograph for the golden set, or permission to use specific public product images (B1).
- Budget for staging provider spend (C1), suggested cap $20 a day.
- Chosen `CURVI_SHOT_CONCURRENCY` for the paid instance, after B3.

## A6 failure copy inventory

Every string the runner and the web app can store as `generation_jobs.error` (job level) or as a shot's repair hint or step error (shot level), and the seller copy it maps to. Job level copy lives in `JOB_ERROR_COPY` in apps/web/src/lib/job-copy.ts (`publicJobError`, first matching rule wins); shot level copy in `needsReviewNote` and `skippedCopy`. `apps/web/src/lib/job-copy-failures.test.ts` feeds each message below, with realistic provider variants, through the mapping and fails if any output names a provider, an HTTP status, JSON or engineering words.

A failed pack is never charged: the runner charges passing shots only after the pack is saved, and its failure path releases the whole hold (`releaseRemainderOnFailure` and `releaseAllHeld`); the web app's settle and reconcile paths call `release_credits`. So every job level row is "No".

### Job level (`publicJobError`)

| Stored message pattern | Where it is thrown or written | Seller copy (`JOB_ERROR_COPY` key) | Charged |
| --- | --- | --- | --- |
| contains "screenshot" or "screen capture" | ingest refusal (packages/pipeline ingest/image.ts), runner screenshot gate (in flight) | `screenshot`: looks like a screenshot, take a camera photo, start a new pack | No |
| "Intake found no sellable product in the uploaded images" | trigger/src/pipeline-runner.ts intake gate | `noProduct`: no product found, take a clear photo of just the product | No |
| "This upload was flagged for ... and needs a manual review before a pack can run" | pipeline-runner.ts intake moderation gate | `flagged`: flagged for manual review, email us if a mistake | No |
| "This product was flagged for ... and needs a manual review before a pack can run" | pipeline-runner.ts analysis moderation gate | `flagged` | No |
| "Intake response failed schema validation" | pipeline-runner.ts intake | `readFailed`: could not read your product, our side, try again in a few minutes | No |
| "Product analysis response failed schema validation" | pipeline-runner.ts analyze | `readFailed` | No |
| PLAN_FAILED_MESSAGE "We could not plan the shots for this product, so nothing was charged." | pipeline-runner.ts planner | `planFailed` | No |
| "No shots could be planned for the channels you picked, so nothing was charged." | pipeline-runner.ts noShotPassedMessage | `noShotsPlanned`: try other channels | No |
| "None of the shots in this pack passed its checks, so nothing was charged. ..." | pipeline-runner.ts noShotPassedMessage | `noShotPassed`: each shot says why, a sharp photo on a plain background helps | No |
| "None of the shots in this pack could be made, so nothing was charged. The first error was: <raw>" | pipeline-runner.ts noShotPassedMessage | classified by the raw tail (`setup` or `serviceBusy`), else `noShotsMade` | No |
| "None of the shots in this pack could be delivered, so nothing was charged." | pipeline-runner.ts after buildPack | `notDelivered`: our side, try again in a few minutes | No |
| "Pack storage is not configured, so the pack/files could not be delivered." | trigger/src/db-store.ts savePack, saveFiles | `notDelivered` | No |
| "We could not separate the product from its background ..." / "The cutout found no product ..." | trigger/src/live-runtime.ts cutout refusals (shot level; mapped at job level too) | `cutout` / `noProduct` | No |
| "All providers failed for task ...: <p> responded 401/403/400/402/404 ..." or api key, authentication, permission, unauthorized | packages/ai AllProvidersFailedError over adapters/shared.ts requestJson, photoroomCutout.ts | `setup`: problem on our side, not with your photo, try later, email us if it keeps happening | No |
| provider "is not registered", "does not support task", "No providers routed", "does not implement estimateCostMicros", "Cost estimate failed", "has no price table", "exceeds maxCostMicros", "needs an API key", "No active recipe seeded" | packages/ai router.ts, registry.ts, adapters; pipeline-runner.ts and recipes.ts | `setup` | No |
| "... responded 5xx/408/429", "timed out after", "Circuit breaker open for", "Network error calling", empty outputs ("no images", "no text or tool_use block", "no polling_url", "ended with status"), any other "All providers failed" | packages/ai router.ts ProviderTimeoutError, BreakerOpenError, adapters | `serviceBusy`: a service we use is busy or not responding, try again in a few minutes | No |
| "declined", "blocked the prompt", "stop_reason refusal", "Content Moderated" (code content_blocked) | adapters geminiImage.ts, anthropicLLM.ts, bflFlux.ts, openaiImage.ts | `contentBlocked`: would not make images from this photo under its content rules, try a different photo | No |
| "Spend cap blocked call: ... caps:workspace:<id>:<day> ..." | packages/ai caps.ts via router.ts | `workspaceDayCap`: daily limit, try tomorrow or email us | No |
| "Spend cap blocked call: ... caps:global:<day> ..." | caps.ts via router.ts | `globalDayCap`: our daily safety limit, try tomorrow | No |
| "Spend cap blocked call: ... caps:pack:/caps:asset: ...", "Cost cap reached: ...", "spending limit" | caps.ts via router.ts, pipeline-runner.ts settleGenerationSpend and PACK_CAP_REACHED | `packCap`: safety limit, try fewer channels | No |
| "Spend cap blocked call: the spend cap reservation could not be made (Spend cap counter ... could not be updated)" | packages/ai types.ts CapStoreUnavailableError, trigger/src/cap-store.ts | `setup` | No |
| "Illegal transition ...", "Credits were already reserved ...", "Reserve amount must be positive ...", "Cannot <verb> before reserving", "... of the reservation is outstanding" | trigger/src/state.ts | `internal`: error on our side, run it again | No |
| SETTLED_JOB_MESSAGES crashed / not_started / interrupted / timed_out | apps/web/src/lib/jobs/enqueue.ts | `internal` / `notStarted` / `restarted` / `timedOut` | No |
| RECONCILED_JOB_ERROR "The run was interrupted before finishing ..." | apps/web/src/lib/services/reconcile.ts | `interrupted` | No |
| "The pack could not be queued." | apps/web/src/lib/services/db.ts abandonJob | `notQueued`: try again in a minute | No |
| "Job <id> was already finished or failed elsewhere, so this run stopped" | pipeline-runner.ts JobAbandonedError (written only if the row was not already terminal) | `stopped` | No |
| "credit reservation failed", "insufficient credit balance for workspace ..." | services/db.ts ReservationError, reserve_credits SQL | `credits`: not enough credits, top up or pick fewer channels | No (nothing held) |
| anything else | | `generic`: something went wrong, credits held went back | No |

### Shot level (`needsReviewNote`, `skippedCopy`)

Every shot note ends "No credits were charged for it." and never repeats the stored hint.

| Stored hint pattern | Where | Note |
| --- | --- | --- |
| SHOT_PROVIDER_TROUBLE, SHOT_CONTENT_BLOCKED, SHOT_CHANNEL_FULL, SHOT_NOT_DELIVERED, HARMONIZE_SHAPE_REFUSED | pipeline-runner.ts, live-runtime.ts | own reason each (unchanged) |
| "We could not separate the product from its background ..." (SEGMENTATION_FAILED) | live-runtime.ts segmentationRefusal | separate the product, sharp photo on a plain background (new) |
| "The cutout found no product ...", "This image has no product to place ...", "source photo ...", "does not point at one of this product's photos" | live-runtime.ts, live-deterministic.ts, shot-outputs.ts | could not find the product clearly (no product to place is new) |
| "The product would be cut off at this channel's shape ..." | shot-outputs.ts | cut off at this channel's shape (new) |
| "This image could not be prepared for this/another channel ..." | pipeline-runner.ts derive, live-runtime.ts | could not prepare this image for this channel (new) |
| contains "screenshot" | future runner or cutout hint | looks like a screenshot, take a camera photo (new) |
| "Spend cap reached before ...", "Cost cap reached: ...", PACK_CAP_REACHED | live-runtime.ts, pipeline-runner.ts | spending or safety limit |
| "... not produced by live providers yet", "from the product photo alone yet", "... not configured" | live-runtime.ts, live-deterministic.ts | we do not make this kind of shot yet |
| channel rule refusals (text, plain background, laid out, rendered, format and size, larger than allowed, nothing to show, no channel to size) | live-runtime.ts, live-deterministic.ts, shot-outputs.ts | could not meet this channel's image rules |
| "The job was stopped before this shot finished." | pipeline-runner.ts | the pack stopped before this shot finished |
| "We could not check this shot ...", "Spend cap reached before this shot could be checked." | pipeline-runner.ts | own reason each |
| planner skip reasons (needs photo, plan tier, provider not enabled, concept mode, shot cap, channel image limit, benefits, dimensions, contents, comparison) | packages/pipeline planner | `skippedCopy` labels (unchanged) |

Not stored as a job error and so out of scope: follow up failures (trigger/src/follow-up.ts puts the job back to done and logs), "This store cannot deliver follow up files." and packages/pipeline composite, template and whitening internals, which surface only through the shot refusals above.

Surfaces: the pack page (JobProgressBoard) reads `job.error` from GET /api/jobs/[id], which is `DbService.getJob` and already mapped through `publicJobError`; the dashboard and GET /api/jobs/recent list only title and status. No surface on main, or on the deployed e89d8f9, renders `generation_jobs.error` raw: both map it through `publicJobError`, which on e89d8f9 turned the 401 chain into the generic line. The raw 401 text in the production report most likely came from the row itself or the logs. db.test.ts now pins the pack page view and the dashboard list against the raw 401 chain.
