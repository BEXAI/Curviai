# Curvi

Studio product photos and videos for every marketplace, from one photo, without changing your product.

One upload creates a complete, compliant, multichannel pack: Amazon main image, lifestyle shots, infographics, social crops and short video. The moat is the pipeline: the real product pixels are cut out and composited back untouched, everything around them is generated or templated, channel rules are enforced in deterministic code, and every file ships with a compliance report. Full spec: `CURVI_BUILD_PLAN.md`.

## Repository layout

```
apps/web/            Next.js 15: marketing site + app + API routes
packages/specs/      Channel Spec Registry (Amazon, Shopify, Google, Meta...) + validated loader
packages/ai/         Provider abstraction: registry, failover, circuit breaker, cost meter, spend caps
packages/pipeline/   Zod schemas, recipe seeds (prompts, model IDs, credits), deterministic image
                     stage (sharp), QC pixel checks, fidelity lock, IPTC metadata, packager, eval
packages/video/      Remotion compositions (spin, slideshow, callouts) + ffmpeg helpers
packages/db/         Drizzle schema, SQL migrations with RLS, credit ledger functions, PGlite tests
packages/ui/         Shared components (Button, Card, Badge, Input)
trigger/             Trigger.dev job orchestration (pack state machine, crons)
eval/golden/         Golden set fixtures (generated at runtime, not stored in git)
docs/phases/         Per phase plan and status
docs/verification.md External facts checked at build time, with dates and sources
```

## Commands

```
pnpm dev          # run the web app locally
pnpm test         # all unit tests (Vitest, per package)
pnpm typecheck    # all packages
pnpm lint         # ESLint across the repo
pnpm e2e          # Playwright against a production build
pnpm eval         # golden set eval harness (packages/pipeline)
pnpm db:generate  # drizzle-kit generate migrations
pnpm db:migrate   # apply migrations (needs DATABASE_URL)
pnpm trigger:dev  # Trigger.dev local dev (needs TRIGGER_SECRET_KEY)
```

Copy `.env.example` to `.env.local` and fill keys as accounts get created. The marketing site, unit tests and e2e run with zero env vars.

## Founder setup, in order

Accounts to create (plan section 11.4): GitHub (done), Anthropic Console, Cloudflare (register curvi.ai after trademark check, see docs/verification.md), Vercel, Supabase, Trigger.dev, Stripe (Billing and Tax), Google AI Studio, OpenAI, Black Forest Labs, fal.ai, Photoroom API, Kling, Resend, Loops, PostHog, Sentry, Upstash, Crisp, Shopify Partners, Amazon Seller Central Professional, HeyGen or Creatify.

Deployment (plan section 4.2): Cloudflare DNS with apex and www to Vercel, app.curvi.ai to Vercel, cdn.curvi.ai as an R2 custom domain, SSL Full strict. `npx vercel link` then `npx vercel --prod` from the repo root once envs exist.

## Build status

See `docs/phases/` for the phase by phase record. CI runs lint, typecheck, unit tests and Playwright on every push.
