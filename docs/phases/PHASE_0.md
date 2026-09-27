# Phase 0: Verify and scaffold

Status: in progress
Date started: 2026-09-27

## Goal

Scaffold the monorepo, CI and env plumbing. Verify external prices, model IDs and channel specs marked "verify at build" in CURVI_BUILD_PLAN.md and record results in docs/verification.md.

## Plan

1. Repo: pnpm workspace with apps/web, packages/{db,ai,pipeline,video,specs,ui}, trigger, eval/golden, content, docs. Git repo at Desktop/Curviai pushed to github.com/BEXAI/Curviai.
2. Root tooling: TypeScript 5 strict base config, ESLint 9 flat config with typescript-eslint 8, Vitest 3 per package, Playwright at root for e2e, GitHub Actions CI (lint, typecheck, test, e2e).
3. CLAUDE.md from plan section 11.1, .env.example from section 11.3, .claude/agents (reviewer, test-writer, prompt-eval).
4. packages/specs implemented in this phase because everything downstream depends on it: registry JSON from plan section 6, zod validated loader, filename templating, marketplace badge rule, tests.
5. packages/ai/src/types.ts fixed as the provider contract before parallel implementation begins.
6. Version pinning decision recorded in docs/verification.md: the registry now serves TypeScript 7, ESLint 10, Vitest 5, Next 16, Stripe SDK 22. This build pins TypeScript 5.x, Next 15.x, ESLint 9, Vitest 3, Zod 4, Drizzle 0.44, Trigger.dev SDK 3 because these majors are a known good combination. Upgrades are a deliberate later task, not a side effect of scaffolding.
7. External verification pass (prices, model IDs, marketplace specs) delegated to research agents; results land in docs/verification.md with the date checked and a verified flag per item.

## Acceptance

- pnpm lint and pnpm typecheck pass.
- pnpm --filter @curvi/specs test passes.
- CI workflow present.
- docs/verification.md exists and every "verify at build" item from the plan has a row.
