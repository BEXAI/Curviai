/**
 * Photoroom background removal adapter (multipart POST {baseUrl}/v1/segment
 * with the x-api-key header). Image bytes in, cutout PNG bytes out. Cost is
 * a flat per call price from the injected price table.
 *
 * VERIFY AT FIRST LIVE CALL: the segment endpoint path, multipart field name
 * (image_file) and response content type against
 * https://www.photoroom.com/api/docs. Unit tests cover construction and
 * supports() only.
 */

import { ProviderError } from "../types";
import type { Provider, ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { resolveApiKey, signalOf, type AdapterCommonConfig, type FetchLike } from "./shared";

export const PHOTOROOM_API_KEY_ENV = "PHOTOROOM_API_KEY";

export interface PhotoroomCutoutConfig extends AdapterCommonConfig {
  priceTable: { perCallMicros: number };
}

export interface PhotoroomCutoutInput {
  imageBytes: Uint8Array;
  filename?: string;
  /** Output format hint, e.g. "png". */
  format?: string;
}

export interface PhotoroomCutoutOutput {
  imageBytes: Uint8Array;
  contentType: string;
}

export class PhotoroomCutoutProvider implements Provider {
  readonly name: string;
  readonly kind: ProviderKind = "cutout";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly priceTable: { perCallMicros: number };

  constructor(config: PhotoroomCutoutConfig) {
    this.name = config.name;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, PHOTOROOM_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://sdk.photoroom.com";
    this.fetchFn = config.fetchFn ?? fetch;
    this.priceTable = config.priceTable;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as PhotoroomCutoutInput;
    const form = new FormData();
    const bytes = new Uint8Array(input.imageBytes);
    form.append("image_file", new Blob([bytes]), input.filename ?? "source.png");
    if (input.format !== undefined) form.append("format", input.format);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/v1/segment`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey },
        body: form,
        signal: signalOf(req),
      });
    } catch (err) {
      throw new ProviderError(
        `Network error calling ${this.name}: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
        req.task,
        true,
        err,
      );
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const retryable = res.status >= 500 || res.status === 429;
      throw new ProviderError(`${this.name} responded ${res.status}: ${bodyText.slice(0, 500)}`, this.name, req.task, retryable);
    }

    const buffer = await res.arrayBuffer();
    const output: PhotoroomCutoutOutput = {
      imageBytes: new Uint8Array(buffer),
      contentType: res.headers.get("content-type") ?? "image/png",
    };
    return { output: output as TOut, costMicros: this.priceTable.perCallMicros };
  }
}
