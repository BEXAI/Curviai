/**
 * OpenAI image generation adapter (POST {baseUrl}/v1/images/generations with
 * an Authorization Bearer header). Model ID and per image price are
 * constructor parameters.
 *
 * VERIFY AT FIRST LIVE CALL: current image model availability and the
 * response encoding (b64_json versus url, response_format support per model)
 * against https://platform.openai.com/docs. The build plan notes gpt-image-1
 * shuts down October 23, 2026.
 *
 * A moderation refusal (HTTP 400 with error code moderation_blocked, or the
 * older content_policy_violation) is a non retryable ProviderError with code
 * content_blocked, and a success reply with no image data is non retryable
 * with code empty_output. Neither is metered, since the injected price is
 * per returned image. The moderation error shape was checked against the
 * image generation guide on 2026-09-28.
 */

import type { CostAwareProvider } from "../router";
import { ProviderError } from "../types";
import type { ProviderErrorCode, ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { probeRequest, type ProbeOptions, type ProbeResult } from "../probe";
import { requestJson, resolveApiKey, signalOf, type AdapterCommonConfig, type FetchLike } from "./shared";

export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

/** Error codes OpenAI returns when its moderation declines an image request. */
const OPENAI_MODERATION_CODES = ["moderation_blocked", "content_policy_violation"];

/** Maps a moderation refusal response to content_blocked. */
export function classifyOpenaiImageError(status: number, bodyText: string): ProviderErrorCode | undefined {
  if (status !== 400) return undefined;
  let code: unknown;
  try {
    code = (JSON.parse(bodyText) as { error?: { code?: unknown } }).error?.code;
  } catch {
    code = undefined;
  }
  if (typeof code === "string" && OPENAI_MODERATION_CODES.includes(code)) return "content_blocked";
  return OPENAI_MODERATION_CODES.some((c) => bodyText.includes(`"${c}"`)) ? "content_blocked" : undefined;
}

export interface OpenaiImageConfig extends AdapterCommonConfig {
  /** Model ID from seed data, e.g. the fallback image model row. */
  model: string;
  priceTable: { perImageMicros: number };
}

export interface OpenaiImageInput {
  prompt: string;
  /** e.g. "1024x1024"; provider default when omitted. */
  size?: string;
  quality?: string;
  n?: number;
}

export interface OpenaiImageOutput {
  images: Array<{ dataBase64?: string; url?: string }>;
  raw: unknown;
}

interface GenerationsResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

export class OpenaiImageProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "image";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly model: string;
  private readonly priceTable: { perImageMicros: number };
  readonly minTimeoutMs: number | undefined;

  constructor(config: OpenaiImageConfig) {
    this.name = config.name;
    this.minTimeoutMs = config.minTimeoutMs;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, OPENAI_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://api.openai.com";
    this.fetchFn = config.fetchFn ?? fetch;
    this.model = config.model;
    this.priceTable = config.priceTable;
  }

  /**
   * Key probe: GET /v1/models/{model} (retrieve model), a metadata read
   * that also confirms the model is available to this key (OpenAI API
   * reference, checked 2026-09-28). Never generates an image.
   */
  probe(options?: ProbeOptions): Promise<ProbeResult> {
    return probeRequest(
      this.fetchFn,
      `${this.baseUrl}/v1/models/${encodeURIComponent(this.model)}`,
      { method: "GET", headers: { authorization: `Bearer ${this.apiKey}` } },
      options,
    );
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /**
   * Upper bound from the request parameters: the number of requested images
   * (input.n, default 1) times the injected per image price. Invoke meters
   * perImageMicros times the returned image count, which never exceeds n.
   */
  estimateCostMicros(req: ProviderRequest): number {
    const input = req.input as unknown as OpenaiImageInput;
    return this.priceTable.perImageMicros * Math.max(1, input.n ?? 1);
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as OpenaiImageInput;
    const body: Record<string, unknown> = { model: this.model, prompt: input.prompt };
    if (input.size !== undefined) body.size = input.size;
    if (input.quality !== undefined) body.quality = input.quality;
    if (input.n !== undefined) body.n = input.n;

    const data = await requestJson<GenerationsResponse>(
      this.fetchFn,
      this.name,
      req.task,
      `${this.baseUrl}/v1/images/generations`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signalOf(req),
      },
      classifyOpenaiImageError,
    );

    const images = (data.data ?? [])
      .filter((item) => Boolean(item.b64_json) || Boolean(item.url))
      .map((item) => ({ dataBase64: item.b64_json, url: item.url }));
    if (images.length === 0) {
      throw new ProviderError("OpenAI response contained no images", this.name, req.task, false, undefined, {
        code: "empty_output",
      });
    }

    const output: OpenaiImageOutput = { images, raw: data };
    return { output: output as TOut, costMicros: this.priceTable.perImageMicros * images.length };
  }
}
