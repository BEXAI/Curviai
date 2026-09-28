# Pending work

Date: 2026-09-28. Production: main 939dc1b on Render, database at migration 0013 and seeded.

The discovery sweep of 2026-09-28 found 205 open items (docs/phases/PHASE_10.md). Batch 1 addressed 88 of them. The 117 items below have not been started. Duplicates across the sweep are merged here. Nothing in this file is built yet.

## Can build now (no account or founder decision needed)

### Conversion and activation
- In-app before and after reveal, with a "Share this makeover" prompt.
- Out of credits and upgrade prompts at paywall moments; credit balance display.
- Start a pack from a pasted Shopify or Amazon product URL.
- Pack ready notice in the app (email needs Resend).

### Core app
- Seller inputs the planner needs: multiple photos with angle roles, SKU, box contents, comparison facts. Unlocks the in_the_box and comparison shots.
- Products library with pack history.
- Retry a needs review shot, add a missing angle, cancel a running pack (POST /api/jobs/[id]/cancel).
- Brand kit fonts, logo and style preset used in packs (today only colors are).
- Readable compliance report view and compliance-report.pdf.
- Light editor: crop, shadow strength, background swap (/api/assets/:id/edit). Largest item.
- Concept Mode that really renders labeled concept images, or keep it hidden (hidden today).

### Growth
- Real share pages at /s/[slug] and an opt-in customer gallery.
- Store email captures (leads table, /api/leads) and email gate the free tools' full results.
- Free tool fixes: transparent pixels read as black (Update.md 6.9); checker ignores the 90 percent fill maximum (6.10).
- Store catalog audit with a paid "fix all" step, grown from the free checker.
- SEO depth: hub pages, internal links, more help articles.
- "Made with Curvi" badge on social exports only.

### Trust and platform
- Self serve account deletion and data export, plus a 30 day source media purge.
- Server side upload ingest: magic bytes, 80 MP cap, EXIF strip, video length.
- Cookie consent for analytics and unsubscribe links.
- Read recipes from the recipes table at runtime (A/B splits), and model failover so models swap without a deploy.
- noUncheckedIndexedAccess for app code (Update.md 7.6).
- Server side terms acceptance record (today it lives in editable user metadata).
- Report only Content Security Policy.
- Scheduled stale job sweep (cron route) and the (status, updated_at) index.

### Retention
- Cancel flow with save offers: pause, downgrade, discount. UI can be built now; live offers need Stripe.
- Team invites, seats, workspace switcher and client review links (Agency tier).
- Video template fixes (Update.md 7.1 to 7.3), ready for when rendering is turned on.

## Blocked on accounts or founder decisions

### Stripe (keys, prices and portal setup, docs/STRIPE_SETUP.md)
- Everything that takes money: founding member offer, trials, paywall checkout, referral and affiliate rewards, churn score, real MRR in the weekly digest.
- Tax handling decision (Stripe Tax or a merchant of record).

### Pricing decisions
- Reprice generative stills (1 credit sells for about $0.08 to $0.145; each costs about $0.17) and top up packs.
- Rollover and expiry policy, then enforce it with credit lots (cap annual plans by months paid).
- Mix for Amazon's 8 secondary image slots (default today: 2 lifestyle scenes and the infographic keep their slots).

### Legal
- Terms and privacy fit for paid customers: refunds, cancellation, credit clawback on downgrade (the balance can go below zero), company details, counsel review.
- Disclosure for AI generated people in ads; Amazon policy check.

### Hosting and messaging
- Render paid plan (the free plan sleeps and kills running packs on every deploy).
- Resend sending domain (SPF, DKIM, DMARC) and Supabase custom SMTP, so signup and pack ready emails arrive.
- Loops for lifecycle email; PostHog key and funnel; Sentry; Upstash for shared rate limits and the landing page preview.

### Jobs and video
- Durable pack runs and scheduled jobs: Trigger.dev v4 on Trigger.dev cloud, or a Render cron service.
- Templated video rendering, then generative video (Veo and fal.ai access).

### Integrations
- Shopify embedded app and billing, Shopify auto packs.
- Amazon SP API publishing and a public cdn.curvi.ai path (Cloudflare DNS and an R2 custom domain).
- Google Drive, Dropbox and Canva exports.

### Quality tooling
- C2PA content credentials (signing certificate).
- OCR and embedding QC engines; cutout failover through fal.ai.
- Eval golden set of 40 real products (photos Curvi has rights to).

### Other
- Backups: Supabase paid plan or point in time recovery decision.
- Domain and trademark confirmation.
- Staging database for full end to end and load tests.

## Small leftovers from batch 1
- Add the new variable names to .env.example by hand (env files are blocked for the agents). The list is in docs/LAUNCH_CHECKLIST.md, "Environment variables added in batch 1".
- The shot_planner prompt does not mention Etsy, eBay, Walmart, TikTok Shop or Pinterest yet, so those packs use the deterministic fallback. Prompt changes need a pnpm eval run.
- Verify the harmonize aspect tolerance and the client IP header behind Render at the first live check (docs/verification.md, "Still unverified").
- Partial disputes claw back the whole grant; scaling by the disputed amount needs a Stripe lookup.
- Site accent color is still orange; the new logo is teal and pink.

## Suggested next order
1. Conversion: before and after reveal, paywall and upgrade prompts, URL import.
2. Founder setup that unblocks revenue: Stripe, Render paid plan, Resend domain, legal pages.
3. Retention: cancel flow, products library, shot retry.
4. Growth: share pages, lead capture, catalog audit.
