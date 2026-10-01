
# Phase 18: prove the pixels, count every user, and protect the spend

Date: 2026-10-01. Source: the founder's request for a minimal spend marketing plan, the research report `reports/Curvi low cost marketing plan.md` and its notes in `research_notes/Curvi low cost marketing plan/`. The marketing plan itself is `docs/marketing.md` (written in parallel); this file holds only the product and code changes that plan needs.

This file is written for the AI developer who will build it. Read it in full before the first change (CLAUDE.md rule 1). Every "today" claim below was checked in the code on main at ccbd555 plus the uncommitted working tree of 2026-10-01 (render.yaml and three docs changed) and the unmerged `site-visitors` branch. Every external fact must be checked again and dated in docs/verification.md before code relies on it (rule 7).

Review applied 2026-10-01. An adversarial review checked this draft against the code and against docs/phases/PHASE_19.md. Each of its findings was checked again in the code and applied to the matching item; "Review changes" below lists them. Item IDs P18-01 to P18-25 did not change, because docs/marketing.md section 14 maps to them by ID and name. Two items have new names (P18-11, P18-16), P18-25 moved to PHASE_19 with its ID kept, and parts of P18-09, P18-10 and P18-11 moved to PHASE_19 or the backlog. Every item ends with an "Enables" line naming the docs/marketing.md tasks (MKT-xxx) that depend on it.

Short names for the evidence used throughout:

| Short name | File |
| --- | --- |
| R | reports/Curvi low cost marketing plan.md |
| N-impl | research_notes/Curvi low cost marketing plan/curvi_implementation.md |
| N-trust | research_notes/Curvi low cost marketing plan/curvi_trust_and_compliance_inventory.md |
| N-acq | research_notes/Curvi low cost marketing plan/low_cost_acquisition_tactics.md |
| N-early | research_notes/Curvi low cost marketing plan/early_traction_and_validation.md |
| N-ads | research_notes/Curvi low cost marketing plan/saas_paid_advertising_2026.md |
| N-market | research_notes/Curvi low cost marketing plan/ecommerce_seller_market.md |
| N-comp | research_notes/Curvi low cost marketing plan/ai_image_tool_competitors.md |

## Goal

Give the 90 day experiment in docs/marketing.md a product that can be measured, cannot waste a visitor, and shows its one unique proof. Concretely:

1. Every signup carries its source, and the founder gets a weekly funnel by source without opening a dashboard.
2. No marketing link ever sends a visitor into a product that cannot make a pack.
3. The founder can hand make a free pack for a prospect in minutes and know whether that prospect came back.
4. The fidelity gate's measured numbers, computed on every file today and then thrown away, become visible proof on the pack page, the report, the API and opt in share pages.
5. A signup who does not finish a pack is contacted again, by email, within days.
6. The cheapest search and community entry points (the free checker for every marketplace main, a store audit, a free white main image before signup) send visitors into that funnel. Agent entry points (the ChatGPT and Codex plugin, the MCP Registry, the live API copy) are PHASE_19's.

## Why now

The founder doubts Curvi can get any users. R's conclusion is that "today zero is guaranteed by the setup, not proven by the market": the cutout balance was exhausted, product analytics are off, signups carry no source and nobody who signs up or leaves an email is contacted again (R, "Curvi's funnel cannot yet make, count or follow up a single user"; N-impl sections 6, 7 and 10). The evidence says the first users come from founder hours, not ads: hand made packs for 30 to 50 multichannel sellers of labeled goods, short "label test" videos, community answers and free tools (R, "Founder hours, not ad dollars"; N-acq sections 1, 6, 7 and 8). Paid ads at benchmark rates cost $550 to $3,100 per paying customer (R, "Paid ads are a capped message test"; N-ads section 4), so every dollar Phase 18 protects or every visitor it keeps is worth more than any ad. The dated gates in R (day 14 usable packs, day 30 first payments, day 60 repeat use, day 90 a repeatable channel) can only be read if this phase ships first.

Three corrections to the brief that change the plan:

- The 2026-12-31 date is the founder's OpenAI provider credit, not seller credits (apps/web/src/lib/llm-spend.ts lines 5 to 7, PHASE_17 founder decision 4). Seller credits do not expire on that date or any shared date: subscription grants never expire, because the webhook writes them with no expiry (apps/web/src/lib/marketing-facts.ts, the comment on `UNUSED_CREDITS_SENTENCE`, lines 103 to 110), and each top up expires `expiresMonths` (12) after purchase (packages/pipeline/src/seed/credits.ts `topUps`, lines 333 and 334; marketing-facts.ts `topUpMonths`, line 99). No Phase 18 copy may use "before your credits expire" urgency.
- The web service is no longer on Render's free plan. render.yaml says `plan: 1c-2g` and `CURVI_INLINE_PACK_CONCURRENCY` "2" in the uncommitted working tree, and docs/LAUNCH_CHECKLIST.md step 9 records the upgrade as done on 2026-10-01. The research notes predate that. Two founder steps remain: commit that render.yaml change so the repo matches the service, and set `CURVI_INLINE_PACK_CONCURRENCY` = 2 and `maxShutdownDelaySeconds` 300 in the dashboard, because the hand made service ignores render.yaml (LAUNCH_CHECKLIST steps 8 and 9; PHASE_19 decision 13).
- Migration 0027 is already taken. The unmerged `site-visitors` branch holds `0027_site_visits` (a cookieless page view count with path, referrer host, UTM tags and device, shown at /app/ops/visitors to the emails in `OPS_EMAILS`), and PHASE_19 adds `mcp_connections` at the next free number. Every migration in this file is therefore named, not numbered, and takes the next free number when it is generated (principle 10).

## Scope

25 item IDs in eight workstreams, P18-01 to P18-25, ranked by expected effect on acquisition, activation, conversion, retention or referral per unit of build effort and running cost. 24 are built in this phase (P18-11 only in part); P18-25 moved to PHASE_19 and its ID stays reserved. Item IDs are stable: they follow the draft's overall rank, the detail sections group them by workstream, and docs/marketing.md section 14 maps to them by ID and name.

Priority, set per item in "Ranked items":

| Priority | Meaning |
| --- | --- |
| P0 | Ships in Release 1, before any promotion sends strangers to the site |
| P1 | Ships in Releases 2 and 3 |
| P2 | Waits for the day 14 or day 30 gate, or for a founder step named in the item |
| P3 | Built only if the paid message test or the OpenAI Ads test runs (docs/marketing.md D-001, MKT-047, MKT-048) |
| Moved | The work belongs to PHASE_19; the ID is kept so references do not shift |

## Review changes (2026-10-01)

Each change below was checked in the code before it was applied.

1. **PHASE_19 owns the agent surfaces.** PHASE_19 builds the ChatGPT and Codex plugin, the MCP Registry listing (P19-28), the `agentApi` flip and llms.txt (P19-24), the MCP tool changes (P19-13 to P19-18) and the MCP reviewer pass (P19-27), and its decision 2 is OAuth on every tool with no anonymous tools. So P18-25 (ChatGPT app) moved whole; P18-11 lost the keyless check, `server.json`, the registry listing, the `agentApi` flip, llms.txt and the /developers page, and keeps only the URL import flip and the Growth API line (renamed "URL import live and the Growth API line"); P18-10's API and MCP `channel` parameter waits for PHASE_19's tool work.
2. **Migrations are named, not numbered** (third correction above; principle 10).
3. **One signup link builder.** `signupHref` already exists in apps/web/src/lib/billing/intent.ts (line 57, used only by pricing-tiers.tsx). P18-01 extends it instead of adding a second function with the same name, and lists every bare `/signup` link by file and line.
4. **One operator allowlist.** The `site-visitors` branch adds `isOperator` over `OPS_EMAILS` (apps/web/src/lib/ops.ts there). Decision 15 now reuses it instead of a new `CURVI_STAFF_USER_IDS`, and the staff pages move under /app/ops.
5. **No new vendor for funnel events.** The `events` table exists (packages/db/src/schema.ts line 702, RLS since 0001, member policies since 0002), billing already writes to it, `events_billing_dedupe_uq` (0003) is the pattern for the "first" index, and apps/web has only posthog-js, no posthog-node. Client events already exist (pack_created, pack_downloaded, lead_captured, checkout_started, pricing_cta_clicked, paywall_shown and others), so the server events cover only what the client cannot see.
6. **Lead notice.** The email gate has said "We keep your email to follow up about Curvi, and never sell it" since lead capture shipped on 2026-09-28 (apps/web/src/components/marketing/email-gate.tsx line 132). Decision 5 no longer says leads were never told about email; its default is unchanged.
7. **Email provider.** docs/PENDING.md and the CLAUDE.md stack name Loops for lifecycle email; decision 3 now records Resend over Loops explicitly and updates PENDING when P18-06 merges.
8. **Fidelity numbers need no migration** (`assets.qc` is jsonb), and the packager's compliance-report.json has no fidelity entry today; P18-08 cites the exact lines. The MCP view of the numbers goes through PHASE_19's chat views (P19-14).
9. **Heatmaps.** A per file heatmap in production adds a render in `checkGeneration` and an R2 object per file, on the strength of one research suggestion. P18-16 keeps the proof panel (renamed "Product proof on share pages: report panel"); the heatmap is built only for the offline benchmark in P18-17, and per file heatmaps moved to the backlog.
10. **Jewelry scene and people check.** "scale on hand" sits in the deterministic planner and in the shared shot_planner prompt in the seed (rule 2), so P18-09 part 3 ships a new prompt constant and recipe version with eval and canary. The `person_present` judge issue changes the qc_judge response schema and no jewelry output was ever inspected, so part 4 became an inspection and the judge change moved to the backlog.
11. **Checker pages.** Requirement pages already exist for every spec (`/channels/[channel]/image-requirements`). P18-10 adds a channel picker and links from those pages instead of new per channel routes.
12. **Conditions made explicit.** P18-12 starts only once fal is funded and Upstash is set (the per IP limit is per process without Upstash). P18-15 is P3: only its missing docs/verification.md row ships now. P18-17 needs fal funded. P18-21 and P18-24 wait for the founder's generative still price decision (new decision 18).
13. **Referrals need a migration.** The `referrals` table keys on `code` with one `referred_workspace_id`, so R's "reuse the existing table" is overstated; P18-24 says so.
14. **Cron cost.** New scheduled routes join an existing cron command where the schedule fits, so Phase 18 adds at most one $1 a month Render cron service.
15. **Founding seats.** CURVI_BUILD_PLAN.md says 50 seats in the outreach script (line 544) and 100 in section 9.7 (line 622); the seed says 50 (credits.ts line 342).

## Non goals

- **No paid acquisition build.** No Meta, Reddit or Google pixel or conversions API. The only paid test R supports is a capped $100 to $200 message test after the day 14 and day 30 gates, judged by UTM tagged signups (R, "Paid ads are a capped message test"; N-ads section 8). OpenAI Ads conversions already exist and are made reliable only if an ads test runs (P18-15, P3).
- **Nothing PHASE_19 owns.** The ChatGPT and Codex plugin, OAuth for the MCP endpoint, the MCP Registry listing (P19-28), the `agentApi` flip, llms.txt and the agent help article (P19-24), MCP tool changes (P19-13 to P19-18) and the MCP reviewer pass (P19-27). PHASE_19 decision 2 puts sign in on every tool with no anonymous tools, so this phase adds no keyless API or MCP access.
- **No Shopify app.** App Store distribution needs Shopify billing ("Apps that use off-platform billing cannot be distributed through the Shopify App store"), an embedded app and a review queue that ran one to four months in 2026 (N-acq section 5; R, last section). That is a second billing path and weeks of review for an unproven funnel. Revisit after the day 90 gate.
- **No Canva app, Zapier integration, Etsy or eBay integration, affiliate software (Rewardful, FirstPromoter, Tolt), AppSumo deal or Futurepedia listing** (N-acq sections 5, 9 and 10; R, "Founder hours").
- **No C2PA signing** (needs a signing certificate; N-trust section 4).
- **No video, UGC or on model people.** Scenes keep "no people" (packages/pipeline/src/seed/templates.ts line 27).
- **No new seasonal scene recipe.** A "Cozy holiday" mood with the `holiday` preset already exists (packages/pipeline/src/seed/questions.ts line 116, templates.ts line 14). The Q4 push uses it as is.
- **No price changes in this phase.** Repricing generative stills is an open pricing decision (docs/PENDING.md, "Pricing decisions"); Phase 18 only makes the existing seed prices visible per pack (P18-21). See founder decisions 14 and 18.
- **No prompt rewrites** beyond the one line shot_planner change in P18-09 part 3, shipped as a new recipe version at `trafficPct: 0` and canaried, as in Phase 17. The qc_judge change for a person check moved to the backlog.

## Founder decisions

Open on 2026-10-01. Each has a recommended default that the builder uses unless the founder writes a different answer here. A change to a number lands in the seed (rule 2), not in code.

1. **ChatGPT ads $500 offer.** The offer is a spend match, not a grant, and $25 a day for 14 days is $350, short of $500 (R, "Paid ads"; N-ads section 2). Default: let it lapse and leave the campaign without creatives. Run ads only after the day 30 gate, with P18-15 and P18-22 live.
2. **Attribution and consent.** Default: (a) an optional "How did you hear about Curvi?" field on signup for everyone; (b) UTM, `ref` and share slug parameters read from the current page URL and forwarded on the signup link without storing anything; (c) a first touch cookie `curvi_ft` only after the visitor accepts cookies. No attribution storage before consent.
3. **Email provider.** Default: Resend directly, already wired for founder mail through plain fetch (trigger/src/digest.ts `RESEND_EMAILS_URL`; trigger/src/spend-alerts.ts `sendFounderEmail`). docs/PENDING.md ("Hosting and messaging") and the CLAUDE.md stack list Loops for lifecycle email; this decision chooses Resend over Loops for Phase 18, and the P18-06 merge updates that PENDING line to say so. No Loops account in this phase.
4. **Postal address in marketing email.** CAN-SPAM requires a valid physical postal address in commercial email (N-acq section 8). Default: the founder supplies a PO box or virtual mailbox address before any marketing email is sent; transactional mail (pack ready, receipts) goes out without waiting.
5. **Emailing existing leads.** Rows in `leads` were collected under the notice "We keep your email to follow up about Curvi, and never sell it. Ask us to delete it any time." (apps/web/src/components/marketing/email-gate.tsx line 132, shown since lead capture shipped on 2026-09-28). That notice covers a follow up about Curvi; it is not a clear opt in to recurring tips and offers. Default: no marketing email to any lead captured before the consent box in P18-06 ships. New leads see the box. The founder may instead approve one plain follow up to earlier leads under that notice, with the unsubscribe footer; if so, record it here.
6. **Free white main image before signup (P18-12).** Default: the preview (about 1000 pixels, the measured checks and the fidelity numbers) is free with no email; the full size file needs an email; the full pack needs an account. Caps: 3 previews per IP per UTC day, 300 per day site wide (about $3 a day of cutouts at the seeded $0.01), automatically off while packs are paused. Built only once fal is funded and Upstash is set (P18-12).
7. **Bot protection.** Default: rate limits, the honeypot field and the global cap only. Add Cloudflare Turnstile (free, rule 7 check first) only if abuse shows in the counters.
8. **fal balance lines.** Default: founder alert below $15, acquisition pause below $3, both seeded in packages/pipeline/src/seed/monitoring.ts. One fal account with a balance probe; `FAL_KEY_BACKUP` stays optional (it already fails over; packages/pipeline/src/seed/models.ts line 196).
9. **Public proof on share pages (P18-16).** Default: off for seller shares (the owner opts in per share); on for operator prospect shares made with P18-04.
10. **General model comparison on the benchmark page (P18-17).** Default: yes. The founder makes the general model images by hand in ChatGPT (no code calls a general model for this), and the page states the date, the model name shown in the product and the exact instruction used.
11. **Prospect claim reward (P18-04).** Default: no extra credits. Claiming attributes the signup to the outreach, imports the prospect's product into their new workspace and points them at a first pack paid by the normal 15 credit grant.
12. **Referral reward (P18-24).** Default: 50 credits to each side when the referred workspace makes its first payment (plan 9.6.2), at most 10 rewarded referrals per referrer per calendar month, reward credits expire after 12 months like top ups.
13. **Founding member offer (P18-21).** The seed says 50 seats at $19 a month for life (credits.ts line 342, `foundingMemberOffer`). CURVI_BUILD_PLAN.md says 50 in the outreach script (line 544) and 100 in section 9.7 (line 622). Default: 50 seats, open until 2026-11-30 or until the seats are gone, delivered as a Stripe promotion code on Starter monthly and annual.
14. **Money back promise.** Terms say fees are non refundable (https://curvi.ai/terms). Default: "If your first paid month does not work for you, email us within 14 days and we refund it", shipped only after the legal review in LAUNCH_CHECKLIST step 1. Repricing generative stills is decision 18; it does not block the rest of this phase.
15. **Operator identity.** Default: reuse the operator gate from the `site-visitors` branch: `isOperator(user)` in apps/web/src/lib/ops.ts, true only for a signed in user whose confirmed email is in the server only `OPS_EMAILS` list; pages answer 404 to everyone else. It gates the operator routes in P18-04 (under /app/ops, beside /app/ops/visitors) and the gallery label in P18-14. If `site-visitors` has not merged when this phase starts, the contract commit adds that same helper unchanged, so there is one allowlist, not two. No admin role in the database.
16. **ChatGPT app.** Moved to PHASE_19 with P18-25. PHASE_19 decisions 2 and 12 settle it (sign in on every tool; the official MCP Registry is the only secondary listing). The number stays so the decisions below keep theirs.
17. **PostHog.** Default: set `NEXT_PUBLIC_POSTHOG_KEY` (LAUNCH_CHECKLIST step 12) and also write the server side funnel to Curvi's own `events` table (P18-02), which needs no consent banner answer and is the source of truth for the weekly funnel email. A server side PostHog mirror is sent only for users whose stored consent is granted. apps/web has posthog-js only (no posthog-node), so a mirror would be one plain fetch after the rule 7 check; it stays off by default.
18. **Generative still price before credit giveaways.** A generative still sells for about $0.08 to $0.145 a credit and costs about $0.17 to make (docs/PENDING.md, "Pricing decisions"), so every free or discounted credit spent on scenes loses money. Default: the founder decides that repricing before the founding offer goes public (P18-21) and before referral rewards switch on (P18-24); operator prospect credits (P18-04) stay under their monthly cap meanwhile. Any change is a seed change (rule 2), not Phase 18 code.

## Principles (apply to every item)

1. **Rule 2.** Every price, credit amount, cap, threshold, schedule delay and reward lives in the seed: a new `packages/pipeline/src/seed/growth.ts` for growth numbers, `monitoring.ts` for balance lines, `credits.ts` for offers and rewards. Runtime switches are `platform_settings` rows seeded by `pnpm db:seed`, read through the cached reader pattern in apps/web/src/lib/features.ts (`outputOptionsSwitchOn`).
2. **Rule 3.** Every new image path (the free preview, the prospect pack, the benchmark) places the real cutout with the existing deterministic renderers and passes `fidelityReport` on the final encoded bytes. No new code calls an image model on product pixels.
3. **Rule 4.** Every provider call (the preview cutout, the intake moderation call, the fal balance probe) goes through packages/ai. Email (Resend) and Stripe are not AI providers and keep their existing plain fetch and SDK paths.
4. **Rule 5.** Every new tenant table has `workspace_id`, RLS and a test in packages/db/src. Anonymous or platform tables follow the `leads` precedent (RLS on, no policies, no client privileges, a test that anon, authenticated and members cannot read or write).
5. **Rule 7.** Every external shape in the next section gets a dated docs/verification.md row before code uses it.
6. **Rule 8.** No secrets in the repo. New variables are listed in docs/LAUNCH_CHECKLIST.md with what happens when unset; the founder adds them to `.env.example` by hand, because env files are blocked for the agents (docs/PENDING.md, "Small leftovers from batch 1").
7. **Rule 9.** Every user facing string (UI, email, page copy, ads copy, share text, API messages) is plain spoken, with no emojis, no arrows and no dashes used as punctuation. Each new copy module gets a lint test like apps/web/src/components/marketing/claims.test.ts. Hyphenated compound words are fine.
8. **Claims guard.** New copy goes through `unqualifiedClaims()` (apps/web/src/lib/marketing-facts.ts), and no copy claims a feature whose flag is `coming_soon`.
9. **Funnel events.** Every item that changes a step of the funnel emits its events through the P18-02 helper, so the weekly email shows its effect without new code.
10. **Migrations take the next free number at build time.** Migrations here are named (for example `attribution_and_funnel`), never numbered in advance. A lane runs `pnpm db:generate` only after rebasing on the newest main, so its file follows the newest migration on main and any branch that merges first (`0027_site_visits` on `site-visitors`; PHASE_19's `mcp_connections`). If another migration lands first, renumber the file, regenerate the Drizzle journal and snapshot in packages/db/migrations/meta, and rerun the packages/db tests before merging. Production applies them in numeric order.
11. **PHASE_19 boundary.** Where an item touches files PHASE_19 owns during its build (apps/web/src/lib/api-v1/actions.ts, the MCP tool definitions and chat views, lib/llms.ts flags, auth-form.tsx and the auth callback), the lane that merges second rebases; Phase 18 never adds anonymous access to the API or MCP server.

## External facts to verify first (rule 7)

| Fact | Status on 2026-10-01 | Used by |
| --- | --- | --- |
| fal account balance: `GET https://api.fal.ai/v1/account/billing?expand=credits`, header `Authorization: Key <admin key>`, response `credits.current_balance` (number) and `credits.currency`. Needs an Admin API key. | Read on fal.ai/docs/platform-apis/v1/account/billing.md on 2026-10-01 for this plan. Record it; confirm with one call using a real admin key. | P18-03 |
| OpenAI Ads Conversions API: the existing shape (`POST https://bzr.openai.com/v1/events?pid=<pixel id>`, Bearer conversion key, `validate_only`, `events[{ id, type }]`); event `type` values Ads Manager accepts beyond `registration_completed`, whether a purchase event carries value and currency, whether landing URLs carry a click identifier the API accepts, and whether campaigns can be paused by API. | Not verified. apps/web/src/lib/ads-conversions.ts lines 5 to 7 say the shape was checked 2026-10-01, but docs/verification.md has no row for it (a rule 7 gap). The row for the existing shape ships in Release 1 whether or not ads run; the rest only if P18-15 is built. | P18-15, P18-03 |
| Supabase Google OAuth: provider setup, redirect URL, `signInWithOAuth` options, and whether OAuth users arrive with `email_confirmed_at` already set (which decides whether the 0012 grant pays on insert). | Not verified. | P18-13 |
| Resend: free tier daily and monthly send limits, custom headers on `POST /emails` (for `List-Unsubscribe` and `List-Unsubscribe-Post`), and the batch endpoint if used. | Partly verified (send shape, docs/verification.md line 185). Limits and headers not. | P18-06 |
| Gmail sender guidelines (authentication, spam rate under 0.3 percent, one click unsubscribe for bulk senders) and RFC 8058 header format. | Read by the research (N-acq section 8). Re-read. | P18-06 |
| CAN-SPAM: postal address, opt out honored within 10 business days, identify as an ad. | Read by the research (N-acq section 8, FTC guide). Re-read. | P18-06, P18-07 |
| Stripe: where a Checkout Session reports the promotion code it used (`discounts` and `total_details.amount_discount` on the completed session), and promotion code `max_redemptions` and `times_redeemed`. | Not verified. | P18-21 |
| Shopify storefront `/products.json` (public product list, paging parameters, whether stores can turn it off) and polite request rates. | Not verified. lib/url-import parses single product JSON already. | P18-18 |
| Google Merchant Center AI image metadata (IPTC DigitalSourceType, accepted values, "Don't remove embedded metadata"). | Read 2026-10-01 (N-trust section 4); docs/verification.md line 41 holds the older row. Refresh the date. | P18-09, P18-19 |
| Amazon `contains-synthetic-performer` label (field, scope, New York GBL 396-b). | Secondary sources only (N-trust section 5). Read an Amazon page before any copy names it. | P18-09, P18-19 |
| Walmart Marketplace and TikTok Shop US main image rules. | `walmart.main` and `tiktokshop.main` are `verified: false` in packages/specs/src/registry.json, though both are `live` in `CHANNEL_SPECS`. docs/verification.md line 229 sources Walmart from search snippets only (the page did not render); line 228 sources TikTok Shop from its Product Listing Policy. | P18-09, P18-10 |
| Share intent URLs for X, LinkedIn, Pinterest and Reddit. | Not verified. | P18-14 |
| Competitor facts for new comparison pages (each tool's own site, dated), and the Soona and Fiverr prices used in price framing. | competitor-facts.ts was checked 2026-09-29; new tools (Pomelli) and any price need new rows. | P18-19, P18-21 |
| Cloudflare R2 lifecycle rule on the `anon/` prefix (expire after N days). | Not verified. | P18-12 |
| PostHog server capture endpoint and payload (only if decision 17 keeps the mirror). | Not verified. | P18-02 |

Rows for the MCP Registry `server.json` and OpenAI's app submission rules moved to PHASE_19 with the work that needs them (P19-01 records every PHASE_19 fact; P19-28 the registry).

## Starting point (verified in the code on main ccbd555 and the 2026-10-01 working tree)

| Area | Today | Where |
| --- | --- | --- |
| Signup | Email and password only (`supabase.auth.signUp`), confirmation required; `signup_source` and `plan_intent` go into user metadata (auth-form.tsx line 139) and nothing reads them; the only `source=` value the site sends is `pricing`, through the existing `signupHref({ plan, cadence, source })` (billing/intent.ts lines 57 to 65, used only by pricing-tiers.tsx). No OAuth call anywhere. | apps/web/src/components/marketing/auth-form.tsx lines 127 to 145; apps/web/src/lib/billing/intent.ts; apps/web/src/lib/safe-next.ts `parseSignupSource` |
| Bare signup links | Plain `/signup` with no source: home hero (home-copy.ts line 41), header (header-actions.tsx line 30), pillar pages (pillar-page.tsx lines 69 and 172), channel requirement pages (channels/[channel]/image-requirements/page.tsx lines 258 and 264), category pages (for/[category]/page.tsx line 63), help (help/page.tsx line 90), gallery (gallery/page.tsx line 148), share "Make mine" (s/[slug]/page.tsx line 109), and the email capture form, a GET form to /signup (email-capture.tsx line 15). | apps/web/src/app/(marketing)/ and apps/web/src/components/marketing/ |
| Attribution | No UTM, referrer, gclid or first touch capture anywhere in apps/web/src on main. Middleware only guards /app, /login and /signup. The unmerged `site-visitors` branch adds a cookieless page view count (`site_visits`: day, a salted visitor hash that changes daily, path, referrer host, utm_source, utm_medium, utm_campaign, device) with its own UTM and referrer normalizers (lib/visits/normalize.ts); by design it cannot be joined to a signup. | grep of apps/web/src; apps/web/src/middleware.ts; `git show site-visitors` |
| Operator pages | None on main. `site-visitors` adds apps/web/src/lib/ops.ts `isOperator` over `OPS_EMAILS` and the first operator page, /app/ops/visitors. | `site-visitors` branch |
| Analytics | PostHog client only (posthog-js; no posthog-node), after consent, and only when `NEXT_PUBLIC_POSTHOG_KEY` is set (it is not set in production per N-impl section 7). About 20 client events, among them pack_created, pack_downloaded, lead_captured, makeover_shared, checkout_started, pricing_cta_clicked and paywall_shown. No server side funnel events. The `events` table exists (workspace_id nullable, RLS since 0001, members read and insert their own since 0002, `billing:%` names unique through `events_billing_dedupe_uq` in 0003). | apps/web/src/components/analytics.tsx; apps/web/src/lib/track.ts; apps/web/src/lib/billing/analytics.ts; packages/db/src/schema.ts line 702 `events`; migrations 0001 to 0003 |
| Ads conversions | OpenAI Ads pixel after consent; one server conversion, Registration Completed, sent from /auth/callback only when the confirming browser carries `curvi_consent=granted` and the account is under 24 hours old. The code comment says the bzr.openai.com shape was checked 2026-10-01, but docs/verification.md has no row for it. | apps/web/src/lib/ads-conversions.ts; apps/web/src/app/auth/callback/route.ts lines 57 to 62 |
| Provider pause | `providerPreflightDetail` returns `packs_paused` or `scenes_paused` with a cause; only /app/new and createJob read it. Marketing pages and /signup never do. A quota answer writes an `events` row `provider_quota_exhausted` but emails nobody unless the provider is an OpenAI LLM (llm-monitor). The fal cutout has no balance probe ("shows as skipped"). | apps/web/src/lib/provider-preflight.ts; apps/web/src/app/app/new/page.tsx; trigger/src/provider-quota.ts; trigger/src/llm-monitor.ts `onProviderQuota`; packages/pipeline/src/seed/monitoring.ts `llmQuotaAlertFamilies`; docs/LAUNCH_CHECKLIST.md line 429 |
| Cutout chain | fal BiRefNet on `FAL_KEY`, then the same model on `FAL_KEY_BACKUP` when set, $0.01 budget each. | packages/pipeline/src/seed/models.ts lines 159 to 214 |
| Deploys | On SIGTERM the inline runner settles waiting packs as failed (`not_started`) and, after the grace window, running packs as failed (`interrupted`), releasing holds. The seller must start again. `generation_jobs.run_key` fences stale runs. | apps/web/src/lib/jobs/inline-runner.ts; apps/web/src/lib/jobs/settle.ts; migration 0019 |
| Scheduling | Trigger.dev is not deployed, so its scheduled tasks never run. Scheduled work runs as `POST /api/cron/*` routes with `CRON_SECRET` (today stale-jobs every 10 to 15 minutes and purge-source-media daily), each called by a Render Cron Job ($1 a month minimum per cron service, LAUNCH_CHECKLIST line 338). One cron service's command can call several routes. | apps/web/src/app/api/cron/; apps/web/src/lib/cron-auth.ts; docs/LAUNCH_CHECKLIST.md lines 330 to 342, 390 and 427 |
| Email | Resend REST is used only for founder mail (spend alerts, LLM alerts, the digest, which never runs). No customer email of any kind beyond Supabase auth mail. No suppression list, no unsubscribe handling. | trigger/src/digest.ts; trigger/src/spend-alerts.ts `sendFounderEmail`; N-impl section 6 |
| Leads | `leads` platform table (email, source, last_source, hits); sources main-image-checker, white-background-fixer, marketplace-resizer, share-page, gallery. "Nothing is sent to a list provider yet." No consent field. | packages/db/src/schema.ts `leads`; apps/web/src/lib/leads.ts; apps/web/src/lib/lead-sources.ts |
| Fidelity gate | `fidelityReport` returns `meanDeltaE`, `maxDeltaE`, `exactByteShare`, `maskArea`, `erodePx`, `kind`, `threshold` and `pass` on the shipped bytes; `checkGeneration` calls it at pipeline-runner.ts lines 2399 to 2403. Only pass or fail survives: `ShotOutputSummary.fidelityPass` (lines 793 to 803) and, when the judge fails schema validation, `deterministicVerdict`'s fidelity of 1 or 0 (lines 2153 to 2167). `saveAsset` spreads the verdict, fill and background into `assets.qc`, a jsonb column (packages/db/src/schema.ts line 412), never the fidelity numbers. | packages/pipeline/src/qc/fidelity.ts lines 45 to 66; trigger/src/db-store.ts lines 258 to 279; trigger/src/pipeline-runner.ts |
| Compliance report | Per file rows (size, white background, fill, bytes, format, megapixels, background match) with no fidelity row; PDF and JSON for signed in members only; the packager's compliance-report.json has no fidelity entry (its badge recheck in packager/badge.ts computes a fidelity report and keeps only pass); API `ShotCompliance` is `{ pass, fillPct, background }`. | apps/web/src/lib/compliance-report.ts `describeCheck`; apps/web/src/app/api/jobs/[id]/compliance/route.ts; packages/pipeline/src/packager/index.ts line 450; apps/web/src/lib/api-v1/schemas.ts lines 88 to 92 |
| Share pages | `/s/[slug]` shows a slider and the pack, "Make mine" links to bare `/signup`; images re-encoded with no metadata; indexable only when in the gallery; never in the sitemap; owner sees a view count; no social share buttons. | apps/web/src/app/(marketing)/s/[slug]/page.tsx; apps/web/src/app/sitemap.ts; apps/web/src/components/app/share-panel.tsx |
| Gallery | Four founder test packs labeled "Shared by the seller" plus six labeled illustrations. | apps/web/src/app/(marketing)/gallery/page.tsx line 46; https://curvi.ai/gallery |
| Free tools | Browser only Amazon main checker (pass or fail rows free, measured values behind the email gate), threshold based white background fixer (not a cutout), resizer. Server check `POST /api/v1/checks/main-image` needs an API key with the `checks` scope on a plan with `apiAccess` (Growth and up); the MCP tools (create_pack, get_pack, check_main_image, list_channels) are key only. Amazon rules only (`amazonMainRules`). | apps/web/src/lib/tools/main-image-analysis.ts `CheckerRules`; apps/web/src/components/marketing/main-image-checker.tsx; apps/web/src/app/api/v1/checks/main-image/route.ts; apps/web/src/lib/api-v1/actions.ts `checkMainImage` (line 427) |
| Channel pages | `/channels/[channel]/image-requirements` exists for every spec (static params over `imageSpecs()`), with two bare signup links each. | apps/web/src/app/(marketing)/channels/[channel]/image-requirements/page.tsx |
| Agent surfaces | API v1 and MCP live in production; `FEATURES.agentApi`, `agentSkill` and `urlImport` are `coming_soon` (marketing-facts.ts lines 215 to 236), so llms.txt, help and pricing call them coming soon; the Growth tier include lines do not mention API access although the seed entitlement `apiAccess` is live on Growth, Pro and Agency. No `server.json`. docs/PENDING.md (Phase 16 steps 6 and 7) requires the reviewer pass before `agentApi` flips. PHASE_19 owns the flip (P19-24), the reviewer pass for the MCP path (P19-27) and the registry listing (P19-28). | apps/web/src/lib/marketing-facts.ts `FEATURES`; packages/pipeline/src/seed/credits.ts `includeLines` (lines 110 to 135), `featureStatus` |
| Referrals | `referrals` table (code primary key, one `referred_workspace_id`, referrer workspace id, rewarded_at), members of the referrer read; ledger reason `referral` exists; no code issues codes or grants. One row per code means one shareable code per referrer cannot record several referees. | packages/db/src/schema.ts lines 586 to 602; migration 0011 lines 96 to 101 |
| Offers | `foundingMemberOffer` seed with no consumer; Checkout sets `allow_promotion_codes: true`. | packages/pipeline/src/seed/credits.ts; apps/web/src/lib/billing/checkout.ts line 72 |
| Onboarding | /welcome after verification, dashboard "Get your first pack" card, 15 free credits on confirmation (one typical 8 credit pack). No sample pack, no segment question. Real candle pack files exist on the home page (apps/web/public/home/pack/). | apps/web/src/app/(marketing)/welcome/page.tsx; apps/web/src/app/app/page.tsx; migration 0012 |
| Copy | "Labels, logos and textures in the output match your photo exactly" (home, help) and "stay identical" (llms.txt), while resized outputs keep 0.02 to 73 percent of exact bytes in the latest eval. | apps/web/src/components/marketing/home-copy.ts line 184; help-articles.ts line 72; apps/web/src/lib/llms.ts line 74; N-trust section 1 |
| Compliance gaps | Jewelry plans "scale on hand" inside a "no people" scene prompt, in both the deterministic planner and the shot_planner prompt in the seed (`SHOT_PLANNER_SYSTEM`, which v2 and v3 extend through `SHOT_PLANNER_V2_SYSTEM`); the QC issue enum has no person code; the white or clear background check is off (`BACKGROUND_WHITE_OR_CLEAR_ENABLED = false`); Walmart and TikTok Shop specs are unverified; IPTC tests cover JPEG only. | packages/pipeline/src/planner/deterministic.ts line 1374; packages/pipeline/src/seed/recipes.ts lines 146 to 157; packages/pipeline/src/schemas.ts line 123; packages/pipeline/src/qc/pixelChecks.ts line 67; packages/pipeline/src/metadata/iptc.test.ts |
| Recipes | shot_planner v3 (gpt-6.1-sol) and qc_judge v2 are seeded at `trafficPct: 0`. Production traffic shares are set in the database and can differ from the seed (the `recipe_drift` health warning; PHASE_17 known gaps), so read the production `recipes` rows before choosing a base version or re-seeding. | packages/pipeline/src/seed/recipes.ts lines 446 to 565; docs/LAUNCH_CHECKLIST.md line 427 |
| Migrations | Latest on main is 0026_api_keys_client_read_only. 0027 is taken by `0027_site_visits` on the unmerged `site-visitors` branch, and PHASE_19 adds `mcp_connections`. Phase 18 migrations take the next free number at build time (principle 10). | packages/db/migrations/; `git show site-visitors` |

## Ranked items

Effort: S is up to 2 builder days, M is 3 to 5, L is 6 to 10, including tests. Running cost is cash per month or per use at zero to low volume, beyond today's hosting.

| Rank | ID | Title | Priority | Status | Workstream | Funnel step | Effort | Running cost | Enables in docs/marketing.md |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | P18-01 | First touch attribution and a self reported source | P0 | Revised | A Measure | All | S | $0 | MKT-008, MKT-047 |
| 2 | P18-02 | Server side funnel events and a weekly funnel email | P0 | Revised | A Measure | All | S | $0 on an existing cron command | MKT-047, MKT-049, readouts |
| 3 | P18-03 | Acquisition gate, fal balance probe and low balance alerts | P0 | Revised | B Resilience | Acquisition, activation | M | $0 | MKT-040, MKT-047, gate G8 |
| 4 | P18-04 | Prospect makeover tool for concierge outreach | P1 | Revised | C Concierge | Acquisition, activation | M | About $0.20 to $1 per prospect pack | MKT-015, MKT-019, MKT-024 |
| 5 | P18-05 | Pack feedback and testimonial capture | P0 | Kept | C Concierge | Activation, referral | S | $0 | MKT-020, MKT-022 |
| 6 | P18-06 | Lifecycle email foundation | P1 | Revised | D Email | Activation, retention | M | $0 on Resend's free tier (verify) | MKT-013, MKT-042, MKT-046 |
| 7 | P18-07 | Activation, pack ready and win back emails | P1 | Kept | D Email | Activation, conversion, retention | M | $0 | MKT-013, MKT-042, MKT-046 |
| 8 | P18-08 | Store and show the fidelity numbers | P1 | Revised | E Proof | Conversion, acquisition | M | $0 | MKT-026, MKT-028 |
| 9 | P18-09 | Claims and compliance hygiene | P0 (parts 1, 2); P2 (parts 3 to 5) | Revised; person check judge moved to backlog | E Proof | Conversion (trust) | S to M | $0 | MKT-010, MKT-029, MKT-039 |
| 10 | P18-10 | Main image checker for every marketplace main | P1 | Revised; API part waits for PHASE_19 | F Search | Acquisition | S | $0 | MKT-039 |
| 11 | P18-11 | URL import live and the Growth API line | P1 | Partly moved to PHASE_19 (P19-24, P19-27, P19-28) | F Search | Acquisition | XS to S | $0 | MKT-010, MKT-015 |
| 12 | P18-12 | Free white main image before signup | P2 (needs fal funded and Upstash set) | Revised | G Activation | Activation, acquisition | L | About $0.011 per preview, capped near $3 a day | MKT-041, MKT-042 |
| 13 | P18-13 | Google sign in | P1 | Revised | G Activation | Activation | S | $0 | MKT-042 |
| 14 | P18-14 | Share loop and gallery hygiene | P0 | Revised | C Concierge | Referral, acquisition | S | $0 | MKT-022, MKT-045 |
| 15 | P18-15 | OpenAI Ads conversions that count | P3 (its verification row is P0) | Revised | A Measure | Conversion measurement | S | $0 | MKT-048 |
| 16 | P18-16 | Product proof on share pages: report panel | P1 | Revised; heatmap moved to P18-17 and the backlog | E Proof | Conversion, referral | S | $0 | MKT-016, MKT-019 |
| 17 | P18-17 | Real photo fidelity benchmark page | P2 (needs fal funded) | Revised | E Proof | Acquisition, conversion | M | About $0.25 to $1 of compute per product | MKT-039, MKT-028 |
| 18 | P18-18 | Store image audit | P2 | Kept | F Search | Acquisition | M | $0 (bandwidth and CPU) | MKT-014 |
| 19 | P18-19 | Search pages with evidence | P2 | Kept | F Search | Acquisition | M | $0 | MKT-025, MKT-039 |
| 20 | P18-20 | First run for the top segment | P1 | Kept | G Activation | Activation | S | $0 | MKT-050 |
| 21 | P18-21 | Founding member offer and per pack price framing | P1 (after decision 18) | Revised | H Offer | Conversion | S | Discount only | MKT-021, MKT-050 |
| 22 | P18-22 | Message test landing pages | P3 | Kept | H Offer | Acquisition measurement | S | $0 | MKT-047 |
| 23 | P18-23 | Requeue packs a deploy interrupted | P2 | Kept | B Resilience | Activation, retention | M | Re-run compute only | MKT-041, MKT-042 |
| 24 | P18-24 | Referral give and get credits | P2 (after decision 18) | Revised | H Offer | Referral | M | About $1 to $6 of compute per rewarded pair | MKT-044, MKT-045 |
| 25 | P18-25 | ChatGPT app with the free check | Moved | Moved to PHASE_19; ID reserved | none | none | none | none | none (MKT-036 follows PHASE_19) |

## Workstreams

| Letter | Workstream | Items, in rank order |
| --- | --- | --- |
| A | Measure | P18-01, P18-02, P18-15 |
| B | Resilience that protects spend | P18-03, P18-23 |
| C | Concierge and social proof | P18-04, P18-05, P18-14 |
| D | Lifecycle email | P18-06, P18-07 |
| E | Proof | P18-08, P18-09, P18-16, P18-17 |
| F | Free tools and search | P18-10, P18-11 (part), P18-18, P18-19; P18-25 moved to PHASE_19 |
| G | Activation | P18-12, P18-13, P18-20 |
| H | Offer and referral | P18-21, P18-22, P18-24 |

Each item below lists: the growth problem and its evidence, today's state, the change across the stack, copy where relevant, tests, acceptance, effort and running cost, and an "Enables" line that names the docs/marketing.md tasks (MKT-xxx) depending on it, then the tactic. Event names are the P18-02 funnel names (stored as `funnel.<name>` in `events`).

## Workstream A: Measure

### P18-01: First touch attribution and a self reported source

**Problem and evidence.** "If a Reddit post, a cold email and a TikTok each produced a signup, the founder could not tell which was which" (R, funnel section). No UTM, referrer or first touch capture exists, and `signup_source` is written but never read (N-impl section 7). At tens of signups, a plain "How did you hear about Curvi?" answer is the most reliable signal there is (N-early section 3: count absolute events early).

**Today.** auth-form.tsx (line 139) puts `signup_source` (only ever `pricing`, set by billing/intent.ts line 63) and `plan_intent` into Supabase user metadata. Nothing stores or reads them. Every marketing CTA links to bare `/signup` except pricing (the "Bare signup links" row in "Starting point" lists each file and line). Consent is opt in for every visitor (apps/web/src/lib/consent.ts). The unmerged `site-visitors` branch counts page views with UTM tags and referrer host but, by design, cannot link them to a signup.

**Change.**
- **DB, migration `attribution_and_funnel` (next free number at build time; shared with P18-02).** New tenant table `signup_attributions`: `workspace_id` (not null, cascade), `user_id` (unique), `self_reported` (text, one of the seeded keys), `self_reported_other` (text, at most 80 characters), `source` (the page's source key), `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` (text, at most 100 each), `ref` (referral code, P18-24), `share_slug`, `claim_id` (P18-04), `preview_id` (P18-12), `landing_path` (at most 200), `referrer_host` (at most 100), `first_seen_at`, `consent` (`granted`, `denied` or null at signup time), `method` (`email` or `google`), `created_at`. Check constraints for the lengths.
- **RLS.** Owners and admins of the workspace select their own row; nobody writes through the anon or authenticated roles (the 0011 pattern: only the server's owner connection writes).
- **Seed.** `packages/pipeline/src/seed/growth.ts` (new) holds `signupSourceChoices` (key and label) and the list of allowed `source` keys.
- **Web, client.** New `apps/web/src/lib/attribution.ts` (client safe): `readLandingParams(url)` keeps only `utm_*`, `ref`, `source`, `s` (share slug), `claim` and `preview`, lower cases and length caps them, and drops everything else (no emails, no free text). If `site-visitors` has merged, it reuses that branch's `cleanUtm` and `referrerHost` (apps/web/src/lib/visits/normalize.ts) instead of a second parser.
- **One signup link builder.** The existing `signupHref({ plan, cadence, source })` in apps/web/src/lib/billing/intent.ts (lines 57 to 65) gains an optional `extra` map (`s`, `claim`, `preview`, `ref`, `category`, `channel`), validated against the seeded keys; no second function of the same name is added. A small client `SignupLink` component wraps it and appends the current page's landing params at click time, so attribution travels without any storage. Every bare `/signup` link listed in "Starting point" switches to it with its own source key (home, header, pillar, channel requirement, category, help, gallery, share, and the email capture form, which gets a hidden `source` field), plus tools, compare and the welcome continue link.
- **First touch cookie.** `curvi_ft` (first party, 90 days, at most 1 KB of JSON: landing params, `referrer_host`, `landing_path`, `first_seen_at`) is written only when consent is `granted`, on load or on the `curvi:consent-changed` event, and never overwritten.
- **Signup form.** Adds an optional select "How did you hear about Curvi?" (seed choices, with "Other" opening a short text field). On submit it puts `{ attribution: { ...landing params, ...curvi_ft, self_reported, consent } }` into `options.data` (a hint, like `terms_accepted_at`).
- **Server.** `/auth/callback`, on a fresh verification, validates the metadata hint (zod, the same caps) and writes the `signup_attributions` row through the owner connection, once per user (`on conflict (user_id) do nothing`). For Google sign in (P18-13) the same object arrives as a base64url `attr` query parameter on the callback URL.
- **Read side.** `getSignupAttribution(workspaceId)` in the services layer, used by P18-02, P18-07, P18-15 and P18-24. Sellers never see it.

**Copy.** Field label "How did you hear about Curvi?" Helper "Optional. It helps a one person company know what works." Choices: "Search engine", "ChatGPT or another AI assistant", "YouTube", "TikTok", "Instagram or Facebook", "Reddit", "A seller community or forum", "An email from Curvi", "A friend or colleague", "A directory or launch site", "Other".

**Tests.** Unit: `readLandingParams` keeps only allowed keys and caps lengths; `signupHref` keeps its pricing behavior and forwards `extra`; the cookie writer does nothing without granted consent; a source scan fails on any bare `href="/signup"` or `action="/signup"` left in apps/web/src/app/(marketing) and apps/web/src/components/marketing. Route: the callback writes one row and ignores a second confirmation; bad metadata is dropped, never stored. RLS: `packages/db/src/attribution.test.ts` (owner and admin read their own row; editor, client, another workspace and anon read nothing; no role but the owner connection inserts or updates). E2E (`e2e/attribution.spec.ts`): landing on `/?utm_source=reddit&utm_campaign=label_test` and clicking Start free reaches /signup with both params; each primary CTA (home, header, pillar, channel, category, help, gallery, share) carries a `source`; with consent denied no `curvi_ft` cookie exists.

**Acceptance.** A signup that started from a tagged link or a share page has exactly one row with those values, including when the email is confirmed in another browser (the values travel in the signup metadata) and for Google sign in (P18-13); the self reported answer is stored when given; no attribution value is written to a cookie before consent.

**Effort and cost.** S. $0.

**Enables: MKT-008, MKT-047** (and the full version of gate G4 and the section 12.1 funnel in docs/marketing.md). Crediting every channel: UTM tagged community posts, video bios, outreach links, directory listings and the capped ad test.

### P18-02: Server side funnel events and a weekly funnel email

**Problem and evidence.** PostHog is off in production and client only, so no funnel exists (N-impl section 7). R's decisions are dated gates (usable packs by day 14, activation 35 percent and first payments by day 30, 20 percent repeat by day 60, a repeatable channel by day 90), and at this volume they must be read as absolute counts (N-early sections 3 and 8). A founder working alone needs the numbers pushed to them.

**Today.** The `events` table exists (workspace_id nullable, `billing:%` names unique through `events_billing_dedupe_uq`, written by billing, quota and alert code). No server code records signup, first pack, download or payment as funnel steps. Client PostHog events already cover pack_created, pack_downloaded, lead_captured, checkout_started, pricing_cta_clicked and paywall_shown, but only for consenting visitors and only once the key is set. The weekly digest is a Trigger.dev task that never runs (trigger/src/tasks/metrics-digest.ts).

**Change.** No new table and no new vendor: the server writes to the existing `events` table.
- **DB, in the `attribution_and_funnel` migration.** A partial unique index `events_funnel_first_uq` on `(workspace_id, name)` where `name like 'funnel.first_%'` (the 0003 `events_billing_dedupe_uq` pattern), so "first" events are written once by an `insert ... on conflict do nothing`.
- **Package.** `packages/db/src/funnel.ts`: `recordFunnelEvent(db, { workspaceId, name, props, first })`. It never throws, writes `funnel.<name>`, and with `first: true` also writes `funnel.first_<name>` once. Props are small flat values only, never emails or file keys.
- **Emission points.**
  - `signup_confirmed` (callback, fresh verification; props: method, source, self_reported, utm_source, utm_campaign).
  - `pack_started` with first (createJob in apps/web/src/lib/services/db.ts; props: channel count, bundle, from = upload, import, preview, claim or api).
  - `pack_done` with first (where the runner settles a job done; props: passed, needs_review, credits).
  - `download` with first (pack zip, files and v1 files routes).
  - `checkout_completed` and `payment` with first (Stripe webhook; props: plan, cadence, amount_usd, promo code when present).
  - `share_published` (share API).
  - `lead_captured` (leads route, workspace null, props: source).
  - Later items add theirs: preview, feedback, claim, email, referral and acquisition events.
- **Weekly email.** `POST /api/cron/funnel-digest` (CRON_SECRET, `recordCronSuccess`), added to the daily purge-source-media cron command, so no new cron service is needed. It sends once per ISO week, on the first call on or after Monday 13:00 UTC (dedupe key per ISO week), a plain text email through `sendFounderEmail` (trigger/src/spend-alerts.ts; apps/web already depends on @curvi/trigger) to `FOUNDER_ALERT_EMAIL`. Contents, for the last 7 days and since 2026-10-01:
  - confirmed signups by self reported source, by `utm_source` and by page source;
  - activation (first pack done over confirmed signups);
  - first downloads;
  - payments and first payments;
  - repeat use (a second pack within 30 days of the first);
  - feedback "usable as is" share (P18-05);
  - leads by source;
  - previews made and claimed (P18-12);
  - prospect packs and claims (P18-04);
  - share views;
  - site visitors and the top UTM sources from `site_visits_daily` and `site_visits`, once `site-visitors` has merged (counts only; they never join to signups);
  - a gate table comparing each R gate with its seeded threshold (`validationGates` in growth.ts).
- **SQL.** The same queries go into docs/LAUNCH_CHECKLIST.md as a saved block for the Supabase SQL editor, and an operator page `/app/ops/funnel` (decision 15 gate) shows the same counts by source and week.
- **PostHog mirror (decision 17).** Optional `capturePosthogServer()` as one plain fetch (no posthog-node dependency) for users whose stored consent is `granted`, after a rule 7 check of the capture endpoint. Off when the key is unset.

**Copy.** Founder only. Subject "Curvi weekly funnel, week of {date}".

**Tests.** Unit (pglite): `recordFunnelEvent` writes once for first events under concurrency and never throws on a database error. Digest composition snapshot from a seeded fixture. Cron auth: 503 without a secret, 401 with a wrong one. Each emission point has a test that the event is written (createJob, webhook, callback, download routes, share route, leads route, runner done).

**Acceptance.** For a fixture with 10 signups, 4 first packs and 1 payment, the digest reports activation 40 percent and 1 first payment, grouped by source, and the counts match a hand count of the fixture. Running the cron every day of a week sends one email (dedupe key per ISO week).

**Effort and cost.** S to M. $0: the route joins the existing daily cron command (one cron service can call several routes in one command).

**Enables: MKT-047, MKT-049** (and the readouts MKT-020, MKT-050, MKT-051 and MKT-052, plus the section 12.1 funnel). The day 14, 30, 60 and 90 decisions in R and docs/marketing.md, with no dashboard work.

### P18-15: OpenAI Ads conversions that count

**Priority.** P3. Built only if docs/marketing.md decision D-001 runs an OpenAI Ads test (MKT-048); R itself recommends letting the ad credit lapse (decision 1). One part ships in Release 1 regardless: the missing docs/verification.md row for the existing bzr.openai.com shape, because the code already relies on it (rule 7).

**Problem and evidence.** The only conversion is Registration Completed, sent from the confirmation click and only when that browser carries the consent cookie; confirming in another browser or a mail app's in app browser sends nothing (R, funnel section; N-impl section 7). Optimizers need conversions that reflect value, and R judges paid tests by tagged signups and first packs, not registrations (N-ads sections 2 and 8).

**Today.** apps/web/src/lib/ads-conversions.ts sends `registration_completed` with id `registration_completed:<user id>` from /auth/callback (route.ts lines 57 to 62); consent is read from the confirming request's cookie.

**Change.**
- **Consent at signup.** The consent state stored on `signup_attributions.consent` (P18-01) is the source of truth for server conversions. The callback sends Registration Completed when either the stored consent or the request cookie says granted.
- **New conversions.** First pack done, from the P18-02 `first_pack_done` hook, with id `first_pack_done:<workspace id>`. Purchase, from `checkout_completed`, with id `purchase:<checkout session id>` and value and currency only if the API accepts them. Each is mapped to the base event type Ads Manager offers, after the rule 7 check.
- **Click id.** If OpenAI Ads appends a click identifier to landing URLs and the API accepts it, add it to the allowed landing params in P18-01 and send it.
- **Test command.** `pnpm --filter web ads:validate` sends each event with `validate_only: true`.
- **Verification log.** Add the missing docs/verification.md row for the existing conversion shape.

**Tests.** Unit: event bodies and ids; nothing is sent when stored consent is denied or the key is unset; one send per id. Route tests for the webhook and runner hooks with a fake fetch.

**Acceptance.** The verification row exists (Release 1). If the item is built: `validate_only` calls for all three events return OK with the real key, and a test purchase sends one purchase event.

**Effort and cost.** S. $0.

**Enables: MKT-048** (optional; docs/marketing.md section 7.5). The capped ChatGPT ads test after the day 30 gate (decision 1), measured on first packs rather than registrations.

## Workstream B: Resilience that protects spend

### P18-03: Acquisition gate, fal balance probe and low balance alerts

**Problem and evidence.** Every white main image needs a fal cutout. When the balance is empty the app pauses any pack that needs one, "and no marketing page or signup page warns visitors" (R, funnel section; N-impl section 10). Ads, launches or posts while paused "would mostly buy unmeasured visits that cannot complete a pack" (N-impl section 10; N-ads section 8; N-early section 4). The balance was exhausted at research time.

**Today.** `providerPreflightDetail` is read only by /app/new (apps/web/src/app/app/new/page.tsx) and createJob (apps/web/src/lib/services/db.ts); no marketing page or signup page reads it. The free browser tools never need fal and keep working during a pause. A quota answer writes `provider_quota_exhausted` to `events` and emails nobody unless the provider is an OpenAI LLM (llm-monitor `llmQuotaAlertFamilies` is `["openai"]`). The fal cutout has no probe at all (LAUNCH_CHECKLIST line 429). There is no manual switch to pause acquisition.

**Change.**
- **packages/ai.** `probeFalBalance({ adminKey, timeoutMs, fetchImpl })` beside the existing key probes in packages/ai/src/probe.ts (rule 4): one `GET https://api.fal.ai/v1/account/billing?expand=credits` with `Authorization: Key <admin key>`, 5 second timeout, no retry inside a probe, returns `{ ok, status, balanceUsd, currency }`. Never logs the key.
- **Seed.** `packages/pipeline/src/seed/monitoring.ts` gains `falBalanceLines: { alertUsd: 15, pauseUsd: 3 }` (decision 8). The probe's account list (key env names `FAL_ADMIN_KEY` and optional `FAL_ADMIN_KEY_BACKUP`, matched to `FAL_KEY` and `FAL_KEY_BACKUP`) also lives here.
- **Cron.** `POST /api/cron/provider-balance`, added to the existing stale-jobs cron command (every 10 to 15 minutes), so no new cron service:
  - probes each configured account;
  - writes an `events` row `provider_balance` at most once an hour per account;
  - emails the founder once per UTC day per account below the alert line, and at once when below the pause line (AlertDedupe over PgCapStore, as spend alerts do).
- **Quota alerts.** `ProviderQuotaNotifier` (trigger/src/provider-quota.ts) also emails the founder for cutout and image providers, once per provider per UTC hour, through `sendFounderEmail`.
- **Acquisition state.** `apps/web/src/lib/acquisition.ts` returns `{ state: "open" | "waitlist", reason }`. The state is waitlist when any of these holds:
  - the preflight verdict is `packs_paused`;
  - every configured cutout account's newest balance row is below the pause line;
  - the `platform_settings` switch `acquisition_paused` is true (seeded false; the founder flips it by SQL with no deploy).
  It is cached 30 seconds per process, and state changes write `acquisition_paused` and `acquisition_resumed` events.
- **Public endpoint.** `GET /api/status` returns only `{ "acquisition": "open" }` or `{ "acquisition": "waitlist" }`, with `cache-control: public, max-age=30`. No provider names.
- **UI.** A client `AcquisitionCta` wraps every primary Start free CTA, so static marketing pages stay static. While waitlisted it becomes "Get notified when packs are back" and opens an email field that posts to `/api/leads` with the new lead source `packs-paused`. /signup renders a server side notice and stays open (decision default) so nobody is turned away, and P18-07 holds nudge emails until the state is open. The free browser tools are unchanged; they never need fal.
- **Health.** config-health warns `fal_admin_key_missing` when `FAL_KEY` is set without `FAL_ADMIN_KEY`. `/api/health` details show the last balance per account (authorized view only).
- **Ads.** If the rule 7 check finds no OpenAI Ads campaign API, the pause email says "Pause the ChatGPT ads campaign in Ads Manager" as a manual step.

**Copy.** Notice: "Packs are paused for a short while. Leave your email and we will tell you the moment they are back. The free checkers still work." Signup notice: "Packs are paused right now. You can create your account today, and we will email you when packs are back." Founder email subject: "Curvi: the fal balance is low ({amount} left)" and "Curvi: acquisition is paused because packs cannot run".

**Tests.** Unit: the probe against a fake fetch (200 with balance, 401, 403, timeout); the state helper for each input and the cache; alert dedupe per day. Route: `/api/status` shape and headers; the cron's auth. E2E: with `CURVI_DEMO_ACQUISITION=waitlist` (demo only, ignored in db mode) the home CTA shows Get notified and a lead is stored with source `packs-paused`.

**Acceptance.** With a balance below the pause line in a test, every marketing CTA switches within 60 seconds and /signup shows the notice; the founder receives one email per day per account below the alert line; nothing about providers leaks on public endpoints.

**Effort and cost.** M. $0 (the route joins an existing cron command).

**Enables: MKT-040, MKT-047** (and the full version of gate G8, which retires the manual pause that MKT-012 runs today). Safe launch days, posts and any ad test: no channel spends attention on a product that cannot deliver.

### P18-23: Requeue packs a deploy interrupted

**Problem and evidence.** A deploy settles waiting packs as failed and fails running packs after the grace window, so a seller's first pack can end in "The server restarted while this pack was running" (docs/LAUNCH_CHECKLIST.md step 8). Activation is the weakest step and must land in the first session (N-early section 4). The paid plan removed spin downs (render.yaml working tree), so only deploys remain, and a solo founder deploys often during launch weeks.

**Today.** apps/web/src/lib/jobs/inline-runner.ts settles `not_started` and `interrupted` jobs through settle.ts (failed, hold released). `generation_jobs.run_key` already fences stale runs (migration 0019).

**Change.**
- **Not started packs.** The drain no longer fails them. It gives each a fresh `run_key` prefixed `restart:` and leaves it queued. On boot (when the runner starts in apps/web/src/lib/jobs/enqueue.ts, where the SIGTERM handler is registered today; there is no instrumentation.ts yet), the runner enqueues every queued job whose run key starts with `restart:`, oldest first. The 30 minute stale reconciler stays the backstop.
- **Interrupted packs with no delivered pack files.**
  - Release the hold, then mark the run's saved assets `approved = false` with `qc.status = "superseded"` (never charged; `deliveredCharges` already skips unapproved rows).
  - Reserve the estimate again and requeue with a `restart:` key, at most once per job (seed `deployRestarts.max = 1` in growth.ts).
  - If the reservation fails because the balance moved, settle failed as today.
  - Cutouts come from the R2 cutout cache, so the rerun pays again only for scenes.
- **Migration `deploy_restarts`** (next free number at build time). `generation_jobs.restart_count integer not null default 0`.
- **Seller copy.** The pack page shows a one line notice.

**Copy.** "We restarted the server while your pack was running, so it started again. You are charged only once."

**Tests.** Inline runner unit tests for the new drain outcomes. A settle test that superseded assets are never charged. A boot requeue test that only `restart:` jobs are picked up. The restart cap. A ledger test: one charge per shot after a restart.

**Acceptance.** A simulated SIGTERM in the middle of a pack ends with the job done after the restart, exactly one charge per delivered shot, and no job left in a working state.

**Effort and cost.** M. Re-run compute only (scene generation, up to the seeded per pack cap; usually well under $1).

**Enables: MKT-041, MKT-042** (optional; no task depends on it). Launch week stability for Show HN, Product Hunt and concierge deliveries.

## Workstream C: Concierge and social proof

### P18-04: Prospect makeover tool for concierge outreach

**Problem and evidence.** Concierge outreach is R's core channel: hand made free packs for 30 to 50 sellers of labeled goods on two or more channels, sent as share links with a short note (R, "Founder hours"; N-early section 7; N-acq section 8; plan 9.2). "The missing pieces are a way to make a pack for a prospect's product without their signup, and email" (N-impl section 11). Personalized visual proof is what moves cold reply rates toward the top tier (N-acq section 8).

**Today.** The founder can make a pack in their own workspace and publish a share page, but the share title, the "Make mine" CTA and the gallery treat it as the seller's own; nothing links a later signup to the outreach, and there is no takedown path for a prospect.

**Change.**
- **Operator gate.** `isOperator` over `OPS_EMAILS` (decision 15), checked server side in every page and action. New page `/app/ops/prospects` (already behind the /app middleware, beside /app/ops/visitors), noindex; everyone else gets 404.
- **Create.** The form takes the prospect's product URL (Shopify or Amazon through the existing lib/url-import) or photos, the store name the founder types, channels and a note. URL import is still `coming_soon` and unproven in production (MKT-003 step 8 in docs/marketing.md tests it); when an import fails, the founder uploads the listing photo instead. A server action creates the product and job in the operator's workspace through the normal createJob path (every cap, rule and charge applies), and records `prospect_pack_made`.
- **Operator credits.** The operator workspace's credits come from an operator only "Add prospect credits" action that writes a `grant` ledger row with source `system`, capped per calendar month by seed `staffMonthlyCreditCap` in growth.ts.
- **Publish.** When the pack is done it is auto published as a link only pack share: never in the gallery and noindex, because prospect products carry third party brands (R's own warning about the Gatorade test packs). It is titled "{store} listing pack, made by Curvi", with the P18-16 proof panel on (decision 9).
- **Outreach kit panel.**
  - the claim link;
  - the existing main image check results for the prospect's current main image;
  - the P18-08 fidelity summary;
  - a draft note under 80 words built from a template with those measured values.
  The founder edits and sends it from their own outreach inbox; Curvi sends nothing to prospects.
- **DB, migration `pack_claims`** (next free number at build time). Platform table `pack_claims`: `id`, `token_hash` (unique), `job_id`, `staff_workspace_id`, `prospect_label`, `product_source_url`, `created_at`, `expires_at` (seed 30 days), `claimed_by_workspace_id`, `claimed_at`, `taken_down_at`. RLS on, no policies, no client privileges.
- **Claim page.** The share page for a claim token shows "This pack was made for {store}. Make it yours" with `signupHref({ source: "concierge", extra: { claim } })`. At confirmation the callback redeems the claim once:
  - attribution `source = concierge`, `utm_campaign` = the prospect label;
  - the product URL is imported into the new workspace;
  - the dashboard opens /app/new with that product selected.
  No extra credits (decision 11).
- **Takedown.** A footer link posts to `POST /api/claims/[token]/takedown`, which unpublishes the share and sets `taken_down_at`. The founder must also add that contact to their outreach tool's do not contact list (a founder step in docs/marketing.md).

**Copy.** Claim CTA: "This pack was made for {store} from your current listing photo. Make it yours: create a free account and your product is ready to go." Footer: "Not yours, or want this page removed? Take it down here, or email hello@curvi.ai." Draft note: "Hi {name}, I ran your {product} main image through our Amazon checker. The background measures {white} pure white and the product fills {fill} percent of the frame. I made a full listing pack from the same photo, free, without redrawing your product: {link}. If it is useful, I can do your next three products. {founder}"

**Tests.** RLS: `pack_claims` (no access for anon, authenticated or members; `packages/db/src/pack-claims.test.ts`). Unit: the token is hashed and single use; an expired or taken down claim cannot be redeemed; non operators get 404 on operator routes and actions; the monthly cap. E2E (demo mode): an operator creates a prospect pack, the share page shows the claim CTA, signup with the claim lands on /app/new with the product.

**Acceptance.** The founder can go from a product URL to a sendable link and draft note in under five minutes of their own time, and a claimed signup appears in the funnel email as concierge with its prospect label.

**Effort and cost.** M. About $0.20 to $1 of provider spend per prospect pack (a $0.01 cutout plus up to three scenes at the seeded image prices; R estimates $25 to $50 for 50 packs). Each generative still loses money at today's price (decision 18), which the monthly cap bounds.

**Enables: MKT-015, MKT-019, MKT-024.** Concierge outreach, the plan's main acquisition channel for days 3 to 21. Until it ships, the founder makes prospect packs by hand in their own workspace (MKT-015).

### P18-05: Pack feedback and testimonial capture

**Problem and evidence.** R's day 14 gate is "half or more say they would use the files live, and at least 3 ask unprompted for more products". Nothing in the product asks. The gallery has no third party proof and no testimonials exist (N-impl section 1). Pebblely's founders learned from 124 customer calls (N-acq section 6).

**Today.** No feedback, rating or testimonial storage. `products.endorsements` (0025) is seller typed press quotes for A+ modules, not feedback about Curvi.

**Change.**
- **DB, migration `pack_feedback`** (next free number at build time). Tenant table `pack_feedback`: `id`, `workspace_id`, `job_id` (cascade), `user_id`, `usable` (`yes`, `some`, `not_yet`), `would_pay` (`yes`, `maybe`, `no`, nullable), `comment` (at most 500 characters), `quote_consent` (boolean, default false), `display_name` (at most 60), `created_at`, unique `(job_id, user_id)`.
- **RLS.** Members of the workspace select; writes only through the server's owner connection after the server checks membership.
- **UI.** A card on the pack page once the job is done, shown until answered or dismissed. It is also reachable from the P18-07 day 2 email by a signed link.
- **Founder view.** The P18-02 digest lists the usable share and new consented quotes.
- **Gallery.** The gallery shows a consented quote under that seller's entry (P18-14).

**Copy.** "Would you use these files in a live listing?" Options: "Yes, as they are", "Some of them", "Not yet". Follow up: "What would make them better?" and "Would you pay for packs like this?" Consent: "You can quote me on curvi.ai with this name and store:" with an empty name field.

**Tests.** RLS test (`packages/db/src/pack-feedback.test.ts`). Route validation (lengths, enum values, one answer per job and user, membership). E2E: the card appears on a done demo pack, posts, and does not show again.

**Acceptance.** Feedback rows exist for concierge and self serve packs, and the digest shows the usable share against the day 14 gate.

**Effort and cost.** S. $0.

**Enables: MKT-020, MKT-022.** Reading the day 14 gate; quotes for the gallery, videos, directories and comparison pages.

### P18-14: Share loop and gallery hygiene

**Problem and evidence.** "The share page's 'Make mine' button links to a plain /signup with no source attached", there are no share buttons, gallery shares are not in the sitemap, and the four gallery "customer makeovers" are founder test packs, two of them showing a third party brand, labeled "Shared by the seller" (R, funnel section; N-impl sections 1, 2 and 5). Branded, circulating outputs drove the category leaders (N-comp, acquisition section).

**Today.** apps/web/src/app/(marketing)/s/[slug]/page.tsx line 109 (bare Make mine; the page is noindex unless the share is in the gallery and not an illustration, line 35); apps/web/src/components/app/share-panel.tsx (copy link only); apps/web/src/app/sitemap.ts (no /s/ URLs); gallery/page.tsx line 46 (fixed "Shared by the seller" label).

**Change.**
- **Make mine.** P18-01's link sweep gives it `source=share`; this item adds the slug: `signupHref({ source: "share", extra: { s: slug } })`.
- **Share panel and pack reveal.** Buttons for X, LinkedIn, Pinterest (with the share image) and Reddit; `navigator.share` on phones; copy link. Each adds `utm_source=<network>&utm_medium=share&utm_campaign=pack_share`. Intent URL formats are verified first (rule 7).
- **Sitemap.** It adds gallery listed, non illustration shares from `listGallery`, revalidated hourly.
- **Gallery labels.** Entries from an operator's workspace (decision 15) read "Made by the Curvi team"; seller entries keep "Shared by the seller" and show a consented P18-05 quote when present.
- **Founder step.** Unpublish "Blue Car 1", "Blue Gatorade v2" and "Blue Gatorade v4" from the gallery, and replace them with founder owned or consented packs (R, Phase 18 table, gallery hygiene). docs/marketing.md runs this as MKT-009; it does not wait for the code.

**Copy.** Share text: "One photo, a full listing pack, and the product was never redrawn. Made with Curvi." Operator label: "Made by the Curvi team".

**Tests.** Unit: share URLs are encoded and carry UTM; the sitemap lists only gallery shares; the label depends on the operator allowlist. E2E: Make mine carries `source=share` and the slug through to signup.

**Acceptance.** Every share driven signup shows `source = share` with its slug in `signup_attributions`; the gallery shows no third party branded test packs.

**Effort and cost.** S. $0.

**Enables: MKT-022, MKT-045** (and guardrail 7 in docs/marketing.md, which keeps founder made packs out of the gallery until the label ships). Prospects and sellers passing packs on; the gallery as credible proof.

## Workstream D: Lifecycle email

### P18-06: Lifecycle email foundation

**Problem and evidence.** "Nobody is followed up. Curvi sends no welcome, nudge, pack-ready or win-back email", and free tool leads sit in a table that "says 'Nothing is sent to a list provider yet'" (R, funnel section; N-impl section 6). A launch on Product Hunt or Show HN works only with an owned list (R, "Founder hours"; N-acq section 4). Gmail requires authentication, a spam rate under 0.3 percent and one click unsubscribe for bulk senders, and CAN-SPAM requires a postal address and a working opt out (N-acq section 8).

**Today.** Resend REST is used only for founder mail, through plain fetch (`sendFounderEmail` in trigger/src/spend-alerts.ts, `RESEND_EMAILS_URL` in trigger/src/digest.ts). No customer email, no unsubscribe, no suppression list, no consent field on `leads`. The email gate tells visitors "We keep your email to follow up about Curvi, and never sell it" (email-gate.tsx line 132). docs/PENDING.md lists Loops for lifecycle email; decision 3 chooses Resend instead.

**Change.**
- **Package.** New `packages/email` (used by apps/web and trigger):
  - `sendEmail({ to, template, data, kind: "transactional" | "marketing", dedupeKey, workspaceId })` over `POST https://api.resend.com/emails` with a 10 second timeout;
  - plain text plus a minimal HTML body;
  - `from` = `LIFECYCLE_EMAIL_FROM` (an address on the Resend verified `updates.curvi.ai` subdomain, LAUNCH_CHECKLIST step 2), `reply_to` = `LIFECYCLE_REPLY_TO` (the founder's inbox);
  - on marketing mail, `List-Unsubscribe` (https and mailto) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, after the rule 7 check;
  - it checks suppression and the kill switch before sending, and logs every attempt.
- **Templates.** Typed TS modules in packages/email/src/templates. A test runs every subject and body through the rule 9 lint, `unqualifiedClaims()`, and a ban on "expire" next to "credits".
- **DB, migration `lifecycle_email`** (next free number at build time).
  - `email_sends` platform table (it also logs mail to leads, who have no workspace, so it follows the `leads` precedent rather than a tenant policy): `id`, `recipient_key` (sha256 of the normalized email, the 0012 `normalized_email_key` rules), `workspace_id` (nullable, set null on delete), `template`, `dedupe_key` (unique), `kind`, `provider_id`, `status` (`sent`, `failed`, `suppressed`, `disabled`), `error`, `created_at`.
  - `email_suppressions` platform table: `recipient_key` primary key, `scope` (`marketing` or `all`), `reason` (`unsubscribed`, `bounced`, `complained`, `manual`), `created_at`.
  - `leads` gains `marketing_consent_at` and `consent_source`.
  - All three keep RLS on, with no policies and no client privileges (the `leads` precedent).
- **Unsubscribe.**
  - Signed links (HMAC with `CURVI_LINK_SECRET`, no expiry; the same secret signs the P18-05 feedback links and the P18-12 download links) open `/email/unsubscribe`, a marketing page with one confirm button.
  - `POST /api/email/unsubscribe` also accepts the one click POST.
  - /app/settings gains "Emails from Curvi with listing image tips and offers", which writes or clears a `marketing` suppression.
- **Bounces.** `POST /api/webhooks/resend` with signature verification (rule 7 check of Resend's webhook signing) adds `bounced` and `complained` suppressions. Until it is configured, the founder reviews bounces in Resend.
- **Consent on capture.** The free tool email gate keeps its existing notice and, with the packs paused waitlist, adds an unticked checkbox, "Also send me tips on listing images and the occasional offer". Ticked sets `marketing_consent_at`. The results themselves are the service the visitor asked for.
- **Limits and switches.**
  - Seed `emailLimits` in growth.ts sets the most sends per cron run and per UTC day, kept inside Resend's free tier after the rule 7 check.
  - `platform_settings.lifecycle_email_enabled` is seeded false; the founder sets it true after the domain, SMTP and postal address steps.
  - Marketing mail also needs `CURVI_POSTAL_ADDRESS` set (decision 4) or it is skipped as `disabled`.
- **Cron.** `POST /api/cron/lifecycle`, added to the existing stale-jobs cron command (every 10 to 15 minutes), runs the P18-07 selection and sends.
- **Health.** config-health warns `lifecycle_email_not_configured` while the switch is on but a required variable is missing.
- **Docs.** The merge updates the docs/PENDING.md line "Loops for lifecycle email" to record decision 3.

**Copy.** Marketing footer: "You get this because you signed up at curvi.ai or asked for results from a Curvi tool. Unsubscribe in one click: {link}. Curvi, {postal address}." Unsubscribe page: "Stop tips and offers from Curvi? You will still get emails about packs you make and payments." Button: "Unsubscribe".

**Tests.** RLS and privilege tests for `email_sends`, `email_suppressions` and the new `leads` columns (`packages/db/src/lifecycle-email.test.ts`). Unit: link signing and verification; suppression and kill switch respected; dedupe key unique under concurrency; the one click POST body is accepted; the template lint. Route tests for unsubscribe and the webhook signature. E2E: the email gate shows the unticked consent box, and the unsubscribe page works with a valid token and refuses a forged one.

**Acceptance.** No email can be sent twice for one dedupe key, to a suppressed address, or while the switch is off; every marketing email carries the footer and both unsubscribe headers.

**Effort and cost.** M. $0 on Resend's free tier if the verified limits fit; Resend Pro is $20 a month (docs/verification.md line 33) if volume passes it.

**Enables: MKT-013, MKT-042, MKT-046** (and gate G7, the T-LEAD templates and guardrail 5 in docs/marketing.md). An owned list before Product Hunt and Show HN; follow up for every channel; the founder's "reply to this email" concierge hook.

### P18-07: Activation, pack ready and win back emails

**Problem and evidence.** "A signup who does not finish a pack in the first session is never contacted again" (N-impl section 6). The recommended design is an emailed "your pack is ready" with direct download and day 2 and day 7 nudges for users who never completed a pack (N-early section 4). Pebblely booked calls through onboarding emails and emailed heavy users and cancellations (N-acq section 6).

**Today.** Only the in app pack ready notice exists (apps/web/src/components/app/pack-ready-notice.tsx). Churn scores never run (Trigger.dev not deployed).

**Change.** A pure selection function `dueEmails(now, facts)` in packages/email decides, from funnel events, attribution, jobs, the ledger, leads and `email_sends`, which template each recipient is due. Delays and caps live in seed `lifecycleSchedule` in growth.ts. Templates:

| Template | Trigger | Kind | Stops when |
| --- | --- | --- | --- |
| welcome | `signup_confirmed` | transactional | sent once |
| first_pack_nudge_1 | 1 day after confirmation, no `pack_started` | marketing | a pack starts; acquisition waitlisted (held, not dropped) |
| first_pack_nudge_2 | 3 days after confirmation, still no pack | marketing | as above |
| pack_ready | `pack_done` | transactional | once per job |
| feedback_ask | 2 days after `first_pack_done`, no P18-05 answer | marketing | answered |
| out_of_credits | balance below the next pack estimate after a pack, free or Starter | marketing | once per 30 days; a purchase |
| win_back | 21 days after the last pack, no pack since, never more than once | marketing | a new pack |
| packs_back | acquisition back to open | transactional (the visitor asked) | once per pause, to `packs-paused` leads and to signups who made no pack during it |
| lead_results | `lead_captured` from a tool, with or without consent | transactional | once per lead and tool |
| lead_tip | 3 days after a lead, consent given, no signup | marketing | signup |
| lead_offer | 10 days after a lead, consent given, no signup | marketing | signup |

- Links carry `utm_source=curvi_email&utm_medium=email&utm_campaign=<template>`, so P18-01 credits returning signups. No open tracking pixels.
- Every send writes `email_sent` (props: template).
- The pack ready email includes the P18-08 fidelity summary once that ships, and the share prompt.

**Copy (drafts; the founder may edit; all pass the lint).**
- welcome. Subject: "Your Curvi account is ready". Body: "Hi, I am {founder}, and I build Curvi myself. You have {free credits} free credits, enough for one full pack. Upload one product photo and Curvi makes your Amazon main image, lifestyle scenes and social sizes, without redrawing your product: {link}. Short on time? Reply with a link to your product and I will make your first pack for you."
- first_pack_nudge_1. Subject: "Your free pack is waiting". Body: "One photo is all it takes. A phone photo on any plain surface works. {link}"
- pack_ready. Subject: "Your {product} pack is ready". Body: "{count} files passed their channel checks. The color inside your product changed by {mean} on average, against a limit of {limit}, because it was never redrawn. Download them here: {link}. Want to show someone? Share the before and after: {share link}."
- feedback_ask. Subject: "Would you use these files?" Body: "One tap tells me if your pack is usable as it is: {link}. If something is off, reply and tell me what. I read every answer."
- out_of_credits. Subject: "You have used your free credits". Body: "Starter is ${starter} a month for {credits} credits, about {packs} packs. Top ups start at ${topup} and last 12 months. {pricing link}"
- win_back. Subject: "New products to list?" Body: "If you have new products for the holidays, one photo each is enough. Your brand kit and settings are saved. {link}"
- packs_back. Subject: "Curvi packs are back". Body: "Thanks for waiting. Packs are running again: {link}"

**Tests.** `dueEmails` table tests for every row above (including holds while waitlisted, suppression, paid plans skipping nudges, and no duplicates across cron runs). Template snapshots. A db scenario test: a confirmed user with no pack gets welcome, nudge 1 and nudge 2, and nothing more.

**Acceptance.** Over a simulated 30 days, each recipient gets each template at most once (packs_back once per pause), never after a suppression, and the funnel email shows `email_sent` counts by template.

**Effort and cost.** M. $0 beyond P18-06.

**Enables: MKT-013, MKT-042, MKT-046** (MKT-046 writes the template source text; T-EM-04 and T-EM-07 in docs/marketing.md become these emails). Activation for every channel; the founder's "reply and I will make it for you" concierge path; retention for the day 60 gate.

## Workstream E: Proof

### P18-08: Store and show the fidelity numbers

**Problem and evidence.** "The most valuable hidden asset is the fidelity gate... Yet saveAsset stores only pass or fail, and the measured meanDeltaE, maxDeltaE and exactByteShare are discarded" (R, funnel section; N-trust sections 1 and 2). "Fidelity is a crowded claim but an empty proof": rivals claim it without per image proof at small seller prices (R, market section; N-comp, reviews section). R calls storing and showing these numbers "Phase 18's most important line item".

**Today.** `checkGeneration` calls `fidelityReport` (trigger/src/pipeline-runner.ts lines 2399 to 2403), and only pass or fail survives: `ShotOutputSummary.fidelityPass` (lines 793 to 803) and, on the judge fallback path, `deterministicVerdict`'s fidelity of 1 or 0 (lines 2153 to 2167). `saveAsset` (trigger/src/db-store.ts lines 258 to 279) spreads the verdict into `assets.qc` and writes no fidelity values; `describeCheck` has no fidelity row; the packager's compliance-report.json has none; API `ShotCompliance` has none.

**Change.** No migration: `assets.qc` is a jsonb column (packages/db/src/schema.ts line 412).
- **Runner.** `ShotOutputSummary` gains `fidelity: { meanDeltaE, maxDeltaE, exactByteShare, maskArea, threshold, maxDeltaELimit, kind, exact } | null`, copied from the report already in memory (rounded: mean to 2 decimals, max to 1, share to 4). `StoredAsset` carries it; `saveAsset` writes `qc.fidelity`. Follow ups (trigger/src/follow-up.ts) carry it the same way.
- **Packager and report.** Each file in compliance-report.json (packages/pipeline/src/packager/index.ts line 450) gains `fidelity` and a `product_unchanged` check `{ measured: mean, limit: threshold, pass }`, with the report schema version bumped. apps/web/src/lib/compliance-report.ts `describeCheck` renders "Product unchanged", and the PDF (compliance-pdf.ts) adds the row.
- **Pack page.** The badge in job-progress-board.tsx reads "Passes channel rules. Fill {fill} percent. Product unchanged: {mean} average color difference."
- **API.** `ShotCompliance` gains a nullable `fidelity` object and the OpenAPI document follows. The MCP view is PHASE_19's: P19-14 replaces the `get_pack` structured content with a chat view, so the field joins that chat view schema after PHASE_19 merges, not before.
- **Pack summary.** `packFidelitySummary(jobId)` (the highest mean across delivered files, and the file count) feeds the P18-07 pack ready email, P18-04's outreach kit and P18-16.
- **Older packs** show no row (the mask and reference are not stored, so nothing is recomputed).

**Copy.** Row label "Product unchanged". Measured "Average color difference {mean}, largest {max}". Required "Average at most {threshold}, no pixel above {limit}". Note "Not redrawn by AI. Measured on this exact file, inside your product." Kept photos with exact bytes: "Every pixel of your photo kept byte for byte."

**Tests.** The runner saves `qc.fidelity` for composite, template and kept outputs, and null when no reference exists. Report and PDF snapshots with the new row. API contract test against the OpenAPI schema. Copy lint. The rule 3 suites (trigger/src/live-rule3.test.ts and the 18 rule 3 test files) pass unchanged.

**Acceptance.** Every approved asset of a new pack with a product reference has `qc.fidelity`; the pack page, report, PDF and API show the same numbers.

**Effort and cost.** M. $0.

**Enables: MKT-026, MKT-028** (and messaging pillar A in docs/marketing.md section 6.3). "Label test" short videos with the measured number on screen, outreach notes with numbers, comparison pages and agency trust (R, "Founder hours" and conclusion).

### P18-09: Claims and compliance hygiene

**Problem and evidence.** The site says labels and logos "match your photo exactly", but products are resampled, and exact byte share ranged from 0.02 to 73 percent in the latest eval; "Never redrawn by AI, with the color inside your product measured on every file" is both true and stronger (R, funnel section; N-trust sections 1 and 8). "No AI people" is true by policy but contradicted by the jewelry "scale on hand" scene, and no output check looks for people (N-trust section 5). IPTC labeling is built but unconfirmed in production and untested on PNG and WebP (N-trust section 4). Walmart and TikTok Shop specs are unverified (N-trust section 6).

**Today.** See the Copy and Compliance gaps rows in "Starting point".

**Change.**
1. **Copy (ships in Release 1).** Replace "match your photo exactly" (home-copy.ts line 184, help-articles.ts line 72), "stay identical" (llms.ts line 74), "pixel for pixel identical", "remain pixel identical" and "exactly as photographed" in home-copy.ts, help-articles.ts, llms.ts, pillar-copy.ts and categories.ts with measured wording. In llms.ts this part changes only that claim sentence; the agent flags and sections there are PHASE_19's (P19-24), and whichever lane merges second rebases. PHASE_19's draft listing text ("stay exactly as photographed", PHASE_19 runbook longDescription) needs the same fix before its ZIP is built; flag it to the PHASE_19 builder rather than editing it here. Extend claims.test.ts to fail on "exactly" or "identical" within a sentence about labels, pixels or the photo, except sentences about kept photos.
2. **IPTC.**
   - Add PNG and WebP round trip tests to packages/pipeline/src/metadata/iptc.test.ts.
   - Add `pnpm --filter @curvi/trigger smoke:iptc <object key>`, which reads one delivered lifestyle file from R2 with exiftool and prints DigitalSourceType. The founder runs it once on a production file.
   - When it passes, add `FEATURES.aiLabeling` (live) and a help article quoting Google's accepted values (rule 7 refresh).
3. **Jewelry scene.** The phrase lives in two places, and the second is a rule 2 seed change.
   - Rename "scale on hand" to "scale next to a familiar object" in packages/pipeline/src/planner/deterministic.ts line 1374.
   - The seed prompt `SHOT_PLANNER_SYSTEM` (packages/pipeline/src/seed/recipes.ts line 151) is shared: v1 uses it and v2 and v3 extend it through `SHOT_PLANNER_V2_SYSTEM`. Never edit it in place, since that silently changes every existing version. Add a new `SHOT_PLANNER_V4_SYSTEM` equal to the v2 text with only that phrase replaced, and a shot_planner v4 row with the model and options of the version production serves (read the production `recipes` rows first; the seed has v3 at `trafficPct: 0`), at `trafficPct: 0`.
   - Run `pnpm eval` (the prompt-eval agent summarizes it), then canary 10, 50, then 100 percent as in PHASE_17, with an eval before each step, and keep the seed's `trafficPct` in step with production before any re-seed.
4. **People check, by inspection.** No jewelry output has ever been inspected (N-trust, line 157). Run every jewelry fixture in the eval set and one founder owned jewelry photo through the v4 planner, inspect each scene at full size for a hand or any part of a person, and record the result in "Implementation status". Adding a `person_present` issue to the QC enum (packages/pipeline/src/schemas.ts line 123) changes the qc_judge response schema, which needs a new qc_judge version, an eval and a canary, and a registry `noPeople` rule would follow it; both moved to the backlog and return only if an inspected output shows a person.
5. **Specs.**
   - Verify Walmart and TikTok Shop main image rules on official pages (rule 7), flip `verified`, and give `walmart.main` its own fill rule if Walmart publishes one. Walmart's current row is from search snippets (docs/verification.md line 229).
   - Move `BACKGROUND_WHITE_OR_CLEAR_ENABLED` from a code constant to a seeded switch, run the golden set with it on, then switch it on so Google and TikTok Shop mains show a measured background row.

**Copy.** Home fidelity tile: "Never redrawn by AI. Curvi cuts out your real product and builds the scene around it, then measures the color inside your product on every file." Help answer: "No. Curvi never redraws your product. It cuts your product out of your photo, places it on the new background, and checks every finished file: the average color difference inside your product must stay under 3 for main images and 5 for the rest. Resizing for each channel means most files are not byte for byte copies, and the check measures exactly that." AI labeling help: "Scenes made with AI around your real product carry the IPTC label Google Merchant Center accepts. Your main image carries no AI label, because nothing in it was generated."

**Tests.** Claims test extension; IPTC round trips on three formats; planner snapshot for jewelry; a seed test that v4's prompt equals v2's text with only the one phrase changed, and that v1 to v3 are byte for byte unchanged; the seed test for the background switch; the existing rule 3 suites.

**Acceptance.** No marketing string claims byte identity outside kept photos; one production lifestyle file is shown to carry `compositeSynthetic`; jewelry plans from both planners contain no hand scene; the jewelry inspection is recorded with its result.

**Effort and cost.** S for parts 1 and 2, S to M for parts 3 to 5 (one recipe canary). $0, plus small LLM eval spend.

**Enables: MKT-010, MKT-029, MKT-039** (MKT-010 carries claims C-03, C-11 and C-12 in docs/marketing.md section 6.5; the Walmart numbers in T-VID-06 wait for part 5). Truthful proof claims in every post, page, comparison and video; the "no AI people in your listing" angle after Amazon's synthetic performer rule (N-market section 4), once parts 3 and 4 pass.

### P18-16: Product proof on share pages: report panel

Renamed from "Product proof on share pages: heatmap and report panel". The per file heatmap moved: P18-17 builds it for the offline benchmark only, and heatmaps for production files are in the backlog. Rendering one per file adds sharp work inside `checkGeneration` and an R2 object per file, and the only evidence for it is one line in R's Phase 18 table; the measured numbers carry the proof without it.

**Problem and evidence.** The per file compliance report "is visible only to signed-in members", and share pages show no checks and strip the AI label (R, funnel section; N-trust sections 3 and 4). A public, forwardable proof lets agencies and sellers show a client or marketplace support, and makes each share page an indexable proof asset (N-trust section 3). R lists "an optional public compliance and fidelity panel on share pages".

**Today.** Share pages render a slider and images only (s/[slug]/page.tsx); share images are re-encoded with no metadata (packages/pipeline/src/share-image.ts).

**Change.**
- **Pack page.** "See the proof" per file shows the P18-08 numbers.
- **DB, migration `share_proof`** (next free number at build time). `share_links.show_proof boolean not null default false`. RLS unchanged (members read, server writes).
- **Share panel.** A toggle "Show the measured checks on the public page". Operator prospect shares set it on (decision 9).
- **Public page.** With `show_proof`, each image shows its channel, the pass rows (size, white background, fill), "Product unchanged" with the numbers, and for composited scenes the caption "Scene made with AI around the real product". The caption also keeps public copies disclosed, since share images drop the IPTC tag.

**Copy.** Panel heading "Measured on every file". Row "Product unchanged: average color difference {mean}, limit {threshold}". Scene caption "Scene made with AI around the real product".

**Tests.** The share store returns proof fields only when `show_proof` is true. A DB test for the new column (members read; client writes refused). Copy lint. E2E: a share with proof shows the rows and the scene caption.

**Acceptance.** A published share with proof on shows numbers that match the pack page, and no file key, workspace id or metadata reaches the public page.

**Effort and cost.** S. $0.

**Enables: MKT-016, MKT-019** (proof links in concierge notes; messaging pillar A in docs/marketing.md section 6.3). Proof links in outreach, community answers and agency pitches.

### P18-17: Real photo fidelity benchmark page

**Problem and evidence.** The only fidelity numbers are on 10 synthetic products; "no benchmark comparing Curvi with general generators on real labels exists" (N-trust section 9). R's Phase 18 table asks for 10 to 20 founder owned or consented labeled products run through the live pipeline, plus the same photos through a general model, published with per product numbers and heatmaps. General models now "better preserve subjects", so the claim must shift to proof (R, opening and market sections; N-comp, general models section).

**Today.** `pnpm eval` builds synthetic products only (packages/pipeline/eval/run.ts); its report is gitignored.

**Condition.** Needs fal funded (G0 in docs/marketing.md): every real photo needs a cutout.

**Change.**
- **Heatmap, offline only.** `renderFidelityHeatmap(reference, shipped, mask)` in packages/pipeline/src/qc/heatmap.ts is deterministic sharp code: the product in gray where the per pixel difference is under 1, a seeded color ramp above it, the background dimmed; at most 600 pixels on the long side. Only the benchmark stage calls it; production QC does not (see P18-16).
- **Eval stage.** `pnpm eval -- --stage benchmark --photos <dir>` reads a manifest (product name, owner or consent note, channels) and runs each photo through the live pipeline (needs keys; every provider call goes through packages/ai as in production, rule 4) for the Amazon main and one lifestyle scene. It writes per product numbers and heatmaps to eval/output/benchmark/.
- **Committed copy.** A reviewed copy goes to apps/web/src/content/benchmark-2026-10.json, with webp images under apps/web/public/proof/.
- **Page `/proof`.** "How Curvi proves your product is not redrawn". It covers:
  - the method (cutout, paste, eroded mask, CIEDE2000, the limits);
  - the synthetic results, labeled as generated test products;
  - the real photo table and heatmaps;
  - the general model crops made by hand (decision 10), with the date, the model name shown in the product and the exact instruction;
  - the limits stated plainly (resizing, color difference rather than OCR).
- **Links.** Added to the sitemap, llms.txt, the comparison pages and the help article.

**Copy.** Intro: "We ran {n} real labeled products through Curvi and measured the color inside each product on the finished files. Here is every number, including the worst one."

**Tests.** Heatmap unit: identical inputs give an all gray product; a one pixel shift shows color. A JSON schema test for the benchmark file; the page renders from it; copy lint and claims test; every image referenced exists.

**Acceptance.** The page lists at least 10 real products with numbers and heatmaps, states its date and limits, and passes the claims test; its numbers trace to the eval output for each product.

**Effort and cost.** M. About $0.25 to $1 of compute per product (one cutout, one scene), so $5 to $20 in total.

**Enables: MKT-039, MKT-028** (the benchmark page among the search pages; T-VID-01 material). Comparison pages, video material, citable evidence for AI assistants and journalists (R, "Search should target the moment of need"; N-acq section 3).

## Workstream F: Free tools and search

### P18-10: Main image checker for every marketplace main

**Problem and evidence.** Free single purpose tools are the category leaders' organic engine, and a new domain should own marketplace specific long tail queries such as "walmart image requirements" and "google merchant center image requirements" (N-acq section 1; R, search paragraph). The checker covers Amazon only, and the measured values hide behind the email gate (N-trust section 7). Suppression and disapproval are clear pain events sellers search for (N-market section 3).

**Today.** `CheckerRules` already takes its thresholds from the registry, but the page and API hard wire `amazon.main` (main-image-checker.tsx; api-v1/actions.ts `amazonMainRules`, line 427). Pass or fail rows show above the email gate and the measured values below it. A requirements page already exists for every spec at `/channels/[channel]/image-requirements` (static params over `imageSpecs()`).

**Change.** No new routes: the existing requirement pages stay the per channel landing pages, which avoids near duplicate pages for the same query (Google's scaled content abuse policy, P18-19).
- **Rules per spec.** `checkerRulesFor(specId)` reads the registry for `amazon.main`, `google.merchant.main` (white or transparent, fill 75 to 90 percent), `walmart.main` and `tiktokshop.main` (the last two only after the P18-09 verification flips `verified`).
- **Channel picker.** /tools/main-image-checker gets a channel picker (Amazon first); `?channel=<channel>` presets it, and the page title and rules table follow the chosen spec.
- **Links from the requirement pages.** Each main spec's `/channels/[channel]/image-requirements` page gets a "Check your main image" block that opens the checker with its channel preset (or embeds the checker, if the page weight allows), and the checker links back to the chosen channel's requirements page.
- **Above the gate.** The measured fill percent moves above the email gate (R's "show one measured value"); the rest stays gated.
- **On a fail.** "Fix this image free" goes to P18-12 with the same file when P18-12 is live, and to `signupHref({ source: "tool_checker_<channel>" })` until then.
- **API, after PHASE_19.** A `channel` parameter on the REST check and the MCP `check_main_image` tool waits until PHASE_19's tool work has merged (P19-13 to P19-15 own actions.ts, the MCP descriptors and the check's file input during that build, and their descriptions say Amazon only). It is then a small follow up inside this item, with PHASE_19's descriptions and chat views updated together.

**Copy.** Picker label "Which marketplace?". Intro "Check your {Channel} main image against {Channel}'s published rules in your browser. Nothing is uploaded." Requirement page block "Check your main image against these rules, free, in your browser." Fail CTA "Fix this image free".

**Tests.** Rules come from the registry for every channel (no literals; a rule 2 test). The picker applies each channel's rules; `?channel=` presets it and an unknown value falls back to Amazon. Each main spec's requirement page links to the checker with its channel. E2E: picking Google applies the Google fill range.

**Acceptance.** The checker applies the registry rules for Amazon and Google now, and for Walmart and TikTok Shop once verified; every main spec's requirement page links to it with its channel preset; one measured value shows above the gate.

**Effort and cost.** S. $0 (runs in the browser).

**Enables: MKT-039** (and playbook P-5 in docs/marketing.md). Search pages per channel; "post your main image and I will check it" community help (R, communities paragraph).

### P18-11: URL import live and the Growth API line

Renamed from "Agent surfaces live and listed". **Partly moved to PHASE_19 (P19-24, P19-27, P19-28).** The draft's keyless check on `POST /api/v1/checks/main-image` and the MCP `check_main_image` tool contradicts PHASE_19 decision 2 (OAuth on every tool, no anonymous tools; PHASE_19's backlog holds a later mixed mode). The `server.json` and the MCP Registry listing are P19-28. The `FEATURES.agentApi` flip, llms.txt and the agent help copy are P19-24. The reviewer pass on the MCP path is P19-27. The /developers page went with them, since its content is P19-24's help article. What remains here is the part PHASE_19 does not cover.

**Problem and evidence.** URL import is built and marketed as coming soon, so the product can't promise "paste a product link" (C-17 in docs/marketing.md). API access is a live Growth entitlement the pricing page never mentions (R, Phase 18 table; N-impl section 8; N-trust section 7). docs/PENDING.md, Phase 16 step 7, asks for pricing copy for API access on Growth and up once the API goes public.

**Today.** `FEATURES.urlImport` and `FEATURES.agentApi` are `coming_soon` (apps/web/src/lib/marketing-facts.ts lines 215 to 236). `apiAccess` is live in the Growth, Pro and Agency entitlements, but `includeLines.growth` (packages/pipeline/src/seed/credits.ts lines 120 to 124) lists only video, Fresh Creative Drop and Shopify auto packs. The claims guard rejects any sentence matching `FEATURES.agentApi.mentions` (`/Curvi API|public API|API keys?\b|\bMCP\b/i`) while that flag is coming soon.

**Change.**
1. **URL import.** After one production import each of a Shopify and an Amazon product (docs/marketing.md MKT-003 step 8 tries one of the two; the builder runs the other with the founder), flip `FEATURES.urlImport` to live in marketing-facts.ts. If either import fails, fix it or leave the flag and record why here.
2. **Growth API line.** Add `{ label: "API keys for the Curvi API and MCP server", feature: "apiAccess" }` to `includeLines.growth` in the seed (rule 2). It ships in the same change as P19-24's `agentApi` flip or after it, never before, because the claims guard blocks the wording while the flag is coming soon. Under PHASE_19 decision 3 the ChatGPT plugin works on every plan, so the line names API keys, which stay Growth and up.

**Copy.** Growth include line "API keys for the Curvi API and MCP server".

**Tests.** The claims test after the `urlImport` flip; a seed test that `includeLines.growth` holds the API line mapped to `apiAccess`; the pricing page render shows it once `agentApi` is live.

**Acceptance.** No page calls URL import "coming soon" after both production imports pass, and Growth's pricing card lists API keys once `agentApi` is live.

**Effort and cost.** XS to S. $0.

**Enables: MKT-010, MKT-015** (claim C-17 in docs/marketing.md section 6.5; link import for concierge packs). Claim C-18 and the agent listings follow PHASE_19 (P19-24, P19-28; MKT-035 and MKT-036).

### P18-18: Store image audit

**Problem and evidence.** R's concierge step is to "Run the free main image checker on stores that sell labeled goods, pick sellers whose images visibly fail or who list on only one channel". Only 40 percent of products show multiple images on retailer sites, so "a public scan of a seller's listing image count could be an outreach hook" (N-market section 6). The store catalog audit is an open growth item in docs/PENDING.md.

**Today.** lib/url-import parses one Shopify product JSON or one Amazon page at a time, signed in. No store wide tool.

**Change.**
- **Route.** `/tools/store-image-audit`. The visitor enters a Shopify store address; the server fetches `/products.json` (rule 7 check) for up to a seeded 25 products.
- **Checks.** It downloads each product's first image through readPhoto's guards (blocked hosts, size cap, 10 second timeout, concurrency 4), runs the main image check against the chosen channel (Amazon by default, any P18-10 channel), and counts images per product.
- **Result.** Free summary without email: products checked, how many would fail, how many have fewer than 3 images. The per product table sits behind the email gate (lead source `store-audit`, P18-06 consent box).
- **Limits.** Seeded in growth.ts: 3 audits per IP per hour, 25 products each, and a site wide daily cap. Amazon storefronts are not supported (they block fetches: `isAmazonBlockPage`).
- **Operator mode.** Inside P18-04 an operator audit lists failing products with a "Make a prospect pack" button per product.
- **No AI calls.** The audit is deterministic.

**Copy.** "Check every main image in your Shopify store against Amazon, Google or Walmart rules. Free, no account." Summary: "{failing} of {checked} main images would not pass {channel}'s rules. {thin} products have fewer than 3 images."

**Tests.** Parser unit tests with a products.json fixture; blocked host and size guards; caps and rate limits; e2e in demo mode with a mocked fetch.

**Acceptance.** An audit of a 25 product store returns in under 60 seconds with per product results, and never fetches a blocked address.

**Effort and cost.** M. $0 (bandwidth and CPU).

**Enables: MKT-014** (optional). Finding concierge prospects in minutes; a lead magnet for store owners; content for "we audited 50 candle stores" posts.

### P18-19: Search pages with evidence

**Problem and evidence.** Build "10 to 30 deep pages, each with something no competitor has: a working per-channel checker, measured examples, or a real before and after"; target the moment of need ("Walmart image size, TikTok Shop main image rules, Google Merchant image disapproval, Amazon main image checkers, and the new AI labeling rules"); Google's scaled content abuse policy rules out thin templates (R, search paragraph; N-acq section 2). Pomelli is "the single biggest positioning threat" and has no page (R, market section; N-comp, platform threats). Organization `sameAs` and an about page are missing (N-impl sections 1 and 2). The top segment is labeled packaged goods (R, segment paragraph), while category pages cover apparel, jewelry, beauty, food, electronics, home, pet and sports only.

**Today.** Two guide pages and two grouped comparison pages in pillar-copy.ts; competitor-facts.ts (checked 2026-09-29) states no prices and no claims about what other tools cannot do; 8 category pages; a requirements page for every spec (`/channels/[channel]/image-requirements`); Organization JSON-LD in apps/web/src/lib/seo.ts (line 236) without `sameAs`; no `/about`, no guides route.

**Change.**
- **Guides.** A `/guides/[slug]` route from typed content modules (the pillar-copy.ts pattern). Start with six: "Amazon main image requirements and why listings get suppressed", "Google Merchant Center image disapproved: what to fix", "TikTok Shop product image rules", "Walmart product image requirements" (only after P18-09 verifies them), "AI images and marketplace rules in 2026" (Google IPTC and Amazon's synthetic performer label, after rule 7 reads), and "One phone photo, every marketplace: how to shoot a labeled product". Each embeds a checker or a real Curvi output, lists dated sources, links the matching requirements page instead of repeating its rules table, and is written or reviewed by the founder. A test requires a `checkedOn` date and at least one source per guide.
- **Comparisons.** `/compare/[slug]` per tool (Photoroom, Pebblely, Claid, Flair, Pomelli, ChatGPT Images) from competitor-facts.ts with new dated rows. The existing policy stays unless the founder changes it. Each page adds "The same photo through both" from the P18-17 benchmark when available.
- **Categories.** Add supplements, candles, coffee and tea, and drinks to categories.ts, with real packs when consented, otherwise labeled illustrations (the existing rule).
- **About.** `/about` and a facts block: who builds Curvi, contact, how proof works, plain pricing facts from the seed. Organization JSON-LD gains `founder` and `sameAs` from a seeded `siteProfiles` list, emitted only when non empty.
- **Search Console.** Optional `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` meta, or DNS verification by the founder.

**Copy.** Pomelli comparison opening: "Pomelli is Google's free tool that turns one product photo into studio and lifestyle shots. Curvi makes a pack for each marketplace's listing rules, and measures that your product was not redrawn. Here is what each one says it does, checked on {date}."

**Tests.** Sitemap includes every new route; JSON-LD validity unit; copy lint and claims test; each guide and comparison has a checked date and sources.

**Acceptance.** At least six guides, five comparisons and four new categories are live and indexed in the sitemap, each with a checker, a real output or benchmark data on the page.

**Effort and cost.** M for code. Founder writing time for content. $0.

**Enables: MKT-025, MKT-039** (MKT-025's profile URLs feed `siteProfiles`). Organic search from month 3 on; pages that AI assistants can cite; landing pages for community answers.

### P18-25: ChatGPT app with the free check (moved to PHASE_19)

**Moved to PHASE_19 (the whole phase; P19-25 packages the plugin, P19-24 adds the `chatgptPlugin` flag).** The ID stays reserved so docs/marketing.md keeps its mapping. The draft's keyless ChatGPT app with no account linking contradicts PHASE_19 decision 2 (OAuth on every tool, no anonymous tools), and PHASE_19 checked OpenAI's plugin rules on 2026-10-01: ChatGPT cannot send API keys at all, and the plugin must not be a worse version than the website (PHASE_19 corrections 1 and 4). Nothing is built here.

**Enables:** no MKT task. MKT-036 (list the ChatGPT plugin) follows PHASE_19.

## Workstream G: Activation

### P18-12: Free white main image before signup

**Problem and evidence.** "Every call to action leads to an email and password form, then the inbox, then a confirmation link, then a welcome page, then an upload, then a pack" (R, funnel section). The build plan asked for "an upload box above the fold that shows a result before signup" (CURVI_BUILD_PLAN.md section 3.1 item 1). Competitors give free generations without signup, and Show HN asks for products people can try "ideally without barriers such as signups or emails" (R; N-acq section 4; N-early section 4).

**Today.** No anonymous upload path; uploads and previews need a signed in workspace (apps/web/src/app/api/uploads/). The white background fixer is a threshold filter, not a cutout. Without Upstash, rate limits are counted in each process and reset on every deploy (apps/web/src/lib/rate-limit.ts lines 7 to 10); docs/PENDING.md lists Upstash "for shared rate limits and the landing page preview".

**Condition.** Starts only when fal is funded (G0 in docs/marketing.md) and `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set, so the per IP cap holds across deploys. The site wide daily cap in `spend_cap_counters` stays the hard spend ceiling either way. If either is missing at Release 4, the item waits and the checker's fail CTA keeps pointing at signup.

**Change.**
- **Entry points.** The home hero (an upload box beside the slider), the checker's "Fix this image free" (P18-10), the fixer page ("Use a real cutout instead"), and the P18-22 landing pages.
- **Route.** `POST /api/preview` takes a multipart body of at most 15 MB and runs, in order:
  1. checks: acquisition `open` (P18-03), `platform_settings.free_preview_enabled` (seeded true), the per IP cap, the site wide daily cap (a `preview:day:<date>` counter in `spend_cap_counters` through PgCapStore, shared by every instance), and the honeypot field;
  2. the existing upload validation and ingest (magic bytes, 80 megapixel cap, EXIF strip; lib/trust/ingest.ts);
  3. intake moderation through `llmJson` with the intake recipe (packages/ai, metered on a platform spend key `preview`), refusing what `moderationBlockReasons` refuses;
  4. the cutout through the live cutout chain (packages/ai);
  5. `makeAmazonMain` (packages/pipeline/src/deterministic/whiten.ts);
  6. `fidelityReport` on the encoded bytes (rule 3; a fail returns "We could not make a clean cutout of this photo").
  The response holds a preview JPEG of about 1000 pixels, the measured checks (white, fill, size), the P18-08 fidelity numbers and a `previewId`.
- **DB, migration `free_previews`** (next free number at build time). Platform table `free_previews`: `id`, `ip_hash` (sha256 with a daily rotating salt), `status`, `blocked_reason`, `cost_micros`, `email_key`, `claimed_workspace_id`, `claimed_at`, `created_at`, `expires_at`. RLS on, no policies, no client privileges.
- **Storage.** The original, the cutout and the full size main go under `anon/preview/{id}/` in R2. Founder step: an R2 lifecycle rule expiring `anon/` after 2 days (the prefix comes first, so a prefix rule works, unlike the `ws/` keys noted in docs/PENDING.md).
- **Full size file.** Needs an email (lead source `free-preview`, P18-06 consent box), then a short lived signed link.
- **Claim.** The signup link carries `preview=<id>`. At confirmation the server copies the objects into the new workspace (`ws/{ws}/src/...` and the cutout cache), so the first pack reuses the cutout at no second charge, then opens /app/new with the photo attached. The claim is single use.
- **Seed.** Caps in growth.ts `freePreview` (per IP per day, site wide per day, max bytes, preview size) per decision 6.

**Copy.** Hero box: "Drop one product photo. Get an Amazon ready white main image in about a minute. Free, no account." Result: "Passes Amazon main image rules. Your product was cut out and placed on pure white, never redrawn: average color difference {mean} inside the product." Next step: "Want the other {n} files, sized for every channel? Create a free account and we will use this photo." Limit reached: "That is today's free previews from this connection. Create a free account to keep going."

**Tests.**
- Route: each cap and switch, a paused acquisition, the honeypot, a moderation block, and a cost booked to the `preview` key.
- Rule 3: preview bytes pass `fidelityReport` on a fixture, and a mutated render fails.
- Claim: copies once, is idempotent, and refuses a second workspace.
- RLS and privilege test for `free_previews`.
- E2E (demo mode with the demo cutout): home upload, then result, then signup carries the preview, then /app/new shows the photo.

**Acceptance.** A stranger gets a measured white main image in under 90 seconds without an account. The daily spend cannot exceed the seeded cap, and the first pack after signup does not pay for a second cutout.

**Effort and cost.** L. About $0.011 per preview (the $0.01 seeded cutout plus a small intake call), at most about $3 a day at the default cap. Upstash's own price is a rule 7 check when the founder sets it up.

**Enables: MKT-041, MKT-042** (Show HN needs a no signup try; rule R6 in docs/marketing.md asks for it when activation is low). Show HN and Product Hunt (a no signup demo), short video calls to action ("try it on your own photo"), ad landing pages.

### P18-13: Google sign in

**Problem and evidence.** Signup is email and password with mandatory confirmation; "There is no Google sign-in", and each step leaks traffic (R, funnel section; N-impl section 3). Supabase's default mail limits make confirmation fragile until custom SMTP is set (N-impl section 3).

**Today.** No `signInWithOAuth`. The callback already exchanges OAuth codes (its header comment says so), records terms and sends the registration conversion. The 0012 trigger grants credits when `email_confirmed_at` is set, including on insert through `bootstrap_workspace`. PHASE_19's P19-09 also edits auth-form.tsx (a `next` prop for its consent page) and app/auth/callback/route.ts (a `next` under /oauth/consent skips /welcome); whichever phase merges second rebases.

**Change.**
- A "Continue with Google" button above the email form on /signup and /login, shown only when `NEXT_PUBLIC_GOOGLE_AUTH=1`. It calls `signInWithOAuth({ provider: "google", options: { redirectTo: <origin>/auth/callback?next=...&attr=<base64url attribution> } })`.
- The clickwrap terms line sits above both buttons.
- The callback reads `attr` for P18-01 and records `method = google` and `signup_confirmed`.
- Founder steps: a Google Cloud OAuth client and consent screen, then the Supabase Google provider with the callback URL (rule 7 read).
- Verify that Google users arrive confirmed, so the 15 credit grant pays at once. Add a test against the trigger with a confirmed insert.

**Copy.** "Continue with Google". Terms line unchanged.

**Tests.** The form shows the button only with the flag; the redirect URL carries `next` and `attr`; the callback parses `attr` safely (bad input dropped); a DB test that a confirmed insert pays the grant once.

**Acceptance.** A Google signup lands on /welcome with 15 credits and an attribution row with `method = google`.

**Effort and cost.** S. $0.

**Enables: MKT-042** (and rule R6 in docs/marketing.md). Lower friction for every channel, especially mobile traffic from short video.

### P18-20: First run for the top segment

**Problem and evidence.** The first target is sellers of labeled packaged goods on two or more channels, the second small agencies (R, segment paragraph). Activation needs value in the first session (N-early section 4). Today a new user meets an empty dashboard with no example and no question about what they sell (N-impl section 3).

**Today.** /welcome and the dashboard "Get your first pack" card; real candle pack files already ship in apps/web/public/home/pack/; channel choices exist in packages/pipeline/src/seed/questions.ts `channelChoices`; there is no seller profile.

**Change.**
- **Example pack.** An "Example pack" panel on an empty dashboard shows the real candle pack files (no compute), labeled "Example made by Curvi from one candle photo".
- **Questions.** Two optional questions on /welcome. "What do you sell?" uses seeded `sellerCategories` in growth.ts (beauty and skincare, supplements and health, candles and home fragrance, food and drink, coffee and tea, pet, home goods, apparel, jewelry, electronics, other). "Where do you sell?" uses `channelChoices`. Both are skippable.
- **DB, migration `seller_profile`** (next free number at build time). `workspaces.seller_profile jsonb` with an object check. RLS on `workspaces` unchanged (members read); written only by the server.
- **Use.** The profile prefills channels on /app/new when the workspace has no remembered choices; P18-07 copy and the P18-02 digest segment by it; category and channel pages pass `category` and `channel` through `signupHref` to preselect the answers.
- **Event.** `segment_answered`.

**Copy.** "Two quick questions so your first pack fits. You can skip them." Example label "Example made by Curvi from one candle photo".

**Tests.** Prefill logic unit; DB test for the column (members read, client writes refused); e2e welcome answer and skip.

**Acceptance.** A user who answers "candles" and "Amazon, Shopify" sees those channels preselected on their first pack.

**Effort and cost.** S. $0.

**Enables: MKT-050** (rule R6 and section 5.6 in docs/marketing.md name it as an activation fix). Category and channel landing pages that convert into the right first pack; a segmented funnel for the day 90 "narrow" decision.

## Workstream H: Offer and referral

### P18-21: Founding member offer and per pack price framing

**Problem and evidence.** Curvi's $29 Starter costs two to three times the $8 to $15 entry prices most rivals charge; price should be framed against what sellers replace ("About $1.15 per finished, checked listing pack" against "about $40 per photo at a studio"); the founding offer exists only as seed data while "Stripe Checkout already accepts promotion codes" (R, market and Phase 18 sections; N-comp, pricing; N-impl section 4). Q4 prep runs from about 2026-10-08 to late November (R, calendar paragraph).

**Today.** `foundingMemberOffer = { monthlyUsd: 19, annualUsd: 190, seats: 50 }` (packages/pipeline/src/seed/credits.ts line 342) with no consumer; CURVI_BUILD_PLAN.md says 50 seats at line 544 and 100 at line 622; `allow_promotion_codes: true` (apps/web/src/lib/billing/checkout.ts line 72); pricing shows credits and "About 25 listing packs a month".

**Condition.** The public banner waits for founder decision 18 (generative still price), because a discounted plan loses money on scenes at today's price. The 1:1 founding code in docs/marketing.md MKT-021 does not wait for this item.

**Change.**
- **Seed.** `foundingMemberOffer` gains `code` and `endsOn` (decision 13); the seat count stays the seed's, and the banner reads it from there.
- **Stripe (founder steps).** A coupon and promotion code that bring Starter to $19 monthly or $190 yearly forever, with `max_redemptions` = seats and an expiry on `endsOn`.
- **Seat counter.** Count `checkout_completed` funnel events whose props carry the code (P18-02 records the promotion code from the completed session after the rule 7 check), and show "{left} of {seats} founding seats left". Hidden after `endsOn`, at zero seats, or while acquisition is waitlisted.
- **Banner.** Dismissible, on pricing and home.
- **Per pack price.** Each paid tier's card adds "About ${perPack} per listing pack", computed from the seed (monthly price divided by the typical packs from `marketing-facts.ts`). One dated comparison line names the studio price (Soona, rule 7 row).
- **Money back.** The decision 14 copy ships on pricing, help and terms only after the legal review. Refunds are made by the founder in Stripe; `charge.refunded` handling already exists.

**Copy.** Banner: "Founding member price: Starter at $19 a month for as long as you stay. {left} of {seats} seats left, until {date}. Use code {code} at checkout." Card line: "About ${perPack} per listing pack." Comparison: "A studio charges about $40 per photo."

**Tests.** Per pack math from the seed (no literals); banner visibility by date, seats and acquisition state; copy lint; e2e pricing shows the line and the banner.

**Acceptance.** Pricing shows a per pack price for each paid tier that matches the seed, and the banner disappears at zero seats or after `endsOn`.

**Effort and cost.** S. The only cost is the discount.

**Enables: MKT-021, MKT-050** (and rule R11 and messaging pillar D in docs/marketing.md). The Q4 push and founding member code; the "per pack, not per credit" message in outreach and video.

### P18-22: Message test landing pages

**Problem and evidence.** The justified paid test is "two to four headlines to one landing page", judged by click through, time on page and hand counted tagged signups, and the winning message then moves into free channels (R, paid ads section; N-ads section 8). The ChatGPT campaign "has no creatives", and its ad unit is a headline, a description and one image (N-ads section 2).

**Priority.** P3: built only if the paid message test runs (docs/marketing.md MKT-047, after the day 14 and day 30 gates). Until then the test uses existing pages with UTM tags.

**Today.** No noindex landing pages; the home page carries every message at once.

**Change.**
- `/lp/[variant]` noindex pages from `apps/web/src/components/marketing/lp-variants.ts`. Each variant has a headline, subhead, one proof block (a real before and after with numbers), the P18-12 upload box (or the checker while previews are off) and one CTA via `signupHref({ source: "lp_<variant>" })`.
- Starting variants: `label-test`, `every-channel`, `amazon-main`, `walmart-launch`, `tiktok-beauty`.
- The P18-02 digest groups signups by `lp_` source and UTM campaign.

**Copy.** label-test: "General AI image tools redraw your product. Curvi never does, and every file proves it." every-channel: "One photo in. A pack for Amazon, Walmart, Shopify, TikTok Shop and Google out." amazon-main: "Is your Amazon main image losing you clicks? Check it free, then fix it without redrawing your product."

**Tests.** Every variant renders, is noindex and passes the copy lint; the CTA carries its source.

**Acceptance.** Five variants are live and each signup from them shows its variant in the digest.

**Effort and cost.** S. $0 (ad spend is the founder's separate, capped decision).

**Enables: MKT-047** (optional). The capped $100 to $200 message test after day 30; ChatGPT ads creative.

### P18-24: Referral give and get credits

**Problem and evidence.** "The referrals table exists with row-level security, but no code issues codes or rewards"; R recommends "two-sided referral credits using the existing referrals table and referral ledger reason, granted after the referred user's first payment and capped per account", in days 45 to 90 (R, funnel and Phase 18 sections; N-acq section 9; plan 9.6.2).

**Today.** `referrals` (code primary key, one `referred_workspace_id`, referrer workspace id, rewarded_at; packages/db/src/schema.ts lines 586 to 602), readable by the referrer's members; ledger reason `referral`; no code path. R's "using the existing referrals table" is overstated: with one row per code, one shareable code per referrer cannot record several referees, so the table needs the migration below.

**Condition.** Rewards switch on (`referrals_enabled`) only after founder decision 18, because reward credits spent on scenes lose money at today's price.

**Change.**
- **DB, migration `referrals`** (next free number at build time).
  - New tenant table `referral_codes`: `workspace_id` (primary key, cascade), `code` (unique), `created_at`. Members select their own; the server writes.
  - Rework `referrals`, after confirming it is empty in production: `id uuid` primary key; `code` becomes a plain column referencing `referral_codes.code`; add `status` (`pending`, `qualified`, `rewarded`, `rejected`), `qualified_at`, `reject_reason`, and a unique `referred_workspace_id`. Keep `referrals_select_member`.
- **Codes.** Issued lazily on `/app/settings/referrals` (owners and admins): 8 characters of base32. `/r/<code>` redirects to `/?ref=<code>&utm_source=referral&utm_medium=referral`, and P18-01 carries `ref` to signup.
- **Signup.** At confirmation a `pending` row is created when the code is valid, is not the new user's own workspace, and the normalized email key has never had a grant before.
- **Qualify and reward.** On the referred workspace's first payment (the P18-02 `first_payment` hook in the Stripe webhook):
  - qualify, then grant both sides seeded `referralReward.credits` (decision 12) as ledger rows with reason `referral`, source `system` and `expires_at` 12 months out, idempotent per referral id;
  - reject when the referrer passed the monthly cap or both sides share a Stripe customer;
  - claw both grants back with negative `referral` ledger rows on a refund or dispute of that first payment within 30 days, added beside the existing refund and dispute clawback in apps/web/src/lib/billing/stripe-webhook.ts.
- **Switch.** `platform_settings.referrals_enabled` is seeded false.
- **Email.** The referrer gets a P18-07 template when rewarded.
- **Events.** `referral_link_created`, `referral_signup`, `referral_qualified`, `referral_rewarded`.

**Copy.** Settings: "Give 50 credits, get 50 credits. When someone you invite starts a paid plan, you both get 50 credits." Link label "Your invite link".

**Tests.** RLS tests for `referral_codes` and the reworked `referrals`. Ledger idempotency. Self referral and cap rejections. Webhook qualification. Clawback on refund. The migration against an empty table and a refusal path documented for a non empty one.

**Acceptance.** A referred signup that pays produces exactly two reward rows, once, and a refund within 30 days reverses both.

**Effort and cost.** M. 100 credits per rewarded pair, about 12 packs, roughly $2 to $6 of provider spend if all are used.

**Enables: MKT-044, MKT-045** (T-EM-08 in docs/marketing.md fills its numbers from this item's seed values). The referral loop in days 45 to 90.

## Data model summary

Migrations are named, not numbered (principle 10). The table lists them in planned release order. Each takes the next free number when its lane runs `pnpm db:generate` after rebasing on the newest main: after 0026 on main, after `0027_site_visits` if `site-visitors` merges first, and after PHASE_19's `mcp_connections` if that lands first. If the order changes, the lane that merges second renumbers its file and regenerates the Drizzle journal and snapshot (packages/db/migrations/meta) before merging; never two lanes generating at once.

| Migration (name) | Item | Change | Kind | RLS and test |
| --- | --- | --- | --- | --- |
| `attribution_and_funnel` | P18-01, P18-02 | `signup_attributions`; partial unique index `events_funnel_first_uq` on `events (workspace_id, name)` where `name like 'funnel.first_%'` | Tenant table; index | Owners and admins read own; no client writes. packages/db/src/attribution.test.ts |
| `lifecycle_email` | P18-06 | `email_sends`, `email_suppressions`; `leads.marketing_consent_at`, `leads.consent_source` | Platform tables; columns | RLS on, no policies, no client privileges (the `leads` precedent). packages/db/src/lifecycle-email.test.ts |
| `pack_feedback` | P18-05 | `pack_feedback` | Tenant table | Members read; server writes. packages/db/src/pack-feedback.test.ts |
| `pack_claims` | P18-04 | `pack_claims` | Platform table | No client access. packages/db/src/pack-claims.test.ts |
| `share_proof` | P18-16 | `share_links.show_proof` | Column | Existing policies; test that members read and cannot write. packages/db/src/share-proof.test.ts |
| `free_previews` | P18-12 | `free_previews` | Platform table | No client access. packages/db/src/free-previews.test.ts |
| `seller_profile` | P18-20 | `workspaces.seller_profile` with an object check | Column | Existing policies; test as for `share_proof`. packages/db/src/seller-profile.test.ts |
| `deploy_restarts` | P18-23 | `generation_jobs.restart_count` | Column | Existing policies; a test that clients cannot write it. packages/db/src/deploy-restarts.test.ts |
| `referrals` | P18-24 | `referral_codes`; `referrals` reworked (id primary key, status, qualified_at, reject_reason, unique referred workspace) | Tenant table; table change | Members read own codes; referrer members read referrals; server writes. packages/db/src/referrals.test.ts |

No migration: P18-02's events (existing table), P18-03 (events and platform_settings rows), P18-08 (`assets.qc` jsonb), P18-09 (registry and seed), P18-10, P18-11, P18-13, P18-14, P18-15, P18-17, P18-18, P18-19, P18-21, P18-22. P18-25 moved to PHASE_19.

Seed additions (rule 2):
- **New `packages/pipeline/src/seed/growth.ts`:** `signupSourceChoices`, the allowed `source` keys, `validationGates`, `emailLimits`, `lifecycleSchedule`, `freePreview`, `staffMonthlyCreditCap`, `deployRestarts`, `sellerCategories`, `siteProfiles`, the store audit caps, and the claim lifetime.
- **`monitoring.ts`:** `falBalanceLines` and the balance account list.
- **`credits.ts`:** `includeLines.growth` API line (with or after P19-24's `agentApi` flip), `foundingMemberOffer.code` and `endsOn`, `referralReward`.
- **`platformSettingSeedRows`:** `acquisition_paused` false, `free_preview_enabled` true, `lifecycle_email_enabled` false, `referrals_enabled` false, plus the white or clear background switch from P18-09.
- **Recipes:** shot_planner v4 at `trafficPct: 0`, with its own `SHOT_PLANNER_V4_SYSTEM` constant (P18-09 part 3). No qc_judge change in this phase.
- **Registry:** Walmart and TikTok Shop updates after verification (P18-09 part 5).

New environment variables (listed in docs/LAUNCH_CHECKLIST.md with what happens when unset; the founder adds them to `.env.example` by hand, because env files are blocked for the agents):

| Variable | Item | When unset |
| --- | --- | --- |
| `FAL_ADMIN_KEY`, optional `FAL_ADMIN_KEY_BACKUP` | P18-03 | No balance probe; the gate still reacts to quota answers; health warns |
| `OPS_EMAILS` (from `site-visitors`; added here only if that branch has not merged) | P18-02, P18-04, P18-14 | Operator pages answer 404 for everyone; no gallery entry gets the team label |
| `LIFECYCLE_EMAIL_FROM`, `LIFECYCLE_REPLY_TO` | P18-06 | No customer email is sent |
| `CURVI_LINK_SECRET` | P18-05, P18-06, P18-12 | Signed links are not issued; emails with links are skipped |
| `CURVI_POSTAL_ADDRESS` | P18-06 | Marketing email is skipped; transactional email still goes |
| `RESEND_WEBHOOK_SECRET` | P18-06 | The bounce webhook answers 503 |
| `NEXT_PUBLIC_GOOGLE_AUTH` | P18-13 | No Google button |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` (optional) | P18-19 | No meta tag |
| `CURVI_DEMO_ACQUISITION` (tests only) | P18-03 | Ignored outside demo mode |

Existing variables these items need set: `CRON_SECRET` (every new cron route), `FOUNDER_ALERT_EMAIL` and `RESEND_API_KEY` (P18-02, P18-03), `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (P18-12).

## Tests (summary)

| Package | Tests |
| --- | --- |
| packages/db | One RLS or privilege test file per migration above; `recordFunnelEvent` first only semantics; the 0012 grant for a confirmed OAuth insert. |
| packages/ai | `probeFalBalance` against a fake fetch (200, 401, 403, timeout). |
| packages/pipeline | The offline fidelity heatmap (P18-17); IPTC round trips for JPEG, PNG and WebP; seed tests for growth.ts, shot_planner v4 (only the one phrase differs from v2's prompt; v1 to v3 unchanged) and every new platform setting; per channel checker rules from the registry; the benchmark JSON schema. |
| packages/email | `dueEmails` table tests; template lint (rule 9, claims, no expiry urgency); link signing; suppression; dedupe. |
| trigger | `qc.fidelity` saved by `saveAsset` and follow ups; quota emails for cutout and image providers; the jewelry plan without a hand; rule 3 suites unchanged; `smoke:iptc` argument handling. |
| apps/web | Attribution parsing, the extended `signupHref` and the bare `/signup` source scan; the callback writes (attribution, claim, preview, referral); acquisition state and `/api/status`; cron auth and outputs for funnel-digest, lifecycle and provider-balance; the operator gate on every operator page and action; preview caps, moderation and claim; the checker channel picker; store audit guards and caps; report and PDF rows; API contract against OpenAPI; per pack price math; inline runner drain and boot requeue; referral webhook paths; claims and copy lint for every new copy module. |
| e2e | New specs: attribution (every primary CTA carries a source), acquisition gate (demo waitlist), email gate consent and unsubscribe, feedback card, share Make mine attribution, share proof panel, checker channel picker, home preview to signup to first pack (demo cutout), Google button presence, welcome questions and prefill, pricing offer banner and per pack line, landing pages, operator prospect flow, store audit with mocked fetch. Existing failures named in PHASE_16 (e2e/home-hero.spec.ts and e2e/claims.spec.ts) are fixed or recorded before this phase's gate. |
| eval | `--stage benchmark` (founder, live keys); the P18-09 shot_planner canary with `pnpm eval` and the prompt-eval agent. |

## Sequencing and parallelization

### Contract first (day 1, serial)

One small commit on `p18/integration` before any lane starts, so every lane codes against the same seams:
- `packages/db/src/funnel.ts` with the `recordFunnelEvent` signature and the event name list;
- `apps/web/src/lib/attribution.ts` with `readLandingParams`, and the extended `signupHref` signature in billing/intent.ts;
- `apps/web/src/lib/ops.ts` `isOperator` over `OPS_EMAILS`, copied unchanged from `site-visitors` if that branch has not merged;
- an empty `packages/pipeline/src/seed/growth.ts` wired into the seed index;
- the new `LEAD_SOURCES` values (`packs-paused`, `free-preview`, `store-audit`);
- this file's migration names and order (numbers are assigned at generation time, principle 10).

### Lanes (separate subagents in separate git worktrees)

| Lane | Branch | Items, in order | Migrations (named) | Must wait for |
| --- | --- | --- | --- | --- |
| 1 Measure | p18/measure | P18-01, P18-02, then P18-15 (verification row only, unless ads run) | `attribution_and_funnel` | Contract commit |
| 2 Resilience | p18/resilience | P18-03, then P18-23 | `deploy_restarts` | Contract commit |
| 3 Email | p18/email | P18-06, then P18-07 | `lifecycle_email` | Lane 1 merged before P18-07 merges (it reads funnel events) |
| 4 Proof | p18/proof | P18-08, then P18-16, then P18-17 | `share_proof` | Contract commit; fal funded for P18-17 |
| 5 Claims | p18/claims | P18-09 parts 1 and 2 first (Release 1), parts 3 to 5 later | none | Contract commit |
| 6 Concierge | p18/concierge | P18-05, P18-14, then P18-04 | `pack_feedback`, `pack_claims` | Lane 4's P18-16 for the proof default (feature detect until then) |
| 7 Search | p18/search | P18-10, P18-11, P18-18, P18-19 | none | P18-09 part 5 before the Walmart and TikTok Shop checkers; PHASE_19's P19-24 for P18-11's Growth line; PHASE_19's tool work for P18-10's API parameter |
| 8 Activation | p18/activation | P18-13, P18-20, then P18-12 | `seller_profile`, `free_previews` | Lane 2's P18-03 merged before P18-12 merges; fal funded and Upstash set for P18-12 |
| 9 Offer | p18/offer | P18-21, P18-22 (only if the paid test runs), then P18-24 | `referrals` | Lane 1 merged (webhook events); founder decision 18 before the banner and rewards go live; P18-12 for the landing page upload box (falls back to the checker) |

Serial constraints and shared files (merge in this order, rebasing the later lane):
- **auth-form.tsx and the auth callback:** Lane 1, then Lane 8 (Google, preview claim), then Lane 6 (claims), then Lane 9 (referrals). PHASE_19's p19/consent (P19-09) edits both files too; whichever phase merges second rebases.
- **Share page and share panel:** Lane 6 P18-14, then Lane 4 P18-16, then Lane 6 P18-04.
- **Stripe webhook:** Lane 1 (events, conversions), then Lane 9 (offer counter, referrals).
- **compliance-report.ts, compliance-pdf.ts and api-v1 schemas:** Lane 4 only within this phase. PHASE_19's p19/tools owns apps/web/src/lib/api-v1/actions.ts, the MCP tool definitions and chat views during its build, so P18-08's API field and P18-10's API parameter rebase onto it.
- **marketing-facts.ts `FEATURES` and llms.ts:** Lane 5 (claim sentences), then Lane 7 (`urlImport`); PHASE_19's p19/site flips `agentApi`, adds `chatgptPlugin` and owns the llms.txt agent sections.
- **Home hero:** Lane 2 (CTA wrapper), then Lane 8 (upload box).
- **rate-limit.ts:** Lanes 7 (store audit) and 8 (preview) each add policies, and PHASE_19's P19-21 adds MCP policies; the later one rebases.
- **credits.ts:** Lane 7 (includeLines, with P19-24), then Lane 9 (offer, rewards); PHASE_19's P19-03 adds `assistantAccess`.
- **New growth numbers** go to growth.ts sections owned per lane to avoid conflicts.
- **Migrations** are generated after rebasing on the newest main and applied to production only in numeric order (principle 10).

Agents per CLAUDE.md:
- **reviewer.md** reviews P18-01, P18-03 (public status endpoint), P18-04 (operator gate and claims), P18-06 (tokens and webhook), P18-12 (anonymous upload and spend), P18-18 (server side fetches) and P18-24 (ledger) before each merge. The API and MCP review is PHASE_19's (P19-27).
- **test-writer.md** writes each lane's Vitest and Playwright specs.
- **prompt-eval.md** runs `pnpm eval` for the P18-09 shot_planner version.

### Release order (tied to the first 30 days of docs/marketing.md)

Day 1 is 2026-10-01. The marketing plan's first week is founder setup and hand made packs, which do not wait for code; each release below unblocks the next part of that plan.

| Release | Target | Items | What it unblocks in the marketing plan |
| --- | --- | --- | --- |
| 1 (P0) | Day 5 | P18-01, P18-02, P18-03, P18-09 parts 1 and 2, P18-14, P18-05, and P18-15's docs/verification.md row | Days 0 to 7 "make it work, make it countable": tagged links, the waitlist gate, the weekly funnel, the truthful claim, attributed share links, the day 14 feedback question |
| 2 (P1) | Day 10 | P18-04, P18-06, P18-07 (welcome, pack ready, nudges, packs back), P18-08 | Days 3 to 21 concierge at speed; follow up of every signup; measured numbers for the first "label test" videos (week 2) |
| 3 (P1) | Day 17 | P18-10, P18-11 (URL import now; the Growth line with P19-24), P18-13, P18-16, P18-20, P18-21 (banner after decision 18) | Weeks 2 to 6 directory sweep and "paste a product link" copy; community "check your main image" answers per channel; proof links; founding code for the Q4 push (from 2026-10-08). The MCP Registry and live API copy follow PHASE_19. |
| 4 (P2, P3) | Day 28 | P18-12 (once fal is funded and Upstash is set), P18-17 (once fal is funded), P18-18, the first P18-19 pages; P18-15 and P18-22 only if an ad or message test will run | Weeks 3 to 10 search pages; the no signup demo needed before Show HN and Product Hunt; measured conversions and landing pages ready for an optional ad test after the day 30 gate |
| 5 (P2) | After day 30, only if the day 30 gate is met | P18-23 (earlier if Lane 2 is free), P18-24 (after decision 18), the rest of P18-19, P18-09 parts 3 to 5 | Days 45 to 90 referral loop and launches |

If the day 14 gate fails (fewer than 10 of 30 packs usable), Releases 3 to 5 pause and the builder works on pack quality instead, as R prescribes.

## Rollout and verification

### Each release

1. Plan detail in this file first (rule 1). Each lane passes `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` in its worktree, then the integration branch passes the same gate after every merge.
2. The reviewer agent signs off on the items listed above.
3. Production database, through the Supabase SQL editor on the direct connection (docs/verification.md, Supabase row):
   - apply the release's migrations in numeric order, after any earlier migration from another branch (`0027_site_visits`, PHASE_19's `mcp_connections`) that production does not have yet;
   - then run `pnpm db:seed` against production. It writes growth.ts values, the new `platform_settings` rows, include lines, offer fields, registry changes and recipe versions at `trafficPct: 0`.
   - Re-seeding resets recipe canaries, so keep the seed's `trafficPct` in step with production (PHASE_17 known gaps).
4. Render, the Curviai service: add the release's variables with Save only.
5. Push main. Packs run inline in the web process, so there is one deploy and no separate worker step. Then check `/api/health` and `/api/status`.
6. Founder smoke test from docs/LAUNCH_CHECKLIST.md step 16, plus the release's own checks:
   - Release 1: a tagged signup shows its row, and the funnel digest dry run works.
   - Release 2: a prospect link is created, and the welcome and pack ready emails arrive.
   - Release 3: a Shopify and an Amazon product link each import into a pack in production, and the checker applies Google's rules when Google is picked.
   - Release 4: a home preview is claimed into a first pack with no second cutout charge.
7. Flip runtime switches only after their checks pass: `lifecycle_email_enabled`, `referrals_enabled`, and the canary steps for the P18-09 shot_planner version.
8. Record each external fact read and each founder step done, with its date, in docs/verification.md, and update "Implementation status" below.

### Founder steps (mirror into docs/PENDING.md as "Phase 18 founder steps")

1. Top up fal.ai, create a fal Admin API key, and set `FAL_ADMIN_KEY` (decision 8).
2. Approve committing the render.yaml change (plan `1c-2g`, `CURVI_INLINE_PACK_CONCURRENCY` "2") so the repo matches the service, and set `CURVI_INLINE_PACK_CONCURRENCY` = 2 and `maxShutdownDelaySeconds` 300 on the live Render service, which ignores render.yaml (LAUNCH_CHECKLIST steps 8 and 9).
3. Verify the Resend sending domain and configure Supabase custom SMTP through Resend (steps 2 and 3); make one outside signup end to end.
4. Make one real Stripe live purchase and refund it (step 10).
5. Set `NEXT_PUBLIC_POSTHOG_KEY` (step 12).
6. With `CRON_SECRET` set, extend the existing cron commands instead of adding services: the stale-jobs cron also calls lifecycle and provider-balance; the daily purge-source-media cron also calls funnel-digest (it sends once per ISO week). If a scheduler cannot chain calls, one extra Render cron service costs $1 a month minimum.
7. Provide the postal address (decision 4), `LIFECYCLE_EMAIL_FROM`, `LIFECYCLE_REPLY_TO` and `CURVI_LINK_SECRET`.
8. Set `OPS_EMAILS` (if not already set for /app/ops/visitors), and unpublish the test and third party branded gallery packs (docs/marketing.md MKT-009).
9. Add the R2 lifecycle rule for `anon/` (2 days).
10. Run `smoke:iptc` on one delivered lifestyle file.
11. Moved to PHASE_19: the MCP Registry domain proof and publishing (P19-28).
12. Moved to PHASE_19: the real MCP client test and the `agentApi` flip (P19-12, P19-24).
13. Set up Google OAuth in Google Cloud and Supabase.
14. Create the founding member coupon and promotion code.
15. Gather 10 to 20 owned or consented labeled products for the benchmark, and run it.
16. Complete the legal review before the money back copy (decision 14).
17. Decide the generative still price (decision 18) before the founding banner and referral rewards go live.
18. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` before P18-12 (check Upstash's price on the day, rule 7).
19. Run the jewelry inspection with the agent (P18-09 part 4) and record what it shows.

### Gate

Phase 18 is done only when `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` passes on the integration branch with every shipped item merged (rule 6), and the production migrations and seed above have been applied in order.

### Measurement plan

Every metric below is read from the P18-02 weekly email or its saved SQL, unless it says otherwise. "Gate" refers to R's dated thresholds.

| Item | Metric | Target or decision |
| --- | --- | --- |
| P18-01 | Share of confirmed signups with any source (self reported, UTM or page) | At least 80 percent; below that, make the field more visible |
| P18-02 | Digest delivered every Monday; gate table filled | Used for every gate decision on days 14, 30, 60 and 90 |
| P18-03 | Hours waitlisted per week; `packs-paused` leads; alert lead time before a pause | No visitor reaches a paused pack without the notice; alerts arrive before the pause line |
| P18-04 | Prospect packs made; claims redeemed over links sent | 20 to 30 completed packs by day 14 (gate); a claim rate of 10 percent or better keeps the channel |
| P18-05 | "Yes, as they are" share among answers; consented quotes | Half or more usable and at least 3 asking for more by day 14 (gate) |
| P18-06 | Bounce rate; complaint rate; unsubscribes | Bounces under 2 percent, complaints under 0.1 percent (Gmail's hard line is 0.3) |
| P18-07 | Signups with a first pack within 7 days; nudge to pack rate; pack ready to download rate | 35 percent activation by day 30 (gate); under 20 percent means fix onboarding before more traffic |
| P18-08 | Share of new delivered files with fidelity numbers | 100 percent |
| P18-09 | Claims test green; production IPTC check done; jewelry inspection recorded | All green before proof claims go into ads or comparison pages |
| P18-10 | Checker runs per channel; leads from checkers; fail to "fix free" clicks | Keep the channels that bring leads; drop copy that does not |
| P18-11 | Production imports that work; signups whose first pack came from a link; API keys created after the Growth line ships | URL import stays live only while imports keep working |
| P18-12 | Preview to signup rate; preview to first pack; preview spend per day | 15 percent preview to signup or better; spend under the cap every day |
| P18-13 | Share of signups through Google; confirmation completion by method | Keep if it lifts completed signups |
| P18-14 | Share driven signups; share clicks by network | At least one organic share driven signup by day 60 (gate) |
| P18-15 | Only if ads run: conversions accepted; digest and Ads Manager counts within 20 percent | Required before any OpenAI Ads test |
| P18-16 | Shares with proof on; signups from proof shares | Proof shares convert at least as well as plain ones |
| P18-17 | Page live; outside links and citations; monthly assistant prompt log (docs/marketing.md) | Curvi named in at least one assistant answer by day 90 |
| P18-18 | Audits run; leads; prospects created from audits | Most concierge prospects come from audits by week 3 |
| P18-19 | Indexed pages; Search Console impressions and clicks per page | Rankings expected in months 3 to 6; prune pages with no impressions by month 6 |
| P18-20 | Answer rate; first pack rate with prefill against without | Keep the questions if answer and activation rates hold |
| P18-21 | Founding seats used; checkouts from the banner | First 1 to 5 stranger payments by day 30 (gate) |
| P18-22 | Click through and signups per variant (hand counted) | The winning headline moves into free channels |
| P18-23 | Packs restarted per deploy; packs failed by a restart | Zero failed by a deploy |
| P18-24 | Referral signups; qualified and rewarded referrals | Any rewarded referral by day 90 keeps it; none means retire it |
| P18-25 | Moved to PHASE_19 | PHASE_19 measures the plugin |

## Done when

- Every item in Releases 1 to 4 is merged, or recorded below with a founder decision to defer it.
- Every shipped item has its tests, and the rule 6 gate passes on the integration branch.
- docs/verification.md has dated rows for every external fact in the table above that a shipped item uses, plus the missing OpenAI Ads conversion row.
- Production has every shipped item's migration, applied in numeric order, and a fresh `pnpm db:seed` with the seed's `trafficPct` in step with production.
- The weekly funnel email has arrived at least once with real data, and the acquisition gate has been tested by switching `acquisition_paused` on and off in production.
- No marketing string claims byte identity outside kept photos, or a coming soon feature as live.

## Implementation status

Not started. Record per item: status, branch and merge commit, deviations from this plan, known gaps, and what still needs a live run, as PHASE_16 and PHASE_17 do.

## Backlog (not in Phase 18)

- **Distribution:** a Shopify app with Shopify billing (after the day 90 gate); Canva Premium Apps; Zapier; Etsy and eBay sync; affiliate software (only once a partner is producing); outreach in languages other than English for China based Amazon sellers (N-market section 1).
- **Store audit follow on:** a paid "fix all" step from the store audit.
- **ChatGPT and agents:** everything is PHASE_19's (the plugin, OAuth, the MCP Registry, the `agentApi` flip). Its backlog holds a mixed mode with an anonymous main image check. A /developers page (dropped from P18-11) can follow P19-24's help article if agents bring signups.
- **Proof:** per file fidelity heatmaps on the pack page and share pages (dropped from P18-16; P18-17 builds the renderer for the benchmark).
- **People check:** a `person_present` qc_judge issue (a new judge version, eval and canary) and a registry `noPeople` rule, only if the P18-09 part 4 inspection finds a person.
- **Quality:** OCR label checks (`semanticChecks` is built but unwired) to add a text match row next to color difference; C2PA signing.
- **Bot protection:** Cloudflare Turnstile on the preview and audit if abuse appears.
- **Reporting:** a cost per pack dashboard.
- **Email:** Loops, if the email volume or editing needs outgrow Resend.


