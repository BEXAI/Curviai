/**
 * Anthropic Messages API adapter (POST {baseUrl}/v1/messages with the
 * anthropic-version header). Supports plain text output and structured
 * output through tools plus tool_choice. Cost is computed from usage tokens
 * times the injected price table; the model ID and prices are constructor
 * parameters, never literals here.
 *
 * VERIFY AT FIRST LIVE CALL: request and response field names against
 * https://docs.claude.com (messages create shape, usage token fields,
 * current anthropic-version value). This adapter is unit tested only for
 * construction and supports().
 */

import { ProviderError } from "../types";
import type { Provider, ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { requestJson, resolveApiKey, signalOf, type AdapterCommonConfig, type FetchLike } from "./shared";

export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

export interface AnthropicPriceTable {
  /** USD micros per million input tokens. */
  inputMicrosPerMTok: number;
  /** USD micros per million output tokens. */
  outputMicrosPerMTok: number;
}

export interface AnthropicLLMConfig extends AdapterCommonConfig {
  /** Model ID, injected from seed data, e.g. a recipes table row. */
  model: string;
  priceTable: AnthropicPriceTable;
  /** API version header value. Override when Anthropic publishes a new one. */
  anthropicVersion?: string;
  defaultMaxTokens?: number;
}

export interface AnthropicLLMInput {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  /** Tool definitions; pair with toolChoice for structured output. */
  tools?: unknown[];
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
}

export interface AnthropicLLMOutput {
  text: string | null;
  /** First tool_use block when tools were used, for structured output. */
  toolUse: { name: string; input: unknown } | null;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  raw: unknown;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicLLMProvider implements Provider {
  readonly name: string;
  readonly kind: ProviderKind = "llm";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly model: string;
  private readonly priceTable: AnthropicPriceTable;
  private readonly anthropicVersion: string;
  private readonly defaultMaxTokens: number;

  constructor(config: AnthropicLLMConfig) {
    this.name = config.name;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, ANTHROPIC_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.fetchFn = config.fetchFn ?? fetch;
    this.model = config.model;
    this.priceTable = config.priceTable;
    this.anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as AnthropicLLMInput;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: input.maxTokens ?? this.defaultMaxTokens,
      messages: input.messages,
    };
    if (input.system !== undefined) body.system = input.system;
    if (input.tools !== undefined) body.tools = input.tools;
    if (input.toolChoice !== undefined) body.tool_choice = input.toolChoice;
    if (input.temperature !== undefined) body.temperature = input.temperature;

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
    if (!textBlock && !toolBlock) {
      throw new ProviderError("Anthropic response had no text or tool_use block", this.name, req.task, true);
    }

    const output: AnthropicLLMOutput = {
      text: textBlock?.text ?? null,
      toolUse: toolBlock ? { name: toolBlock.name ?? "", input: toolBlock.input } : null,
      stopReason: data.stop_reason ?? null,
      usage: { inputTokens, outputTokens },
      raw: data,
    };
    const costMicros = Math.ceil(
      (inputTokens * this.priceTable.inputMicrosPerMTok + outputTokens * this.priceTable.outputMicrosPerMTok) /
        1_000_000,
    );
    return { output: output as TOut, costMicros };
  }
}
