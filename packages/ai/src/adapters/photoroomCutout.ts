/**
 * NOT WIRED (Phase 14, 2026-09-29): Photoroom is a competitor, so no live
 * route uses this adapter any more; the cutout stage runs on fal BiRefNet
 * (falCutout.ts). Kept until it is deleted in a cleanup change.
 *
 * Photoroom background removal adapter (multipart POST {baseUrl}/v1/segment
 * with the x-api-key header). Image bytes in, cutout PNG bytes out. Cost is
 * a flat per call price from the injected price table.
 *
 * VERIFY AT FIRST LIVE CALL: the segment endpoint path, multipart field name
 * (image_file) and response content type against
 * https://www.photoroom.com/api/docs. Unit tests cover construction and
 * supports() only.
 */

import type { CostAwareProvider } from "../router";
import { ProviderError } from "../types";
import type { ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { probeRequest, type ProbeOptions, type ProbeResult } from "../probe";
import { httpProviderError, resolveApiKey, signalOf, type AdapterCommonConfig, type FetchLike } from "./shared";

export const PHOTOROOM_API_KEY_ENV = "PHOTOROOM_API_KEY";

export interface PhotoroomCutoutConfig extends AdapterCommonConfig {
  priceTable: { perCallMicros: number };
  /** Host of the account details endpoint the key probe reads. */
  accountBaseUrl?: string;
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

export class PhotoroomCutoutProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "cutout";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly accountBaseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly priceTable: { perCallMicros: number };
  readonly minTimeoutMs: number | undefined;

  constructor(config: PhotoroomCutoutConfig) {
    this.name = config.name;
    this.minTimeoutMs = config.minTimeoutMs;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, PHOTOROOM_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://sdk.photoroom.com";
    this.accountBaseUrl = config.accountBaseUrl ?? "https://image-api.photoroom.com";
    this.fetchFn = config.fetchFn ?? fetch;
    this.priceTable = config.priceTable;
  }

  /**
   * Key probe: GET {accountBaseUrl}/v2/account, the account details
   * endpoint that serves both Remove Background and Image Editing keys
   * (Photoroom docs, checked 2026-09-28). It lives on image-api.photoroom.com,
   * not on the segment host. A 403 means the key is not allowed or the
   * credit balance is zero. Never segments an image.
   */
  probe(options?: ProbeOptions): Promise<ProbeResult> {
    return probeRequest(
      this.fetchFn,
      `${this.accountBaseUrl}/v2/account`,
      { method: "GET", headers: { "x-api-key": this.apiKey } },
      options,
    );
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /**
   * Exact: Photoroom bills a flat injected price per segment call, which is
   * exactly what invoke meters on success.
   */
  estimateCostMicros(): number {
    return this.priceTable.perCallMicros;
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as PhotoroomCutoutInput;
    const form = new FormData();
    const bytes = new Uint8Array(input.imageBytes);
    form.append("image_file", new Blob([bytes], { type: sniffMime(bytes) }), input.filename ?? "source.png");
    if (input.format !== undefined) form.append("format", input.format);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/v1/segment`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, accept: "image/png" },
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
      // A 402 "exhausted the number of images in your plan" is provider_quota.
      throw httpProviderError(this.name, req.task, res.status, bodyText);
    }

    const buffer = await res.arrayBuffer();
    const output: PhotoroomCutoutOutput = {
      imageBytes: new Uint8Array(buffer),
      contentType: res.headers.get("content-type") ?? "image/png",
    };
    return { output: output as TOut, costMicros: this.priceTable.perCallMicros };
  }
}

/** MIME type of the upload from its magic bytes, so the multipart part is
 * typed; PNG when unknown. */
function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "image/png";
}
