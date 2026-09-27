/**
 * Gemini image generation adapter over the Generative Language API
 * (POST {baseUrl}/v1beta/models/{model}:generateContent with the
 * x-goog-api-key header). Prompt text plus optional inline reference images
 * in, inline base64 images out. Cost is a flat per output image price from
 * the injected price table.
 *
 * VERIFY AT FIRST LIVE CALL: the generateContent request shape for image
 * output (responseModalities value, inline_data casing) and the response
 * part field names against https://ai.google.dev/api. Unit tests cover
 * construction and supports() only.
 */

import type { CostAwareProvider } from "../router";
import { ProviderError } from "../types";
import type { ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { requestJson, resolveApiKey, signalOf, type AdapterCommonConfig, type FetchLike } from "./shared";

export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

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
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
  }>;
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

  constructor(config: GeminiImageConfig) {
    this.name = config.name;
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
      throw new ProviderError("Gemini response contained no images", this.name, req.task, true);
    }

    const output: GeminiImageOutput = { images, raw: data };
    return { output: output as TOut, costMicros: this.priceTable.perImageMicros * images.length };
  }
}
