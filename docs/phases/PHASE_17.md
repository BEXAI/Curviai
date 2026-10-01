# Phase 17: move every LLM call from Anthropic Claude to OpenAI

Date: 2026-09-30. Source: a founder request. OpenAI granted Curvi a large block of free credits, so every LLM call moves to OpenAI. Image generation, cutouts and every deterministic step are unchanged.

This file is written for the AI developer who will build it. Read it in full before the first change (CLAUDE.md rule 1). Every external fact below was read on 2026-09-30 from https://developers.openai.com/api/docs (platform.openai.com/docs now redirects there). Re-check each one and date it in docs/verification.md before relying on it (rule 7).

## Goals

1. Every recipe (intake, analyze, plan, copy, qc, pick, brand, question) runs on an OpenAI model through the OpenAI Responses API.
2. Same behavior as today: the same schemas, prompts, guards, caps, failover, metering and seller copy. Packs, preflight, the brand palette and the free tools keep working throughout the rollout.
3. Provider-neutral code. The runner, recipes and tests stop assuming Anthropic shapes, so either provider can serve any recipe from seed data alone (rule 2).
4. Claude stays registered as the last fallback for every recipe until the founder retires it. If the OpenAI credits run out, packs keep running on the remaining Anthropic balance instead of stopping.
5. A canary rollout with a one-row rollback.

## Non goals

- No change to image generation, the BiRefNet cutout or the gpt-image-2 adapter.
- No prompt rewrites beyond what the API change requires. Prompt quality work happens after the switch, measured by pnpm eval.
- No Batch API: it is not eligible for Zero Data Retention and adds latency. Flex is a later cost option (see Backlog).

## OpenAI facts this plan relies on (verify again, rule 7)

| Fact | Value (2026-09-30) | Source |
| --- | --- | --- |
| Recommended API | Responses (`POST /v1/responses`). Chat Completions is still supported, but GPT-6 models need Responses to combine tools and reasoning. | guides/migrate-to-responses |
| Structured output | `text: { format: { type: "json_schema", name, strict: true, schema } }` | guides/structured-outputs |
| Strict schema rules | Root is an object, never `anyOf`. Every property is listed in `required`; optional means `type: [T, "null"]`. `additionalProperties: false` on every object. Supported: `pattern`, `format` (date-time, date, time, duration, email, hostname, ipv4, ipv6, uuid), `minimum`, `maximum`, the exclusive bounds, `multipleOf`, `minItems`, `maxItems`, enum, anyOf, `$defs` and `$ref`. Not supported: `allOf`, `not`, `if`/`then`/`else`, `dependent*`, `minLength`, `maxLength`. Limits: 5,000 properties, 10 nesting levels, 1,000 enum values. | guides/structured-outputs |
| Image input | Content part `{ type: "input_image", image_url: "data:image/jpeg;base64,...", detail }`. `detail` is `low`, `high`, `original` or `auto`. On 5.6 and 6 models, `auto` means `original`, so always set it explicitly. | guides/images-vision |
| Image tokens (patch models) | `ceil(ceil(w/32) * ceil(h/32) * multiplier)` after resizing. The multiplier is 1.2 for gpt-5.6-* and gpt-6-astra. It is not documented for gpt-6-luna, gpt-6.1-sol or gpt-6-sol. | guides/images-vision |
| Reasoning | `reasoning: { effort }`. gpt-6-luna accepts none, low, medium (default), high, xhigh, max. gpt-6.1-sol accepts low, medium (default), high, xhigh, max and rejects `none`. | models pages |
| Output budget | `max_output_tokens` counts reasoning tokens. When the budget runs out, the response has `status: "incomplete"` with `incomplete_details.reason` set to `max_output_tokens`. This can happen before any visible output, and the reasoning tokens are still billed. | guides/reasoning |
| Sampling | Remove `temperature` and `top_p` whenever reasoning effort is not `none`. | guides/reasoning |
| Refusal | An output content part `{ type: "refusal", refusal }` instead of `output_text`. | guides/structured-outputs |
| Usage | `usage.input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`. | api reference |
| Storage | Responses are stored by default. Send `store: false`. | guides/your-data |
| Billing errors | HTTP 429. `error.code` is one of `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` or `organization_usage_limit_exceeded`; `error.type` may still be `insufficient_quota`. Never retry these. Retry only `rate_limit_exceeded` and `slow_down`. 503 `server_is_overloaded` honors `Retry-After`. | guides/error-codes |
| Moderation | `omni-moderation-latest`, free, takes text and images. | guides/moderation |

## Model choice

Prices are Standard per 1M tokens (input / cached input / output) from the pricing page. Today's Claude prices are listed for comparison.

| Model | Price | Use in Curvi |
| --- | --- | --- |
| gpt-6-luna | $0.10 / $0.01 / $0.50 | High-volume vision and JSON steps |
| gpt-6.1-sol | $2 / $0.10 / $10 | Harder reasoning steps (analysis, planning) |
| gpt-5.6-sol | $4 / $0.40 / $20 (promotional price, at least through 2026-11-21) | Second OpenAI fallback for the hard steps; a different model family |
| gpt-5.6-terra | $2 / $0.20 / $12 | Second OpenAI fallback for the light steps; its image token math is documented |
| claude-haiku-4-5 / sonnet-5 / opus-5-5 | $1/$5, $2/$10, $4/$20 | Last fallback, kept during the credit window |

| Recipe | Today (primary, then fallback) | Phase 17 chain | Effort | `detail` | max_output_tokens |
| --- | --- | --- | --- | --- | --- |
| intake_normalizer | Haiku, then Sonnet | gpt-6-luna, then gpt-5.6-terra, then claude-sonnet-5 | low | high | 16000 |
| product_analyzer | Sonnet, then Opus | gpt-6.1-sol, then gpt-5.6-sol, then claude-sonnet-5 | medium | high | 32000 |
| shot_planner | Sonnet, then Opus | gpt-6.1-sol, then gpt-5.6-sol, then claude-sonnet-5 | medium | (no images) | 32000 |
| copy_generator | Haiku, then Sonnet | gpt-6-luna, then gpt-6.1-sol, then claude-haiku-4-5 | low | (no images) | 8000 |
| qc_judge | Haiku, then Sonnet; escalation [Haiku, Sonnet, Opus] | gpt-6-luna, then gpt-6.1-sol; escalation [gpt-6-luna, gpt-6.1-sol, gpt-6-astra] | low | high | 8000 |
| target_picker | Haiku, then Sonnet | gpt-6-luna, then gpt-6.1-sol, then claude-haiku-4-5 | low | high | 4000 |
| brand_palette_namer | Haiku, then Sonnet | gpt-6-luna, then gpt-6.1-sol, then claude-haiku-4-5 | none on luna, low on sol | low | 2000 |
| question_planner | Haiku, then Sonnet | gpt-6-luna, then gpt-6.1-sol, then claude-haiku-4-5 | low | high | 4000 |

**Why these models:**
- **gpt-6-luna for the light steps.** It is about 10 times cheaper than Haiku on both input and output, supports vision, strict structured outputs and effort `none` or `low`, and has the newest knowledge cutoff (May 2026).
- **gpt-6.1-sol for analysis and planning.** It is the same price as Sonnet 5, OpenAI describes it as "near Astra at lower cost", and it supports reasoning effort.
- **Different-family fallbacks.** Each fallback is from a different model family, so a model-specific outage or regression does not take a whole chain down.
- **This also covers the Haiku 4.5 retirement risk** (2026-10-15) raised in the site audit.

**Budget reasoning:** OpenAI recommends reserving at least 25,000 output tokens for reasoning models at first. The values above start high and are trimmed later from measured `reasoning_tokens` (Workstream 7). For the per pack cap: a gpt-6.1-sol call estimated at 32,000 output tokens is about $0.32 plus input, well under today's $8 pack cap.

**Open item (rule 7):** the image token multiplier for gpt-6-luna and gpt-6.1-sol is not documented. Until a measured value exists, estimate with the most conservative documented multiplier (1.72) so the caps never under-reserve. Then measure: send one known image and read `usage.input_tokens` (see Workstream 2).

## Starting point (verified in the code on main 9854191)

| Area | Today | Where |
| --- | --- | --- |
| LLM adapter | `AnthropicLLMProvider`: POST /v1/messages, tool_use parsing, `stop_reason` handling, Anthropic image token math, thinking and effort options from `modelOptions` | packages/ai/src/adapters/anthropicLLM.ts |
| Output contract the runner reads | `AnthropicLLMOutput { text, toolUse, stopReason, usage, raw }` | same file, line 143 |
| Provider naming | `llmModelProviderName(model)` returns `anthropic:${model}` | trigger/src/recipes.ts line 65 |
| Wiring | `wireLiveProviders` registers one Anthropic provider per `llmModelPrices` entry, only when `ANTHROPIC_API_KEY` is set | trigger/src/live-runtime.ts lines 452 to 485 |
| Prices | `llmModelPrices` has the three Claude models | packages/pipeline/src/seed/models.ts line 17 |
| Recipes | 18 rows, one active per key. Model ids, `EXTRACTION_MODEL_OPTIONS` (Anthropic effort), maxTokens, timeoutMs | packages/pipeline/src/seed/recipes.ts |
| JSON calls | `llmJson` builds the `emit_result` tool with `toolChoice auto`, retries without strict on a 400, re-asks once on a missed tool call, repairs nested JSON strings | trigger/src/pipeline-runner.ts lines 1937 to 2068 |
| Image blocks | Anthropic shape `{ type: "image", source: { type: "base64", media_type, data } }` built in 5 places | pipeline-runner.ts lines 1371, 1771, 1777, 2709; brand-palette.ts line 94 |
| Strict schema | `strictToolSchema`: removes Anthropic-unsupported keywords and clamps minItems. It does not add nullable required fields. | packages/pipeline/src/schemas.ts lines 406 to 472 |
| Health and config | The `anthropic` entry, the "No Anthropic key" warning, probe targets per Claude model, the demo notice keyed on ANTHROPIC_API_KEY | apps/web lib/health.ts line 47, lib/config-health.ts line 116, trigger/src/provider-probes.ts line 72, tasks/generate-pack.ts line 56 |
| Quota detection | `quotaErrorCode` matches 402, `insufficient_quota` and the Anthropic balance text | packages/ai/src/adapters/shared.ts lines 97 to 118 |
| Tests that assume Anthropic | seed.test.ts, anthropicOptions.test.ts, adapters.test.ts, quota.test.ts, probe.test.ts, audit-trigger-fixes.test.ts, pipeline-runner.test.ts, provider-probes.test.ts, live-runtime.test.ts, web provider-preflight, job-copy-failures and health tests | |
| Eval | pnpm eval is deterministic and calls no LLM | packages/pipeline/eval/run.ts |

## Workstream 1: a provider-neutral LLM contract (no behavior change)

1. **New `packages/ai/src/llm.ts`** with the neutral types:
   - `LlmContentBlock = { type: "text"; text } | { type: "image"; mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string; detail?: "low" | "high" }`.
   - `LlmRequest = { system, messages: [{ role: "user" | "assistant"; content: LlmContentBlock[] }], output: { name, schema, strict }, maxOutputTokens, effort?: "none" | "low" | "medium" | "high", timeoutMs? }`.
   - `LlmResult = { json: unknown | null; text: string; finish: "complete" | "truncated" | "refused" | "filtered"; usage: { inputTokens, cachedInputTokens, outputTokens, reasoningTokens }; raw }`.
2. **Refactor `AnthropicLLMProvider` to accept `LlmRequest`** and return `LlmResult`:
   - It translates internally: image blocks to the `source.base64` shape, `output` to the `emit_result` tool with `tool_choice: auto`, `effort` to `output_config.effort` with adaptive thinking (an `effort` of `none` disables thinking).
   - Keep its current classification of refusals, truncation and empty output. All existing Anthropic adapter tests must still pass after updating them to the new types.
3. **Runner:**
   - `visionBlocks`, `visionPhotos`, the target picker blocks, `judgeImageBlocks` and brand-palette.ts build `LlmContentBlock` image blocks.
   - `llmJson` builds an `LlmRequest` and reads `LlmResult.json`.
   - `extractJsonOutput` and `missedToolCall` move inside the adapters. The runner sees only `json` (or null) and `finish`.
   - Keep the strict to non-strict retry on a 400, the single re-ask when `json` is null, `parseNestedJsonStrings`, and `wrapUserDescription`.
4. **Recipe model options become neutral:**
   - `RecipeModelOptions` becomes `{ effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" }`, keyed by model id.
   - The Anthropic adapter maps it as today. Seeded values keep their meaning.
5. **Provider naming from seed data:**
   - Add `llmModelProviders: Record<modelId, "anthropic" | "openai">` beside `llmModelPrices` in seed/models.ts.
   - `llmModelProviderName(model)` returns `${provider}:${model}`. An unknown model fails closed, as an unpriced model does today.
6. **Tests:**
   - Update the tests above to the neutral contract.
   - Snapshot that the Anthropic request body is byte for byte what it is today for every recipe, so Workstream 1 ships with zero behavior change.

Done when: the full rule 6 gate passes, the snapshot proves identical Anthropic requests, and no file outside packages/ai/src/adapters/anthropicLLM.ts builds an Anthropic-shaped block or reads `toolUse`.

## Workstream 2: the OpenAI LLM adapter

New `packages/ai/src/adapters/openaiLLM.ts`, built on shared.ts and modeled on openaiImage.ts (Bearer auth, `OPENAI_API_KEY_ENV`, `requestJson`).

1. **`OpenaiLLMProvider implements CostAwareProvider`**, with `kind: "llm"`. Config: `{ model, priceTable: { inputMicrosPerMTok, cachedInputMicrosPerMTok, outputMicrosPerMTok }, baseUrl?, imageTokenMultiplier, imageSizing }`.
2. **Request, `POST /v1/responses`:**
   ```json
   {
     "model": "<id>",
     "instructions": "<system>",
     "input": [{ "role": "user", "content": [
       { "type": "input_text", "text": "..." },
       { "type": "input_image", "image_url": "data:image/jpeg;base64,...", "detail": "high" }
     ]}],
     "text": { "format": { "type": "json_schema", "name": "<output.name>", "strict": true, "schema": { } } },
     "reasoning": { "effort": "low" },
     "max_output_tokens": 16000,
     "store": false
   }
   ```
   - Never send `temperature` or `top_p`.
   - Omit `reasoning` when the recipe's effort is undefined, so the model default applies.
   - If the effort is `none` and the model rejects it (gpt-6.1-sol), the seed must not ask for it. Add a seed test for this.
3. **Response:**
   - `status: "completed"`: concatenate the `output_text` parts and `JSON.parse` them into `json`, with `finish` complete.
   - A `refusal` part: `finish` refused, raising ProviderError `content_blocked`, non-retryable, billed.
   - `status: "incomplete"` with `max_output_tokens`: `finish` truncated, raising `output_truncated`, billed. With `content_filter`: `content_blocked`.
   - Empty output: `empty_output`, billed.
   - Cost: `ceil(((input - cached) * in + cached * cachedIn + output * out) / 1e6)` micros. `output_tokens` already includes reasoning tokens.
4. **Errors:**
   - Extend `quotaErrorCode` in shared.ts to read `error.code` from the JSON body: `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` and `organization_usage_limit_exceeded` map to `provider_quota` (opens the breaker, never retried). Keep the `insufficient_quota` match.
   - A 429 with `rate_limit_exceeded` or `slow_down`, and 500 or 503, stay retryable and honor `Retry-After` within the router's backoff cap.
   - A 400 stays a bad request. It must keep the "responded 400" message shape, because the runner's strict to non-strict retry matches it.
5. **Strict schema for OpenAI:**
   - New `openaiStrictSchema(zodSchema)` in schemas.ts, next to `strictToolSchema`. It lists every property in `required` and turns optional fields into `[T, "null"]` unions.
   - It keeps `minItems`, `maxItems`, `minimum`, `maximum`, `pattern` and `format`, and strips `minLength`, `maxLength`, `allOf`, `not` and conditionals.
   - It adds `additionalProperties: false` everywhere, wraps a non-object root, and fails a unit test if any of the 9 tool schemas breaks the limits.
   - The adapter converts `null` back to `undefined` before the runner's lenient `safeParse`. That keeps the lenient answer schemas (`IntakeAnswer`, `ProductProfileAnswer`, `TargetPickAnswer`, `QuestionPlanAnswer`) unchanged.
6. **Estimate for the caps:**
   - Text is JSON characters / 3, as today.
   - Images: resize to the model's `detail: high` box (2048 px and 2,500 patches for the 5.6 and 6 families, per the sizing tables), then apply the patch formula with the seeded multiplier (1.72 until measured).
   - Output is the full `max_output_tokens`.
   - Measure once with a known 1024 by 1024 image, record the observed `usage.input_tokens` per model in docs/verification.md, and seed the real multipliers.
7. **`probe()`**: GET `/v1/models/{model}`, as openaiImage.ts does.
8. **Tests:**
   - Request snapshots per recipe, with no `temperature`, `store` false, and `detail` always explicit.
   - Parsing for completed, refusal, both incomplete reasons and empty output.
   - Each billing code maps to `provider_quota`; rate limits are retried and billing codes are not.
   - The cost math and the image estimate.
   - The strict schema converter against all 9 schemas, with a round trip: model JSON with nulls passes the lenient answer schemas.

## Workstream 3: seed, recipes and wiring

1. **`llmModelPrices`** gains gpt-6-luna, gpt-6.1-sol, gpt-5.6-sol, gpt-5.6-terra and gpt-6-astra (Standard prices from the table above, cached input included).
   - gpt-5.6-sol carries the promotional price, with a seed comment noting the 2026-11-21 date.
   - `llmModelProviders` maps each to `openai`.
   - Add a seed test that every recipe model and every fallback is priced and mapped.
2. **New recipe versions,** with the previous versions kept and set inactive (the pattern used since intake v2):
   - intake_normalizer v7, product_analyzer v4, shot_planner v3, copy_generator v4, qc_judge v2, target_picker v2, brand_palette_namer v2, question_planner v2.
   - Each one keeps its predecessor's system prompt verbatim. Add one line only where the API needs it: "Return only the JSON object described by the schema." Remove any tool wording.
   - Each sets `model`, `fallbackModels`, `maxTokens` (used as max_output_tokens), `modelOptions` effort per model, and `timeoutMs` per the Model choice table.
   - Set `trafficPct` for the canary (Workstream 5).
3. **`wireLiveProviders`:**
   - Register one OpenAI provider per OpenAI model in `llmModelPrices` when `OPENAI_API_KEY` is set, and one Anthropic provider per Claude model when `ANTHROPIC_API_KEY` is set.
   - Each recipe's route is its seed chain filtered to registered providers, so a missing key drops that provider from every chain instead of failing.
   - The demo notice in generate-pack.ts triggers only when neither key is set.
4. **Health and config:**
   - `DEFAULT_PROVIDER_ENTRIES` gains an `openai-llm` entry.
   - config-health warns per stage when no key covers its chain (via `stageKeyReport`), replacing the Anthropic-only text.
   - Probe targets cover every priced LLM model.
   - Provider names stay hidden from sellers: the job-copy regex gains `openai` and `gpt`.
5. **Data:** set `store: false` on every call. Note it in the privacy page copy only if the copy already names the AI providers. Zero Data Retention is a founder request to OpenAI sales (see Founder decisions).

## Workstream 4: quality, safety and evaluation

1. **Eval gains a live LLM mode** (`pnpm eval --live --provider openai|anthropic`). For every recipe it runs the golden set through both providers and reports schema pass rate, field agreement with the Claude answers, refusal and truncation counts, latency, tokens and cost. It stays off by default and in CI.
2. **Pass bar for each new recipe version** before its canary leaves 10%:
   - Schema pass rate at least equal to Claude's.
   - Intake moderation flags and `sellableProduct` agree with Claude on every golden photo.
   - Target picker choices agree on every multi-product photo.
   - Analyzer `preserveText` and `preserveLogos` recall at least 95% of Claude's entries.
   - The planner produces a valid plan with no more fallbacks to the deterministic plan than Claude.
   - The judge's verdicts agree on the golden judge fixtures.
3. **Prompt injection:** run the existing injection fixtures (notes that try to change prices, flags or rules) against the OpenAI recipes. Every guard test that passes on Claude must pass.
4. **Moderation (optional, P1):** a free `omni-moderation-latest` check on uploads beside the intake flags. It only adds a block reason and never removes one. It ships behind a seeded switch after eval.

## Workstream 5: rollout

1. **Deploy order** (no migration needed):
   - Deploy Workstreams 1 to 3 to web and the worker with the new recipe rows at `trafficPct: 0`.
   - Confirm that `/api/health/providers` probes OpenAI green with the real key.
2. **Canary.** `RecipeCatalog` already splits traffic by job hash. Go 10%, then 50%, then 100% per recipe, in this order:
   1. brand_palette_namer and question_planner (low risk)
   2. copy_generator and target_picker
   3. intake_normalizer
   4. qc_judge
   5. product_analyzer
   6. shot_planner

   Each step needs a day of clean metrics: failure rate, truncation, refusals, fallback rate, cost per pack, and seller-visible errors.
3. **Rollback:** re-seed with the previous version active (one row change), or drop `trafficPct` to 0. No deploy needed.
4. **When OpenAI is at 100% for every recipe:**
   - Claude stays the last fallback in each chain.
   - Watch the OpenAI credit balance: a `credit_balance_exhausted` answer opens the breaker and traffic falls to Claude automatically. Add the founder spend alert for it (Workstream 6).
5. **Production steps** (founder approves each, done through the Supabase SQL editor as before): the re-seed per canary step, and the env check that `OPENAI_API_KEY` has LLM access (project permissions include Responses).

## Workstream 6: cost and monitoring

1. **Meter cached input separately** (OpenAI caches automatically for prefixes of 1,024 tokens and up on older models; 5.6 and later vary). Keep long system prompts first and stable so cache hits stay high.
2. **Log `reasoning_tokens` per call and per recipe.** After a week at 100%, set each recipe's `maxTokens` to its p99 output plus a 50% margin, never below 4,000. Lower budgets reduce the cap reservations.
3. **The founder alert** (Phase 12 D1) fires on any `provider_quota` from OpenAI, and on traffic falling back to Claude above 5% of calls in an hour.
4. **The cost per pack dashboard** gains LLM spend per provider.

## Workstream 7: docs and cleanup

1. Add docs/verification.md rows, dated, for every fact in "OpenAI facts" plus the measured image multipliers.
2. Update CURVI_BUILD_PLAN.md section 5.1 (the model table) and this file's status section.
3. Once Claude is retired by founder decision: remove the Claude models from the chains, keep the adapter and its tests (they cost nothing), and remove `ANTHROPIC_API_KEY` from render.yaml only then.

## Tests (summary)

| Package | Tests |
| --- | --- |
| packages/ai | openaiLLM request snapshots, response parsing, errors, quota codes, cost, image estimate, probe. Anthropic unchanged-body snapshot. Neutral contract tests. |
| packages/pipeline | openaiStrictSchema on all 9 schemas, null round trip into the lenient answers, seed tests (every model priced and mapped, efforts valid per model, one active version per key, prompt equals predecessor plus the JSON line) |
| trigger | llmJson on both providers with MockProvider (completed, refused, truncated, empty, null fields). Failover from OpenAI quota to Claude in one pack. Wiring with only one key set. Demo notice. |
| apps/web | health and config-health with each key combination; job copy hides OpenAI names; provider preflight |
| e2e | unchanged (demo mode) |
| eval | the live mode, run by the founder with real keys |

## Done when

- Every recipe serves 100% of traffic on OpenAI, with Claude as the last fallback.
- Live eval meets the pass bar for every recipe, and the founder has signed off on the results.
- The rule 6 gate passes: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`.
- No code outside the two LLM adapters builds a provider-shaped request or reads a provider-shaped response.
- docs/verification.md has dated rows for every OpenAI fact used and the measured image multipliers.

## Implementation status

Recorded 2026-10-01 on the integration branch `p17/integration` (head af572b3 before this docs commit). Nothing from this phase is live in production: the deploy, the re-seed, the image multiplier measurement, the live eval and every canary step are founder steps (docs/PENDING.md, "Phase 17 founder steps"). No migration is needed. The four founder decisions below are reflected in the seed and the docs.

### What shipped, per workstream

| # | Workstream | Status | Where |
| --- | --- | --- | --- |
| 1 | Provider neutral LLM contract | Built (merge a3ce152) | `packages/ai/src/llm.ts` (`LlmContentBlock`, `LlmRequest`, `LlmResult`, `llmEffortFor`); the Anthropic adapter takes `LlmRequest` and keeps its wire format, proven by a byte for byte snapshot of every recipe's request body (4fa1bda); `llmModelProviders` in the seed and `llmModelProviderName`, which fails closed (`unmapped:<model>`) for an unknown model. |
| 2 | OpenAI LLM adapter | Built (merge d302ed3, reconciled in af572b3) | `packages/ai/src/adapters/openaiLLM.ts` (`OpenaiLLMProvider`, one provider per model, `POST /v1/responses` with `store: false`, no sampling parameters, explicit `detail`); billing codes in shared.ts open the breaker and are never retried; Retry-After honored up to the router cap; client safe schema helpers at `@curvi/ai/openai-schema`; `openaiStrictSchema` in packages/pipeline schemas.ts. |
| 3 | Seed, recipes and wiring | Built (merge 0bcb4b8) | Five OpenAI models priced (cached input included), mapped, with accepted efforts (`llmModelEfforts`) and image multipliers (`llmImageTokenMultipliers`). New versions intake v7, analyzer v4, planner v3, copy v4, qc v2, picker v2, brand v2, questions v2, each active at `trafficPct: 0` beside the serving Claude version. `wireLiveProviders` and the probes register an OpenAI model only with `OPENAI_API_KEY`, a cached price and a seeded multiplier; the demo notice shows only when neither key is set; health has `openai-llm`, config-health lists uncovered stages, job copy hides OpenAI names. |
| 4 | Quality, safety and eval | Built (merge ff8ce70) | `pnpm eval --live --provider openai or anthropic`, with `--record` and `--replay` so the scoring is tested without keys; the pass bar is scored against a stored Claude baseline; the prompt injection fixtures run in the same mode. Item 4 (moderation) is dropped by founder decision 3. |
| 5 | Rollout | Ready, not started | No code beyond the seed rows: `RecipeCatalog` already splits traffic by `traffic_pct`. The deploy, re-seed and canary are founder steps. |
| 6 | Cost and monitoring | Built (merge of `p17/monitor`, 124f475) | Every LLM meter entry carries `usage` (uncached input, cached input, output and reasoning tokens) and `primaryProvider`. `LlmMonitor` in `trigger/src/llm-monitor.ts` writes one `llm_call` log line per attempt and per day counters by recipe, provider and metric to `spend_cap_counters`. Founder alerts go out once each through the spend alert channels: OpenAI `provider_quota` (once per family per UTC hour), Claude fallback above 5% of OpenAI first calls in a UTC hour (after at least 20 such calls, seeded as `minCallsPerHour`), and credit expiry reminders on 2026-12-01 and 2026-12-24 (checked on the first LLM call of the day). LLM spend per provider shows in the weekly digest, in the authorized `/api/health` details and per pack through `packLlmSpend`; config-health warns `llm_credits_expiring:openai` from 2026-12-01 and `llm_credits_expired:openai` after 2026-12-31. The seed values live in `packages/pipeline/src/seed/monitoring.ts`. |
| 7 | Docs and cleanup | Items 1 and 2 done (this commit); item 3 waits for the founder to retire Claude | Dated rows for every OpenAI fact in docs/verification.md ("PHASE_17 workstream 7"), CURVI_BUILD_PLAN.md section 5.1, this section and the founder steps in docs/PENDING.md. |

### Deviations from this plan

- qc_judge v2 has `claude-sonnet-5` as a third fallback model. The Model choice table listed only gpt-6-luna and gpt-6.1-sol, but founder decision 1 puts Claude last in every chain. The escalation stays all OpenAI (gpt-6-luna, gpt-6.1-sol, gpt-6-astra).
- Neither adapter returns `finish: "refused"` or `"filtered"`. Refusals and content filter stops throw `content_blocked`, and truncation throws `output_truncated`, so the router's failover and metering treat both providers alike. The finish values stay in the contract.
- `llmJson` sends `strictToolSchema` to every provider, and the OpenAI adapter converts it to the strict OpenAI shape itself. `openaiStrictSchema` in packages/pipeline is the checked form the limit tests run on.
- The live eval runs one provider per run and scores it against a stored Claude baseline (`--provider anthropic --record-baseline`), not both providers in one run.
- An OpenAI model is wired only when it has both a cached input price and a seeded image multiplier, so a row missing either is skipped rather than metered at zero.
- With only one LLM key set, a job assigned a version whose models have no key runs on the newest active seed version of the same key whose models do (`runnableRecipe` in trigger/src/pipeline-runner.ts), with that version's prompt, budget, efforts and image detail. So with only `OPENAI_API_KEY`, the trafficPct 0 OpenAI versions serve every job rather than the Claude bodies running on OpenAI.
- Monitoring runs off the provider call path: the counter writes and founder emails go in the background, and the Resend send gives up after 10 seconds. A founder email that fails for a reason that may pass (Resend down, 429 or 5xx) gives its claim back and is tried again after 15 minutes on a later LLM call.

### Known gaps

- **Image multipliers for gpt-6-luna and gpt-6.1-sol are not yet measured.** Both are seeded at 1.72. The images and vision guide (checked 2026-10-01) lists 1.72 for o4-mini, and also 2.46 for the deprecated gpt-4.1-nano, so 1.72 is not "the most conservative documented multiplier" as the open item above says. It is above every model that is not deprecated (1.62 at most) and every new family is 1.2, so it still over reserves. Measure and seed the real values (founder step 4).
- **Cache writes are metered low.** On 5.6 and later models a cache write bills at 1.25 times the input rate, reported as `input_tokens_details.cache_write_tokens`. `costOf` bills those tokens at the plain input rate. Prompt caching is on by default, so this is a small, steady under count until a cache write price is seeded and metered (not part of the workstream 6 merge).
- **gpt-6-astra sizing.** At `detail: high` astra has no 2048 pixel box, only the 2,500 patch budget, so the estimate is low for very wide or very tall images on astra. Astra is only the last escalation step of the judge.
- **Schema string limits.** `openaiSchemaLimitProblems` checks properties, nesting and enum values, not the 120,000 character total or the 15,000 character enum limit. Today's schemas are far below both.
- **Haiku 4.5 retirement (2026-10-15).** Haiku is the primary model of the serving Claude versions of intake, copy, picker, brand and questions, and the third fallback of copy v4, picker v2, brand v2 and questions v2. Its retirement commitment runs only to 2026-10-15, so those canaries should reach 100% before then, or Haiku should be swapped for Sonnet 5 in those chains.
- **A re-seed resets the canary.** `loadRecipes` upserts `traffic_pct` and `active` from the seed, so a canary weight set by hand in the SQL editor is undone by the next `pnpm db:seed`. Keep the seed's `trafficPct` in step with production (docs/PENDING.md, founder step 6).
- **Credit reminders need LLM traffic.** Nothing runs on a schedule, so a reminder goes out on the first LLM call on or after its date. The health check warns from 2026-12-01 either way. Add a daily scheduled task if the email must go out on the exact day.
- **Usage counters are never pruned.** The LLM counters in `spend_cap_counters` (a few rows per day, recipe and provider, plus per pack and per hour) grow until a retention window is decided.
- **No cost per pack dashboard exists.** LLM spend per provider is reported in the digest, the health details and `packLlmSpend` instead.
- The rule 6 gate for the whole phase runs on the integration branch with workstream 6 merged.

## Founder decisions

Decided 2026-10-01.

1. Claude stays as the third option: OpenAI primary, OpenAI second, Claude last, in every chain.
2. No Zero Data Retention request. Every call still sends `store: false`.
3. No omni-moderation check. Workstream 4 item 4 is dropped.
4. The OpenAI credits expire on December 31, 2026. The spend alert also fires 30 days before (2026-12-01) and on 2026-12-24, so the switch back to paid OpenAI or to Claude primary is decided before then.

## Backlog

- Flex processing (`service_tier: "flex"`, 50% off, may return 429 "Resource Unavailable" with no charge) for non-urgent recipes such as palette naming and copy, with Standard as the fallback.
- Prompt caching tuning (`prompt_cache_options.ttl: "30m"` on 5.6 and later).
- `reasoning.mode: "pro"` for the hardest plans, measured by eval.
