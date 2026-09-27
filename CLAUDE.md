# Curvi.ai: builder instructions

You are building Curvi.ai from CURVI_BUILD_PLAN.md in this repo root. Read it before every phase.

## Stack

Next.js App Router + TypeScript strict, Tailwind, shadcn/ui, Supabase (Postgres, Auth, Realtime), Drizzle, Cloudflare R2, Trigger.dev, Stripe, Resend, Loops, PostHog, Sentry, Upstash. Package manager: pnpm workspaces.

## Rules

1. Work one phase at a time. Start each phase in plan mode, write the plan to docs/phases/PHASE_N.md, then implement.
2. Never hardcode prompts, model IDs, prices or channel specs in code. They live in the recipes and channel_specs tables, seeded from packages/pipeline/seed.
3. Product pixels inside the mask are never regenerated for Listing Mode outputs. Tests enforce this.
4. Every provider call goes through packages/ai with timeout, retry, failover, circuit breaker and cost metering.
5. Every tenant table has workspace_id and an RLS policy. Add a test for each new table.
6. Before claiming a phase is done, run: pnpm lint && pnpm typecheck && pnpm test && pnpm e2e.
7. Verify any external API shape or price against official docs before using it; record the date checked in docs/verification.md.
8. Never commit secrets. Use .env.local and update .env.example.
9. User facing copy: plain spoken, no emojis, no arrows, no dashes as punctuation.

## Commands

pnpm dev | pnpm test | pnpm e2e | pnpm db:generate | pnpm db:migrate | pnpm eval | pnpm trigger:dev

## Subagents (.claude/agents/)

reviewer.md: reviews diffs for security, RLS and cost caps. test-writer.md: writes Vitest and Playwright tests. prompt-eval.md: runs pnpm eval and summarizes regressions.

## Hooks (.claude/settings.json)

PostToolUse on Edit|Write: run pnpm lint --fix on changed files. Stop: run pnpm typecheck.

## MCP servers

github, supabase, stripe, vercel, cloudflare, sentry (add with `claude mcp add`).
