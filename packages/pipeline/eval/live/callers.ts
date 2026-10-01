/**
 * How the live LLM eval reaches a model (docs/phases/PHASE_17.md workstream
 * 4). Three callers share one interface:
 *
 * - routedCaller: a real provider from @curvi/ai, called through
 *   callWithFailover (timeout, retry, breaker, metering; CLAUDE.md rule 4)
 *   with a one model chain, so each recipe is measured on exactly the model
 *   asked for and never on a fallback.
 * - recordingCaller: wraps another caller and keeps every outcome, so a live
 *   run can be saved and scored again later without spending anything.
 * - replayCaller: answers from such a recording. The harness unit tests run
 *   on it; it never touches the network.
 *
 * The eval never builds a provider shaped request or reads a provider shaped
 * reply: it speaks LlmRequest and LlmResult, and the adapters translate.
 */

import {
  AllProvidersFailedError,
  ANTHROPIC_API_KEY_ENV,
  AnthropicLLMProvider,
  callWithFailover,
  InMemoryBreakerStore,
  InMemoryCostMeter,
  isLlmResult,
  OPENAI_API_KEY_ENV,
  OpenaiLLMProvider,
  ProviderError,
  ProviderRegistry,
  type FetchLike,
  type LlmRequest,
  type LlmResult,
  type Provider,
} from "@curvi/ai";
import {
  llmImageTokenMultipliers,
  llmModelPrices,
  llmModelProviders,
  type LlmProviderFamily,
} from "../../src/seed/models";

/** One recipe call the harness makes. */
export interface LlmCallSpec {
  recipeKey: string;
  caseId: string;
  model: string;
  input: LlmRequest;
  /** The recipe's per attempt timeout; the router default when unset. */
  timeoutMs?: number;
}

/** What one call came back with. A failure keeps its error code (for example
 * content_blocked or output_truncated) and whatever the provider billed. */
export type CallOutcome =
  | { ok: true; result: LlmResult; costMicros: number; latencyMs: number }
  | {
      ok: false;
      code: string | null;
      message: string;
      /** The provider answered 400, so the runner would retry without strict. */
      badRequest: boolean;
      costMicros: number;
      latencyMs: number;
    };

export interface LlmCaller {
  readonly provider: LlmProviderFamily;
  call(spec: LlmCallSpec): Promise<CallOutcome>;
}

/** The env var holding a provider family's key. A name, never a value. */
export function keyEnvFor(family: LlmProviderFamily): string {
  return family === "anthropic" ? ANTHROPIC_API_KEY_ENV : OPENAI_API_KEY_ENV;
}

/** The runner's test for a 400 (adapters format HTTP errors as
 * "<provider> responded <status>: <body>"). */
export function isBadRequestMessage(message: string): boolean {
  return /responded 400\b/.test(message);
}

/** A test or demo provider may return the answer itself; take it as json. */
function asLlmResult(output: unknown): LlmResult {
  if (isLlmResult(output)) {
    return output;
  }
  return {
    json: output ?? null,
    text: "",
    finish: "complete",
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    raw: null,
  };
}

/** The registry name a model runs under, as the live runtime names it. */
export function providerNameFor(model: string): string {
  return `${llmModelProviders[model] ?? "unmapped"}:${model}`;
}

/**
 * A caller over real (or test) providers. makeProvider builds the provider
 * for a model once; every call then runs through callWithFailover with that
 * model alone as the chain and a fresh breaker, so one bad case never opens
 * the breaker for the next.
 */
export function routedCaller(
  family: LlmProviderFamily,
  makeProvider: (model: string) => Provider,
  now: () => number = Date.now,
): LlmCaller {
  const registry = new ProviderRegistry();
  const meter = new InMemoryCostMeter();
  return {
    provider: family,
    async call(spec) {
      const name = providerNameFor(spec.model);
      if (!registry.get(name)) {
        registry.register(makeProvider(spec.model));
      }
      const started = now();
      try {
        const res = await callWithFailover<LlmRequest, unknown>(
          registry,
          {},
          meter,
          new InMemoryBreakerStore(),
          {
            task: spec.recipeKey,
            input: spec.input,
            ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
            jobId: `eval:${spec.caseId}`,
            stepId: spec.recipeKey,
          },
          { chain: [name] },
        );
        return {
          ok: true,
          result: asLlmResult(res.output),
          costMicros: res.costMicros + res.billedFailureMicros,
          latencyMs: now() - started,
        };
      } catch (err) {
        const first = err instanceof AllProvidersFailedError ? (err.errors[0] ?? err) : err;
        const message = first instanceof Error ? first.message : String(first);
        const billed =
          err instanceof AllProvidersFailedError
            ? err.billedCostMicros
            : err instanceof ProviderError
              ? err.billedCostMicros
              : 0;
        return {
          ok: false,
          code: first instanceof ProviderError ? (first.code ?? null) : null,
          message,
          badRequest: isBadRequestMessage(message),
          costMicros: billed,
          latencyMs: now() - started,
        };
      }
    },
  };
}

export interface RecordedCall {
  recipeKey: string;
  caseId: string;
  model: string;
  outcome: CallOutcome;
}

/** A saved run: every call's outcome in the order it was made. */
export interface Recording {
  version: 1;
  provider: LlmProviderFamily;
  recordedAt: string;
  calls: RecordedCall[];
}

function caseKey(recipeKey: string, caseId: string): string {
  return `${recipeKey}/${caseId}`;
}

/** Keeps every outcome the inner caller returns. The provider's raw reply is
 * dropped, so a recording holds the answer and the metrics, not a log. */
export function recordingCaller(inner: LlmCaller, clock: () => Date = () => new Date()): {
  caller: LlmCaller;
  recording: () => Recording;
} {
  const calls: RecordedCall[] = [];
  return {
    caller: {
      provider: inner.provider,
      async call(spec) {
        const outcome = await inner.call(spec);
        const kept: CallOutcome = outcome.ok ? { ...outcome, result: { ...outcome.result, raw: null } } : outcome;
        calls.push({ recipeKey: spec.recipeKey, caseId: spec.caseId, model: spec.model, outcome: kept });
        return kept;
      },
    },
    recording: () => ({ version: 1, provider: inner.provider, recordedAt: clock().toISOString(), calls: [...calls] }),
  };
}

/**
 * Answers from a recording: each case's outcomes are handed out in the
 * order they were recorded (the strict call, then any retry or re ask). A
 * call with nothing left to replay fails with code not_recorded.
 */
export function replayCaller(recording: Recording): LlmCaller {
  const queues = new Map<string, CallOutcome[]>();
  for (const call of recording.calls) {
    const key = caseKey(call.recipeKey, call.caseId);
    const queue = queues.get(key) ?? [];
    queue.push(call.outcome);
    queues.set(key, queue);
  }
  return {
    provider: recording.provider,
    async call(spec) {
      const next = queues.get(caseKey(spec.recipeKey, spec.caseId))?.shift();
      if (!next) {
        return {
          ok: false,
          code: "not_recorded",
          message: `No recorded answer left for ${spec.recipeKey} case ${spec.caseId}`,
          badRequest: false,
          costMicros: 0,
          latencyMs: 0,
        };
      }
      return structuredClone(next);
    },
  };
}

export interface LiveProviderOptions {
  /** Every recipe key the provider may serve. */
  tasks: string[];
  /** Explicit key for tests; the adapter reads its env var otherwise. */
  apiKey?: string;
  fetchFn?: FetchLike;
}

/**
 * The @curvi/ai provider for one model, priced from the seed (rule 2). The
 * model must be priced and mapped to the family asked for.
 */
export function liveLlmProvider(family: LlmProviderFamily, model: string, opts: LiveProviderOptions): Provider {
  const priceTable = llmModelPrices[model];
  if (!priceTable) {
    throw new Error(`Model ${model} has no price in llmModelPrices`);
  }
  if (llmModelProviders[model] !== family) {
    throw new Error(`Model ${model} is not served by ${family} (llmModelProviders)`);
  }
  const config = {
    name: providerNameFor(model),
    tasks: opts.tasks,
    model,
    priceTable,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
  };
  if (family === "anthropic") {
    return new AnthropicLLMProvider(config);
  }
  // The same seed rows live-runtime wires from: an OpenAI model needs a
  // cached input price and an image token multiplier.
  const { cachedInputMicrosPerMTok } = priceTable;
  const imageTokenMultiplier = llmImageTokenMultipliers[model];
  if (cachedInputMicrosPerMTok === undefined || imageTokenMultiplier === undefined) {
    throw new Error(`Model ${model} needs a cached input price and an image token multiplier in the seed`);
  }
  return new OpenaiLLMProvider({
    ...config,
    priceTable: { ...priceTable, cachedInputMicrosPerMTok },
    imageTokenMultiplier,
  });
}
