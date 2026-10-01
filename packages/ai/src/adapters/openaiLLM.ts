/**
 * OpenAI Responses API adapter for LLM recipes (POST {baseUrl}/v1/responses
 * with an Authorization Bearer header). It takes the provider neutral
 * LlmRequest (../llm.ts) and returns an LlmResult, translating both ways
 * here and nowhere else. The model ID, prices and image token multiplier are
 * constructor parameters from seed data, never literals here (CLAUDE.md
 * rule 2).
 *
 * Request (docs/phases/PHASE_17.md workstream 2; Responses API reference,
 * structured outputs, images and vision, reasoning and your data guides,
 * read 2026-09-30, docs/verification.md):
 * - `instructions` carries the system prompt, `input` the messages, with
 *   text as input_text and images as input_image data URLs with `detail`
 *   always set (on the 5.6 and 6 models "auto" means "original").
 * - The requested output is `text.format` json_schema. A strict request
 *   sends the schema converted by openaiStrictJsonSchema; the answer's nulls
 *   on optional fields are removed again before the caller parses it.
 * - `reasoning.effort` only when the recipe sets an effort for the model, so
 *   otherwise the model default applies.
 * - `max_output_tokens` (reasoning tokens count toward it) and
 *   `store: false`. Never temperature or top_p: reasoning models reject
 *   them whenever effort is not "none".
 *
 * Reply: a refusal part is content_blocked, an incomplete reply cut at
 * max_output_tokens is output_truncated and one cut by the content filter
 * content_blocked, and a reply with no text is empty_output. All of them are
 * non retryable and carry the tokens billed for them, so the router meters
 * the spend and fails over without touching the shared breaker.
 *
 * VERIFY AT FIRST LIVE CALL: the reply's output item and usage field names,
 * and the image token multiplier per model (send one known 1024 by 1024
 * image and record usage.input_tokens in docs/verification.md).
 */

import type { CostAwareProvider } from "../router";
import { ProviderError } from "../types";
import type { ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { probeRequest, type ProbeOptions, type ProbeResult } from "../probe";
import {
  jsonFromText,
  llmEffortFor,
  type LlmContentBlock,
  type LlmMessage,
  type LlmRequest,
  type LlmResult,
} from "../llm";
import {
  OPENAI_WRAPPED_ROOT_KEY,
  openaiNullsToUndefined,
  openaiRootNeedsWrap,
  openaiStrictJsonSchema,
} from "../openaiSchema";
import { OPENAI_API_KEY_ENV } from "./openaiImage";
import {
  base64Bytes,
  imageDimensions,
  requestJson,
  resolveApiKey,
  signalOf,
  type AdapterCommonConfig,
  type FetchLike,
} from "./shared";

/**
 * How a patch model sizes an image before counting it: the image is scaled
 * to fit maxLongEdgePx, cut into patchPx square patches, and capped at
 * maxPatches (images and vision guide, the detail "high" box for the 5.6 and
 * 6 families, read 2026-09-30). The estimate uses this box for every detail
 * level, an upper bound for "low".
 */
export interface OpenaiImageSizing {
  patchPx: number;
  maxLongEdgePx: number;
  maxPatches: number;
}

export const OPENAI_PATCH_IMAGE_SIZING: OpenaiImageSizing = {
  patchPx: 32,
  maxLongEdgePx: 2048,
  maxPatches: 2500,
};

/**
 * Input tokens for one image of width by height pixels on a patch model:
 * scaled to fit the long edge limit keeping its aspect ratio, then
 * ceil(ceil(w / patch) * ceil(h / patch) * multiplier), with the patch count
 * capped at maxPatches. An unreadable size takes the per image maximum.
 */
export function openaiImageTokens(
  width: number,
  height: number,
  multiplier: number,
  sizing: OpenaiImageSizing = OPENAI_PATCH_IMAGE_SIZING,
): number {
  const maxTokens = Math.ceil(sizing.maxPatches * multiplier);
  if (!(width > 0) || !(height > 0)) return maxTokens;
  const scale = Math.min(1, sizing.maxLongEdgePx / Math.max(width, height));
  const w = Math.ceil(width * scale);
  const h = Math.ceil(height * scale);
  const patches = Math.min(Math.ceil(w / sizing.patchPx) * Math.ceil(h / sizing.patchPx), sizing.maxPatches);
  return Math.ceil(patches * multiplier);
}

export interface OpenaiLLMPriceTable {
  /** USD micros per million uncached input tokens. */
  inputMicrosPerMTok: number;
  /** USD micros per million cached input tokens. */
  cachedInputMicrosPerMTok: number;
  /** USD micros per million cache write tokens (input_tokens_details.
   * cache_write_tokens). From seed data; when absent, the 5.6 and later
   * rule applies: 1.25 times the uncached input rate (prompt caching guide,
   * checked 2026-10-01). */
  cacheWriteMicrosPerMTok?: number;
  /** USD micros per million output tokens (reasoning tokens included). */
  outputMicrosPerMTok: number;
}

/** Cache writes bill at this multiple of the uncached input rate on 5.6 and
 * later models when the seed row sets no cache write price. */
const DEFAULT_CACHE_WRITE_INPUT_MULTIPLE = 1.25;

/** The metered token counts of one OpenAI reply. */
export interface OpenaiLLMMeteredUsage {
  /** Uncached input tokens: usage.input_tokens less the cached tokens, so it
   * means what Anthropic's input_tokens means. Cache writes are included. */
  inputTokens: number;
  /** Tokens read from the prompt cache (input_tokens_details.cached_tokens). */
  cachedInputTokens: number;
  /** The part of inputTokens written to the prompt cache
   * (input_tokens_details.cache_write_tokens). */
  cacheWriteTokens?: number;
  /** Output tokens, reasoning tokens included. */
  outputTokens: number;
}

export interface OpenaiLLMConfig extends AdapterCommonConfig {
  /** Model ID from seed data. One provider serves one model. */
  model: string;
  priceTable: OpenaiLLMPriceTable;
  /** Image token multiplier for this model, from seed data (the patch
   * formula above). Seed a conservative value until it is measured. */
  imageTokenMultiplier: number;
  /** Image sizing for the estimate; defaults to the 5.6 and 6 family box. */
  imageSizing?: OpenaiImageSizing;
  /** Output budget when a request sets none. OpenAI suggests reserving at
   * least 25,000 tokens for reasoning models at first (reasoning guide). */
  defaultMaxOutputTokens?: number;
}

/** Responses API content for one message. */
function openaiContent(role: LlmMessage["role"], content: readonly LlmContentBlock[]): unknown[] {
  return content.map((block) => {
    if (block.type === "text") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: block.text };
    }
    return {
      type: "input_image",
      image_url: `data:${block.mediaType};base64,${block.base64}`,
      detail: block.detail ?? "high",
    };
  });
}

function openaiInput(messages: readonly LlmMessage[]): Array<{ role: string; content: unknown[] }> {
  return messages.map((message) => ({ role: message.role, content: openaiContent(message.role, message.content) }));
}

/** text.format for a requested structured output, undefined for free text. */
function openaiTextFormat(request: LlmRequest): Record<string, unknown> | undefined {
  const output = request.output;
  if (!output) {
    return undefined;
  }
  let schema: unknown;
  if (output.strict) {
    schema = openaiStrictJsonSchema(output.schema);
  } else if (openaiRootNeedsWrap(output.schema)) {
    schema = {
      type: "object",
      properties: { [OPENAI_WRAPPED_ROOT_KEY]: output.schema },
      required: [OPENAI_WRAPPED_ROOT_KEY],
    };
  } else {
    schema = output.schema;
  }
  return { type: "json_schema", name: output.name, strict: output.strict, schema };
}

interface ResponsesOutputPart {
  type: string;
  text?: string;
  refusal?: string;
}

interface ResponsesReply {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  output?: Array<{ type?: string; content?: ResponsesOutputPart[] }>;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

function isImageBlock(value: unknown): value is { type: "input_image"; image_url: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "input_image" &&
    typeof (value as { image_url?: unknown }).image_url === "string"
  );
}

export class OpenaiLLMProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "llm";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly model: string;
  private readonly priceTable: OpenaiLLMPriceTable;
  private readonly imageTokenMultiplier: number;
  private readonly imageSizing: OpenaiImageSizing;
  private readonly defaultMaxOutputTokens: number;
  readonly minTimeoutMs: number | undefined;

  constructor(config: OpenaiLLMConfig) {
    this.name = config.name;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, OPENAI_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://api.openai.com";
    this.fetchFn = config.fetchFn ?? fetch;
    this.model = config.model;
    this.priceTable = config.priceTable;
    if (!(config.imageTokenMultiplier > 0)) {
      throw new Error(`Adapter ${config.name} needs a positive imageTokenMultiplier`);
    }
    this.imageTokenMultiplier = config.imageTokenMultiplier;
    this.imageSizing = config.imageSizing ?? OPENAI_PATCH_IMAGE_SIZING;
    this.defaultMaxOutputTokens = config.defaultMaxOutputTokens ?? 25_000;
    this.minTimeoutMs = config.minTimeoutMs;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /**
   * Key probe: GET /v1/models/{model} (retrieve model), a metadata read that
   * also confirms the model is available to this key, as the image adapter
   * does. Never generates tokens.
   */
  probe(options?: ProbeOptions): Promise<ProbeResult> {
    return probeRequest(
      this.fetchFn,
      `${this.baseUrl}/v1/models/${encodeURIComponent(this.model)}`,
      { method: "GET", headers: { authorization: `Bearer ${this.apiKey}` } },
      options,
    );
  }

  /** The model a request runs on. One provider serves one model, so a
   * request pinned to another model fails closed: it has no price here. */
  private resolveModel(input: LlmRequest, task: string): string {
    const model = input.model ?? this.model;
    if (model !== this.model) {
      throw new ProviderError(
        `Model "${model}" is not served by this adapter (it serves "${this.model}")`,
        this.name,
        task,
        false,
      );
    }
    return model;
  }

  /** The Responses API body for a request. */
  requestBody(input: LlmRequest, task: string): Record<string, unknown> {
    const model = this.resolveModel(input, task);
    const body: Record<string, unknown> = { model };
    if (input.system !== undefined) body.instructions = input.system;
    body.input = openaiInput(input.messages ?? []);
    const format = openaiTextFormat(input);
    if (format !== undefined) body.text = { format };
    const effort = llmEffortFor(input, model);
    if (effort !== undefined) body.reasoning = { effort };
    body.max_output_tokens = input.maxOutputTokens ?? this.defaultMaxOutputTokens;
    body.store = false;
    return body;
  }

  /**
   * Conservative upper bound on the metered cost. Text input is estimated
   * from the JSON size of the instructions, input and text format at one
   * token per three characters, with image parts left out of that count and
   * priced from their pixel size with the patch formula (openaiImageTokens).
   * All input is priced at the higher of the uncached and cache write
   * rates. Output is the full max_output_tokens
   * budget, the hard ceiling the API enforces (reasoning included).
   */
  estimateCostMicros(req: ProviderRequest): number {
    const input = req.input as unknown as LlmRequest;
    const body = this.requestBody(input, req.task);
    const inputTokens = this.estimateInputTokens(body);
    const outputTokens = body.max_output_tokens as number;
    return Math.ceil(
      (inputTokens * Math.max(this.priceTable.inputMicrosPerMTok, this.cacheWriteMicrosPerMTok()) +
        outputTokens * this.priceTable.outputMicrosPerMTok) /
        1_000_000,
    );
  }

  /** Upper bound on a request body's input tokens. */
  estimateInputTokens(body: Record<string, unknown>): number {
    let imageTokens = 0;
    const promptChars = JSON.stringify(
      { instructions: body.instructions ?? "", input: body.input ?? [], text: body.text ?? {} },
      (_key, value: unknown) => {
        if (isImageBlock(value)) {
          imageTokens += this.imagePartTokens(value.image_url);
          return { type: "input_image" };
        }
        return value;
      },
    ).length;
    return Math.ceil(promptChars / 3) + imageTokens;
  }

  private imagePartTokens(imageUrl: string): number {
    const comma = imageUrl.indexOf(",");
    const data = imageUrl.startsWith("data:") && comma > 0 ? imageUrl.slice(comma + 1) : "";
    const size = data.length > 0 ? imageDimensions(base64Bytes(data)) : null;
    return size
      ? openaiImageTokens(size.width, size.height, this.imageTokenMultiplier, this.imageSizing)
      : openaiImageTokens(0, 0, this.imageTokenMultiplier, this.imageSizing);
  }

  private cacheWriteMicrosPerMTok(): number {
    return (
      this.priceTable.cacheWriteMicrosPerMTok ??
      Math.ceil(this.priceTable.inputMicrosPerMTok * DEFAULT_CACHE_WRITE_INPUT_MULTIPLE)
    );
  }

  /** The metered usage of a reply. OpenAI's input_tokens counts cached and
   * cache write tokens too; both are taken out of their parent count here. */
  private meteredUsage(usage: ResponsesReply["usage"]): OpenaiLLMMeteredUsage & { reasoningTokens: number } {
    const total = Math.max(0, usage?.input_tokens ?? 0);
    const cached = Math.min(Math.max(0, usage?.input_tokens_details?.cached_tokens ?? 0), total);
    const inputTokens = total - cached;
    const cacheWrite = Math.min(Math.max(0, usage?.input_tokens_details?.cache_write_tokens ?? 0), inputTokens);
    return {
      inputTokens,
      cachedInputTokens: cached,
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      outputTokens: usage?.output_tokens ?? 0,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  /** Metered cost of a reply: ordinary uncached input, cache writes, cached
   * input and output (which already includes the reasoning tokens) at their
   * own prices. */
  costOf(usage: OpenaiLLMMeteredUsage): number {
    const cacheWrite = Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens);
    const prices = this.priceTable;
    return Math.ceil(
      ((usage.inputTokens - cacheWrite) * prices.inputMicrosPerMTok +
        cacheWrite * this.cacheWriteMicrosPerMTok() +
        usage.cachedInputTokens * prices.cachedInputMicrosPerMTok +
        usage.outputTokens * prices.outputMicrosPerMTok) /
        1_000_000,
    );
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as LlmRequest;
    const body = this.requestBody(input, req.task);

    const data = await requestJson<ResponsesReply>(this.fetchFn, this.name, req.task, `${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signalOf(req),
    });

    const metered = this.meteredUsage(data.usage);
    const costMicros = this.costOf(metered);
    // LlmUsage carries no cache write field; those tokens stay in inputTokens.
    const { cacheWriteTokens: _cacheWrite, ...usage } = metered;
    const fail = (message: string, code: "content_blocked" | "output_truncated" | "empty_output") =>
      new ProviderError(message, this.name, req.task, false, undefined, { code, billedCostMicros: costMicros, usage });

    const parts = (data.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? []);
    // Each failure below was billed for its tokens, and asking the same
    // prompt of the same model again would only pay for the same answer.
    if (parts.some((part) => part.type === "refusal")) {
      throw fail("OpenAI declined the request (refusal)", "content_blocked");
    }
    if (data.status === "incomplete") {
      const reason = data.incomplete_details?.reason ?? "unknown";
      if (reason === "content_filter") {
        throw fail("OpenAI stopped the reply (incomplete: content_filter)", "content_blocked");
      }
      // Reasoning tokens count toward max_output_tokens, so the budget can
      // run out before any visible output. Not a sign the provider is
      // unhealthy, so the chain fails over without touching the breaker.
      throw fail(
        `OpenAI response stopped at max_output_tokens (${String(body.max_output_tokens)}) before the answer was complete (incomplete: ${reason})`,
        "output_truncated",
      );
    }
    if (data.status !== undefined && data.status !== "completed") {
      // A failed or cancelled response is a provider side problem: it
      // counts toward the breaker, but is not retried once billed.
      throw new ProviderError(
        `OpenAI response ended with status ${data.status}${data.error?.code ? ` (${data.error.code})` : ""}`,
        this.name,
        req.task,
        costMicros === 0,
        undefined,
        { billedCostMicros: costMicros, transient: true, usage },
      );
    }

    const text = parts
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    if (text.trim() === "") {
      throw fail("OpenAI response had no output text", "empty_output");
    }

    const output: LlmResult = {
      json: this.answerJson(input, text),
      text,
      finish: "complete",
      usage,
      raw: data,
    };
    return { output: output as TOut, costMicros };
  }

  /** The structured answer: the JSON text, unwrapped from a wrapped root,
   * with nulls on optional fields removed so the caller's lenient schema
   * sees them as absent. Free text answers yield the JSON they hold. */
  private answerJson(input: LlmRequest, text: string): unknown {
    if (!input.output) {
      return jsonFromText(text);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = jsonFromText(text);
    }
    if (json === null || typeof json !== "object") {
      return null;
    }
    if (openaiRootNeedsWrap(input.output.schema)) {
      if (Array.isArray(json) || !(OPENAI_WRAPPED_ROOT_KEY in json)) {
        return null;
      }
      json = (json as Record<string, unknown>)[OPENAI_WRAPPED_ROOT_KEY];
    }
    return openaiNullsToUndefined(json, input.output.schema);
  }
}
