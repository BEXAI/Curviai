/**
 * Anthropic Messages API adapter (POST {baseUrl}/v1/messages with the
 * anthropic-version header). It takes the provider neutral LlmRequest
 * (../llm.ts) and returns an LlmResult, translating both ways here and
 * nowhere else: image blocks become base64 sources, the requested output
 * becomes the emit_result tool with tool_choice auto, and the recipe's
 * effort becomes output_config.effort (or thinking disabled for "none").
 * Cost is computed from usage tokens times the injected price table; the
 * model ID and prices are constructor parameters, never literals here.
 *
 * A reply with stop_reason "refusal" (the safety system declined) or with
 * no text or tool_use block is a non retryable ProviderError that carries
 * the tokens billed for it, so the router meters the spend and a blocked
 * prompt never burns retries or trips the shared breaker.
 *
 * VERIFY AT FIRST LIVE CALL: request and response field names against
 * https://docs.claude.com (messages create shape, usage token fields,
 * current anthropic-version value). The image token rule and the refusal
 * stop reason were checked against the vision and stop reason docs on
 * 2026-09-28.
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
  base64Bytes,
  imageDimensions,
  requestJson,
  resolveApiKey,
  signalOf,
  type AdapterCommonConfig,
  type FetchLike,
} from "./shared";

export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * Image input limits for cost estimation. Claude sees an image as 28 by 28
 * pixel patches, one visual token each, after downscaling it to fit the
 * model's long edge and visual token limits. The defaults are the high
 * resolution tier (Claude 4.7 and later): 2576 px and 4784 tokens. Standard
 * tier models (1568 px, 1568 tokens) cost less for the same image, so the
 * defaults are an upper bound for every model.
 */
export interface AnthropicImageTokenLimits {
  patchPx: number;
  maxLongEdgePx: number;
  maxTokens: number;
}

export const ANTHROPIC_IMAGE_TOKEN_LIMITS: AnthropicImageTokenLimits = {
  patchPx: 28,
  maxLongEdgePx: 2576,
  maxTokens: 4784,
};

/** Visual tokens for an image of width by height pixels: downscaled to the
 * long edge limit keeping its aspect ratio, one token per patch (partial
 * patches count), capped at the per image token limit. */
export function anthropicImageTokens(
  width: number,
  height: number,
  limits: AnthropicImageTokenLimits = ANTHROPIC_IMAGE_TOKEN_LIMITS,
): number {
  if (!(width > 0) || !(height > 0)) return limits.maxTokens;
  const scale = Math.min(1, limits.maxLongEdgePx / Math.max(width, height));
  const w = Math.ceil(width * scale);
  const h = Math.ceil(height * scale);
  const tokens = Math.ceil(w / limits.patchPx) * Math.ceil(h / limits.patchPx);
  return Math.min(tokens, limits.maxTokens);
}

interface ImageBlockLike {
  type: "image";
  source?: { type?: string; data?: unknown };
}

function isImageBlock(value: unknown): value is ImageBlockLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "image" &&
    typeof (value as { source?: unknown }).source === "object"
  );
}

/** Visual tokens for one image content block. Base64 sources are sized from
 * their header; URL or file sources, and anything unreadable, take the per
 * image maximum. */
function imageBlockTokens(block: ImageBlockLike, limits: AnthropicImageTokenLimits): number {
  const data = block.source?.type === "base64" ? block.source.data : undefined;
  if (typeof data !== "string" || data.length === 0) return limits.maxTokens;
  const size = imageDimensions(base64Bytes(data));
  return size ? anthropicImageTokens(size.width, size.height, limits) : limits.maxTokens;
}

export interface AnthropicPriceTable {
  /** USD micros per million input tokens. */
  inputMicrosPerMTok: number;
  /** USD micros per million output tokens. */
  outputMicrosPerMTok: number;
}

export interface AnthropicLLMConfig extends AdapterCommonConfig {
  /** Default model ID, injected from seed data, e.g. a recipes table row. */
  model: string;
  priceTable: AnthropicPriceTable;
  /** Prices for other model ids the recipes may select via input.model. A
   * requested model without a price entry fails closed. */
  priceTables?: Record<string, AnthropicPriceTable>;
  /** API version header value. Override when Anthropic publishes a new one. */
  anthropicVersion?: string;
  defaultMaxTokens?: number;
  /** Image limits for the cost estimate; defaults to the high resolution tier. */
  imageTokenLimits?: AnthropicImageTokenLimits;
}

/** Instruction on the emit_result tool. Claude Opus 5.5 answers 400 to a
 * forced tool_choice ("tool" or "any"; define tools docs, forcing tool use,
 * checked 2026-09-29), so the choice stays "auto" and the description tells
 * the model to call it. */
const EMIT_RESULT_DESCRIPTION =
  "Always call this tool exactly once to return the task result, as structured data matching the schema exactly. Do not answer in plain text.";

/** Messages API content for one message: a lone text block is sent as a
 * plain string, as the runner always sent a text only prompt. */
function anthropicContent(content: readonly LlmContentBlock[]): unknown {
  if (content.length === 1 && content[0].type === "text") {
    return content[0].text;
  }
  return content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.base64 } },
  );
}

function anthropicMessages(messages: readonly LlmMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((message) => ({ role: message.role, content: anthropicContent(message.content) }));
}

/** The emit_result tool for a requested structured output. */
function anthropicTools(request: LlmRequest): unknown[] | undefined {
  if (!request.output) {
    return undefined;
  }
  return [
    {
      name: request.output.name,
      description: EMIT_RESULT_DESCRIPTION,
      input_schema: request.output.schema,
      ...(request.output.strict ? { strict: true } : {}),
    },
  ];
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

export class AnthropicLLMProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "llm";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly model: string;
  private readonly priceTable: AnthropicPriceTable;
  private readonly priceTables: Record<string, AnthropicPriceTable>;
  private readonly anthropicVersion: string;
  private readonly defaultMaxTokens: number;
  private readonly imageTokenLimits: AnthropicImageTokenLimits;
  readonly minTimeoutMs: number | undefined;

  constructor(config: AnthropicLLMConfig) {
    this.name = config.name;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, ANTHROPIC_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.fetchFn = config.fetchFn ?? fetch;
    this.model = config.model;
    this.priceTable = config.priceTable;
    this.priceTables = config.priceTables ?? {};
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.imageTokenLimits = config.imageTokenLimits ?? ANTHROPIC_IMAGE_TOKEN_LIMITS;
    this.minTimeoutMs = config.minTimeoutMs;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /**
   * Key probe: GET /v1/models/{model}, a free metadata read that also
   * confirms the model id exists for this key (Models API, checked
   * 2026-09-28). Never generates tokens.
   */
  probe(options?: ProbeOptions): Promise<ProbeResult> {
    return probeRequest(
      this.fetchFn,
      `${this.baseUrl}/v1/models/${encodeURIComponent(this.model)}`,
      { method: "GET", headers: { "x-api-key": this.apiKey, "anthropic-version": this.anthropicVersion } },
      options,
    );
  }

  /** The model a request runs on and its prices. A recipe selected model
   * without a price entry fails closed: silent misprice is worse than a
   * refused call. */
  private resolveModel(input: LlmRequest, task: string): { model: string; prices: AnthropicPriceTable } {
    const model = input.model ?? this.model;
    if (model === this.model) {
      return { model, prices: this.priceTable };
    }
    const prices = this.priceTables[model];
    if (!prices) {
      throw new ProviderError(
        `Model "${model}" has no price table on this adapter; add it to priceTables`,
        this.name,
        task,
        false,
      );
    }
    return { model, prices };
  }

  /**
   * Conservative upper bound on the metered cost. Text input tokens are
   * estimated from the JSON size of the system prompt, messages and tools at
   * one token per three characters, which overestimates real tokenizers on
   * typical text. Image blocks (anywhere in the messages, including tool
   * results) are left out of that character count, since their base64 data
   * is not tokenized as text, and priced as visual tokens from their pixel
   * size instead (see anthropicImageTokens). Output tokens are taken at the
   * full max_tokens budget of the request (maxOutputTokens or the adapter
   * default), the hard ceiling the API enforces. Both sides are priced with
   * the injected per million token rates, matching how invoke computes the
   * actual cost.
   */
  estimateCostMicros(req: ProviderRequest): number {
    const input = req.input as unknown as LlmRequest;
    const { prices } = this.resolveModel(input, req.task);
    const inputTokens = this.estimateInputTokens(input);
    const outputTokens = input.maxOutputTokens ?? this.defaultMaxTokens;
    return Math.ceil(
      (inputTokens * prices.inputMicrosPerMTok + outputTokens * prices.outputMicrosPerMTok) / 1_000_000,
    );
  }

  /** Upper bound on the request's input tokens: text at one token per three
   * characters plus visual tokens for every image block. */
  estimateInputTokens(input: LlmRequest): number {
    let imageTokens = 0;
    const promptChars = JSON.stringify(
      {
        system: input.system ?? "",
        messages: anthropicMessages(input.messages ?? []),
        tools: anthropicTools(input) ?? [],
      },
      (_key, value: unknown) => {
        if (isImageBlock(value)) {
          imageTokens += imageBlockTokens(value, this.imageTokenLimits);
          return { type: "image" };
        }
        return value;
      },
    ).length;
    return Math.ceil(promptChars / 3) + imageTokens;
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as LlmRequest;
    const { model, prices } = this.resolveModel(input, req.task);
    const tools = anthropicTools(input);
    const body: Record<string, unknown> = {
      model,
      max_tokens: input.maxOutputTokens ?? this.defaultMaxTokens,
      messages: anthropicMessages(input.messages),
    };
    if (input.system !== undefined) body.system = input.system;
    if (tools !== undefined) {
      body.tools = tools;
      body.tool_choice = { type: "auto" };
    }
    // Effort per model (Messages API, checked 2026-09-29,
    // docs/verification.md): "none" turns thinking off, any other value is
    // sent as output_config.effort and the model thinks adaptively, its
    // default. No effort sends neither field, so the model default applies.
    // Valid values differ by model (Opus 5.5 rejects thinking disabled,
    // Haiku 4.5 rejects effort), which is why recipes key them by model.
    const effort = llmEffortFor(input, model);
    if (effort === "none") body.thinking = { type: "disabled" };
    else if (effort !== undefined) body.output_config = { effort };

    const data = await requestJson<MessagesResponse>(this.fetchFn, this.name, req.task, `${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signalOf(req),
    });

    const blocks = data.content ?? [];
    const textBlock = blocks.find((b) => b.type === "text");
    const toolBlock = blocks.find((b) => b.type === "tool_use");
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const costMicros = Math.ceil(
      (inputTokens * prices.inputMicrosPerMTok + outputTokens * prices.outputMicrosPerMTok) / 1_000_000,
    );
    const usage = {
      inputTokens,
      cachedInputTokens: data.usage?.cache_read_input_tokens ?? 0,
      outputTokens,
      reasoningTokens: 0,
    };
    // Both failures below were billed for their tokens, and retrying the
    // same prompt on the same provider would only pay for the same answer.
    if (data.stop_reason === "refusal") {
      throw new ProviderError("Anthropic declined the request (stop_reason refusal)", this.name, req.task, false, undefined, {
        code: "content_blocked",
        billedCostMicros: costMicros,
        usage,
      });
    }
    // A reply cut off at max_tokens: thinking tokens count toward the same
    // budget, so a thinking model can spend it before the answer. A forced
    // tool call cut short would fail schema validation later with no hint of
    // why; say so here instead. Not retried on this provider (the same
    // budget cuts the same answer short) and not a sign the provider is
    // unhealthy, so the chain fails over without touching the breaker.
    if (data.stop_reason === "max_tokens" && (tools !== undefined || (!textBlock && !toolBlock))) {
      throw new ProviderError(
        `Anthropic response stopped at max_tokens (${String(body.max_tokens)}) before the answer was complete`,
        this.name,
        req.task,
        false,
        undefined,
        { code: "output_truncated", billedCostMicros: costMicros, usage },
      );
    }
    if (!textBlock && !toolBlock) {
      throw new ProviderError(
        `Anthropic response had no text or tool_use block (stop_reason ${data.stop_reason ?? "none"})`,
        this.name,
        req.task,
        false,
        undefined,
        { code: "empty_output", billedCostMicros: costMicros, usage },
      );
    }

    const text = textBlock?.text ?? "";
    // The answer is the emit_result tool input. With tool_choice auto the
    // model can, rarely, answer in text instead: then the JSON the text
    // holds, else null, which tells the caller the tool call was missed.
    const json = toolBlock && toolBlock.input !== undefined ? toolBlock.input : jsonFromText(text);
    const output: LlmResult = {
      json,
      text,
      finish: data.stop_reason === "max_tokens" ? "truncated" : "complete",
      usage,
      raw: data,
    };
    return { output: output as TOut, costMicros };
  }
}
