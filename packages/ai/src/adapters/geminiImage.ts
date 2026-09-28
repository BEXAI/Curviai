/**
 * Gemini image generation adapter over the Generative Language API
 * (POST {baseUrl}/v1beta/models/{model}:generateContent with the
 * x-goog-api-key header). Prompt text plus optional inline reference images
 * in, inline base64 images out. Cost is a flat per output image price from
 * the injected price table.
 *
 * A reply without images is a non retryable ProviderError: code
 * content_blocked when promptFeedback.blockReason or a candidate's
 * finishReason says the safety system declined (retrying the same prompt
 * would burn paid attempts and trip the shared breaker for every customer),
 * empty_output otherwise. Nothing is metered for it, since the injected
 * price is per returned image.
 *
 * VERIFY AT FIRST LIVE CALL: the generateContent request shape for image
 * output (responseModalities value, inline_data casing) and the response
 * part field names against https://ai.google.dev/api. The blockReason and
 * finishReason values were checked against the generateContent reference
 * on 2026-09-28.
 */

import type { CostAwareProvider } from "../router";
import { ProviderError } from "../types";
import type { ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { requestJson, resolveApiKey, signalOf, type AdapterCommonConfig, type FetchLike } from "./shared";

export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

/** Candidate finishReason values that mean the safety or policy system
 * stopped the output (Gemini API generateContent reference). */
export const GEMINI_BLOCKING_FINISH_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "RECITATION",
  "SPII",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_OTHER",
  "IMAGE_RECITATION",
]);

export interface GeminiImageConfig extends AdapterCommonConfig {
  /** Model ID from seed data, e.g. the image model row in channel recipes. */
  model: string;
  priceTable: { perImageMicros: number };
}

export interface GeminiImageInput {
  prompt: string;
  /** Optional reference images, inline base64. */
  images?: Array<{ mimeType: string; dataBase64: string }>;
}

export interface GeminiImageOutput {
  images: Array<{ mimeType: string; dataBase64: string }>;
  raw: unknown;
}

interface GenerateContentResponse {
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    finishReason?: string;
    finishMessage?: string;
  }>;
}

/** Why a generateContent reply carried no image, as a non retryable error. */
function noImageError(data: GenerateContentResponse, provider: string, task: string): ProviderError {
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
    return new ProviderError(`Gemini blocked the prompt (blockReason ${blockReason})`, provider, task, false, undefined, {
      code: "content_blocked",
    });
  }
  const finishReasons = (data.candidates ?? [])
    .map((candidate) => candidate.finishReason)
    .filter((reason): reason is string => typeof reason === "string");
  const blocking = finishReasons.find((reason) => GEMINI_BLOCKING_FINISH_REASONS.has(reason));
  if (blocking) {
    return new ProviderError(`Gemini declined the image (finishReason ${blocking})`, provider, task, false, undefined, {
      code: "content_blocked",
    });
  }
  const reasons = finishReasons.length > 0 ? finishReasons.join(", ") : "none";
  return new ProviderError(`Gemini response contained no images (finishReason ${reasons})`, provider, task, false, undefined, {
    code: "empty_output",
  });
}

export class GeminiImageProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "image";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly model: string;
  private readonly priceTable: { perImageMicros: number };
  readonly minTimeoutMs: number | undefined;

  constructor(config: GeminiImageConfig) {
    this.name = config.name;
    this.minTimeoutMs = config.minTimeoutMs;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, GEMINI_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com";
    this.fetchFn = config.fetchFn ?? fetch;
    this.model = config.model;
    this.priceTable = config.priceTable;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /**
   * Estimate: one output image at the injected per image price. Each
   * generateContent call requests a single image generation; if a response
   * ever carries more inline images the actual metered cost (perImageMicros
   * times the returned image count) exceeds this estimate and the router's
   * caps reconciliation charges the difference after the call.
   */
  estimateCostMicros(): number {
    return this.priceTable.perImageMicros;
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as GeminiImageInput;
    const parts: unknown[] = [{ text: input.prompt }];
    for (const image of input.images ?? []) {
      parts.push({ inline_data: { mime_type: image.mimeType, data: image.dataBase64 } });
    }
    const body = {
      contents: [{ parts }],
      generationConfig: { responseModalities: ["IMAGE"] },
    };

    const data = await requestJson<GenerateContentResponse>(
      this.fetchFn,
      this.name,
      req.task,
      `${this.baseUrl}/v1beta/models/${this.model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signalOf(req),
      },
    );

    const images: GeminiImageOutput["images"] = [];
    for (const candidate of data.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.inlineData?.data) {
          images.push({ mimeType: part.inlineData.mimeType ?? "image/png", dataBase64: part.inlineData.data });
        }
      }
    }
    if (images.length === 0) {
      throw noImageError(data, this.name, req.task);
    }

    const output: GeminiImageOutput = { images, raw: data };
    return { output: output as TOut, costMicros: this.priceTable.perImageMicros * images.length };
  }
}
