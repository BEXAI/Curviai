# Phase 11: batch 2, the "can build now" items

Date: 2026-09-28. Source: docs/PENDING.md, section "Can build now". Base: main 57da0f2.

Nine parallel workstreams, each on its own branch in its own worktree, merged by hand afterwards with the full gate (pnpm lint, typecheck, test, e2e).

| Branch | Scope | Migration |
| --- | --- | --- |
| b2/reveal | Before and after reveal with "Share this makeover", pack ready notice in the app | none |
| b2/paywall | Out of credits and upgrade prompts at paywall moments, credit balance display | none |
| b2/url-import | Start a pack from a pasted Shopify or Amazon product URL (SSRF safe fetch) | none |
| b2/inputs | Seller inputs (multiple photos with angle roles, SKU, box contents, comparison facts) and the products library with pack history | 0014 |
| b2/shot-ops | Retry a needs review shot, add a missing angle, cancel a running pack | none |
| b2/trust | Account deletion, data export, 30 day source purge, server side upload ingest, server side terms acceptance | 0015 |
| b2/growth | Share pages and opt-in gallery, leads capture and email gate, free tool fixes 6.9 and 6.10, "Made with Curvi" badge on social exports | 0016 |
| b2/platform | Recipes read at runtime with A/B splits and model failover, stale job sweep and index, report only CSP, cookie consent and unsubscribe links | 0017 |
| b2/retention | Cancel flow with save offers (UI, offers wired when Stripe is on), brand kit fonts, logo and style preset in packs, compliance report view and PDF | 0018 |

Deferred to a later batch: light editor, Concept Mode, catalog audit, SEO hub pages, team seats, video template fixes, noUncheckedIndexedAccess, accent color.

Rules that bind every branch: CLAUDE.md rules 2 to 9. New tenant tables get workspace_id, RLS and a test. Migrations use the assigned number; the merge regenerates the Drizzle journal and snapshots. Production migrations go through the Supabase SQL editor with the founder's approval, as in PHASE_10.md.
