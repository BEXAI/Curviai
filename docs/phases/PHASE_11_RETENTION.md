# Phase 11, workstream b2/retention

Date: 2026-09-28. Parent plan: docs/phases/PHASE_11.md. Source items: docs/PENDING.md ("Cancel flow with save offers", "Brand kit fonts, logo and style preset used in packs", "Readable compliance report view and compliance-report.pdf").

## 1. Cancel flow with save offers

- /app/billing shows a Cancel plan section to owners, admins and editors on a paid plan. The flow: a reason (Stripe's cancellation feedback values), then the save offers that fit the reason, then a final confirmation. Keeping the plan is recorded too.
- Offers and terms come from the seed (`retentionOffers` in packages/pipeline/src/seed/retention.ts, tiers in credits.ts): pause billing for one month, the next smaller plan, 30 percent off for three months. Pause and discount are monthly plan offers and are given once per workspace; a discount never stacks on an existing one.
- `/api/billing/cancel`: GET lists the reasons and eligible offers; POST applies the choice. With Stripe configured and an open Stripe subscription it calls `subscriptions.update` with `pause_collection` (void, resumes_at), a price change with no proration, `discounts: [{ coupon }]` (the coupon is created from the seed terms on first use) or `cancel_at_period_end` plus `cancellation_details`. The webhook syncs the plan as for any subscription change. Without Stripe, the choice is recorded only and the copy says nothing changed today.
- Every pass is a `cancel_flows` row (migration 0018): reason, detail, offers shown, outcome, whether Stripe applied it, the effective date and any Stripe error. workspace_id, RLS (read for owner, admin and editor; no member writes) and packages/db/src/cancel-flows.test.ts.

## 2. Brand kit fonts, logo and style preset in packs

- Fonts: a seeded catalog of bundled Google fonts (packages/pipeline/src/seed/fonts.ts). The brand page offers them as selects; the heading font sets the dimensions label and the body font the infographic callouts. Legacy free text values that match a font name are read as that font. A missing font, or one without a glyph the copy needs, falls back to Inter.
- Logo: drawn on infographic and social template stills only, scaled into a corner box, only where the box plus clear space misses both the product placement and any drawn text. It is drawn before the product is placed, and placing the product over any drawn pixel throws, so product pixels are never covered (rule 3; brand-still.test.ts proves fidelity still passes). Specs that forbid text or need a plain solid background get no logo.
- Style preset: "Automatic" (the planner's category pick) or a seeded preset. A chosen preset replaces the planner's pick on every shot that uses a preset, after planning (both the LLM and the deterministic plans), except for reflective or clear products (planner rule 5). Template backgrounds already follow the shot's preset.
- Plumbing: brand kit row, then `brandStyleFor` in the web payload (catalog keys, own workspace logo key, seeded preset only), then `GeneratePackInput.brand`, the runner's ShotContext and ShotGenerateArgs, then LiveShotGenerator, which loads the logo once per workspace through the checked media loader.

## 3. Compliance report view and PDF

- apps/web/src/lib/compliance-report.ts turns the stored compliance-report.json into plain spoken rows: check, measured, required, pass, plus notes and files left out.
- The pack page shows it below the files, with failing files open. `/api/jobs/:id/compliance` serves the view and `/api/jobs/:id/compliance-report.pdf` a PDF written by hand with the standard Helvetica fonts (no PDF dependency). Demo packs list each file's checks without inventing measurements.

## Checks

pnpm lint, typecheck, test, and the Playwright suite including e2e/retention.spec.ts.
