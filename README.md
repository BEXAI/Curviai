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
packages/ui/         Shared components (Badge, Button, Card, Input, Progress, Select, Skeleton,
                     Spinner, Switch)
packages/cli/        The curvi command: a client for the public API, for terminals and AI agents
trigger/             Pack runner library: pipeline runner, live providers, follow ups, spend
                     alerts; apps/web runs it inline
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
pnpm db:seed      # upsert channel specs, recipes and platform settings (needs DATABASE_URL)
pnpm smoke        # staging smoke checks; authenticated/paid checks need explicit configuration
pnpm ops:memory-test # synthetic pipeline memory measurement; no paid provider calls
```

Copy `.env.example` to `.env.local` and fill keys as accounts get created. The marketing site, unit tests and e2e run with zero env vars.

## Founder setup, in order

Accounts the stack uses: GitHub (done), Render, Cloudflare (DNS, R2 storage and email routing for curvi.ai; see docs/verification.md), Supabase, Stripe (Billing and Tax), Anthropic Console, OpenAI, Google AI Studio, Black Forest Labs, fal.ai (BiRefNet cutouts), Resend, PostHog, Sentry, Upstash, Shopify Partners and Amazon Seller Central Professional.

Deployment: production runs on Render as the web service Curviai. render.yaml is the reviewed Blueprint reference: Node 22, `pnpm install --frozen-lockfile --prod=false && pnpm run build`, health check `/api/health`, and a deploy only after the CI checks pass on main. Blueprint adoption requires comparing the existing dashboard configuration first; see docs/LAUNCH_CHECKLIST.md. Packs run inline in the web service (apps/web/src/lib/jobs/inline-runner.ts). Cloudflare DNS for curvi.ai points at the Render service. Environment values live in the Render dashboard, never in git.

## Build status

See `docs/phases/` for the phase by phase record. CI runs lint, typecheck, unit tests and Playwright on every push.
