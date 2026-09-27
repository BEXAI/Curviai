# Phases 6 to 9: Video and packaging, billing and retention, integrations, launch

Status: partially in scope of this build; the rest is sequenced work
Date started: 2026-09-27

## Phase 6: Video and packaging (this build ships the core)

Remotion compositions (Spin360, Slideshow, FeatureCallouts, DimensionReveal) with zod props; ffmpeg helpers tested against a generated clip; packager with per channel zips and compliance-report.json; IPTC DigitalSourceType writing with roundtrip test. Follow ups: C2PA manifest signing (c2pa-node needs signing cert), cloud Remotion rendering, metadata survival test through a real R2 upload and fetch.

## Phase 7: Billing and retention (state machine and ledger land now; Stripe wiring needs keys)

Credit ledger and reserve, charge, release functions with tests (packages/db). Stripe webhook route with signature verification and idempotent grant writing. Tier and credit definitions in packages/pipeline/src/seed. Follow ups once a Stripe account exists: products and prices in Stripe, checkout session route, customer portal, dunning settings, cancel flow with save offers, churn score daily job activation.

## Phase 8: Integrations (scaffolded interfaces, needs partner accounts)

Shopify embedded app (apps/shopify) with session token auth, products/create webhook auto packs, productCreateMedia push, Shopify Billing. Amazon SP API patchListingsItem with image locators served from cdn.curvi.ai/pub. Both blocked on Shopify Partners and Amazon developer registration; the packager download path works without them at launch.

## Phase 9: Launch

Marketing pages, three working free tools, programmatic SEO from the spec registry, share pages, gallery, waitlist capture. Follow ups: referral program wiring, admin dashboard, load test with 50 concurrent packs against provider mocks, Lighthouse 90 pass.
