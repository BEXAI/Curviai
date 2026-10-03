# Phase 21 credit planning and budgets

Implemented P21-02 in the Phase 21 checkout. The latest user instruction authorizes the optional budget implementation. Every workspace remains disabled until its owner explicitly saves a limit. This lane changed no live workspace preference, external service, subscription, credit price or credential.

## Contract and accounting

- Period: UTC calendar month, with explicit UTC start and exclusive end. The schema owner implements `workspace_credit_budget_snapshot(uuid)` and `set_workspace_credit_budget(uuid,uuid,numeric)` in migration 0046.
- Consumed: negative sum of raw `charge` movements in the current period. Grants, top ups, refunds and operator grant corrections affect the balance but do not restore consumed budget.
- Outstanding holds: negative sum of all `reserve` and `release` movements across all periods. A charge's paired positive release converts held work to consumed work exactly once.
- Returned in the observation window: sum of `release` plus `charge` deltas. This removes the paired release for delivered work and leaves actual returns.
- Headroom: limit minus current consumed credits and every outstanding hold, clamped at zero for display. Reservation checks consumption plus holds plus the requested amount under the existing workspace row lock. Existing work may finish after a reduced limit. Period rollover retains outstanding holds.
- Null disables; zero blocks new reservations; nonnegative limits allow one decimal place, up to the seeded maximum. Existing balance and provider-dollar controls still apply.
- The forecast observes exactly 30 times 24 hours, independent of connection timezone. It requires at least 14 observed account days, three charge days and seven days between earliest/latest activity. It extrapolates the observed delivered-credit rate over the remaining month, labels it an estimate, and warns about sparse or irregular product work. It never schedules or buys anything.

## Application surfaces and roles

- Billing now shows available credits, all active holds, current-month delivered usage, actual returns, observation dates, the estimate or insufficient-history message, and the optional owner form. Figures link to credit history.
- `GET /api/billing/planning`: owner/admin only. `GET /api/billing/budget`: generating members (owner/admin/editor), to explain pack headroom; client seats are refused. No invoice, payment method or provider cost is exposed.
- `POST /api/billing/budget`: same-origin, capped strict JSON, authenticated owner only; actor/workspace come from session resolution. SQL independently checks owner membership and serializes the setter with reservations. Direct client/PostgREST/OAuth writes and setter execution remain blocked by the migration.
- Demo planning is deliberately read only. The real owner form uses labeled controls, a save status region and an error alert. UI shows negative balances as credits below zero.
- App pack estimates show budget headroom. API/MCP estimate output adds optional `credit_budget` with limit, headroom, holds, consumed credits and period boundaries; `enough` accounts for both available balance and budget. A fresh reservation is authoritative after an estimate.
- Initial packs and follow-ups map SQLSTATE `CU429` to stable reason `credit_budget_exceeded`, HTTP 409 and the same actionable message. It is distinct from credit-balance/top-up refusal and request rate limiting.
- Existing idempotency replay returns its accepted job after a later limit reduction without taking another hold.
- Seed `creditPlanningPolicy` also sets 365-day budget audit retention. The privacy lane owns bounded retention, safe owner/admin export and browser acceptance.

## Local validation

Latest focused run: **7 files, 67 tests passed**, including actual migration-backed PGlite accounting, fractional holds and charges, earlier-month holds, correction exclusions, lowering/disable, idempotent charge/release, replay, follow-up refusal rollback, cancel/retry headroom, role boundaries, CSRF, strict input, API/MCP messages, projection caveats and existing Billing rendering.

Command:

```sh
pnpm --filter @curvi/web test src/lib/billing/credit-planning.test.ts src/lib/billing/credit-budget-route.test.ts src/lib/api-v1/actions-credits.test.ts src/lib/api-v1/chat-views.test.ts src/lib/billing/billing-render.test.ts src/lib/services/db-estimate.test.ts src/lib/services/db-follow-up-runs.test.ts
```

Evidence: `/tmp/curvi-p21-budget-focused.log`. ESLint passes all lane-owned files and touched shared service/API/UI files: `/tmp/curvi-p21-budget-lint.log`. Independent reviewer reran the two new domain/route files, 11 tests passed, and reported no application blocker. Their UTC observation-window note was corrected to elapsed hours.

The complete web TypeScript check passes: `pnpm --filter @curvi/web typecheck`, `/tmp/curvi-p21-budget-typecheck.log`. `git diff --check` is clean.

Central schema owner owns database RLS, true concurrent PostgreSQL races, migration review and live application. Root owns full repository checks, browser/build/CI/deployment proof and the existing PR 6 security gate. No alert disposition or gate bypass is part of this lane.
