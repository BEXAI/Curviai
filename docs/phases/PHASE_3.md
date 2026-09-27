# Phase 3: AI layer

Status: complete (2026-09-27). 43 tests green: failover, breaker timing on a fake clock, metering, caps.
Date started: 2026-09-27

## Plan

1. packages/ai implements the frozen contract in src/types.ts: ProviderRegistry, routing tables as injected data, callWithFailover with timeout, retry with jitter, provider failover, circuit breaker (5 failures in 60 s opens for 120 s) and per call cost metering.
2. SpendCaps module encodes the plan 4.4 platform caps: 0.60 USD per image asset, 3.00 per video asset, 8.00 per pack, 3x plan daily ceiling per workspace, 50 USD global daily alert, 150 USD hard stop.
3. Mock providers in src/testing for every downstream consumer.
4. Thin REST adapters (Anthropic, Gemini image, BFL FLUX, OpenAI image, Photoroom cutout, fal gateway) with model IDs and prices as constructor parameters, marked verify at first live call.

## Acceptance

Failover test passes; cost logged per call; breaker opens and recovers on a fake clock. pnpm test packages/ai green.
