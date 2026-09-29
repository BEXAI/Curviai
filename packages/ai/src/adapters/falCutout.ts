/**
 * Background removal through a fal.ai hosted segmentation model (BiRefNet,
 * MIT licensed), on top of the fal queue gateway adapter. Image bytes in,
 * a transparent cutout PNG out, the same contract the live runtime's cutout
 * path consumes (alpha mask, segmentation refusal checks).
 *
 * Request: the queue submit body is { image_url, ...modelParams }, where
 * image_url is the photo as a base64 data URI (fal accepts data URIs for
 * file inputs) and modelParams (model variant, operating resolution,
 * output format) come from seed data, like the model ID and the price
 * (CLAUDE.md rule 2). Response: { image: { url, content_type, width,
 * height } }; the PNG at image.url is downloaded without credentials.
 *
 * Billing and timing follow FalGatewayProvider: the queue submit is
 * reported as billed at the flat seeded price, so a failure after it is
 * metered and never retried on this provider. The polling window is short,
 * since a cutout takes seconds, not minutes.
 *
 * Verified against fal's model page and queue docs on 2026-09-29
 * (docs/verification.md).
 */

import type { CostAwareProvider } from "../router";
import { ProviderError } from "../types";
import type { ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { FalGatewayProvider, type FalGatewayOutput } from "./falGateway";
import { ASYNC_JOB_TIMEOUT_MARGIN_MS, downloadBytes, type AdapterCommonConfig, type FetchLike } from "./shared";

/** Polling budget for a cutout: every half second for up to 90 seconds. */
export const FAL_CUTOUT_DEFAULT_POLL = { pollIntervalMs: 500, pollTimeoutMs: 90_000 } as const;

/** Input of every cutout provider: the photo's encoded bytes. */
export interface CutoutInput {
  imageBytes: Uint8Array;
  filename?: string;
  /** Output format hint, e.g. "png". */
  format?: string;
}

/** Output of every cutout provider: the cutout image, transparent PNG. */
export interface CutoutOutput {
  imageBytes: Uint8Array;
  contentType: string;
}

export interface FalCutoutConfig extends AdapterCommonConfig {
  /** fal model ID from seed data, e.g. "fal-ai/birefnet/v2". */
  modelId: string;
  /** Extra request fields from seed data (model variant, resolution, format). */
  modelParams?: Record<string, unknown>;
  priceTable: { perCallMicros: number };
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  maxPolls?: number;
  now?: () => number;
}

interface FalImageFile {
  url?: unknown;
  content_type?: unknown;
}

export class FalCutoutProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "cutout";
  /** The gateway's polling window plus a margin for the result download. */
  readonly minTimeoutMs: number;

  private readonly gateway: FalGatewayProvider;
  private readonly tasks: string[];
  private readonly modelParams: Record<string, unknown>;
  private readonly fetchFn: FetchLike;
  private readonly priceTable: { perCallMicros: number };

  constructor(config: FalCutoutConfig) {
    this.name = config.name;
    this.tasks = config.tasks;
    this.modelParams = config.modelParams ?? {};
    this.fetchFn = config.fetchFn ?? fetch;
    this.priceTable = config.priceTable;
    this.gateway = new FalGatewayProvider({
      name: config.name,
      tasks: config.tasks,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      fetchFn: this.fetchFn,
      modelId: config.modelId,
      kind: "cutout",
      priceTable: config.priceTable,
      pollIntervalMs: config.pollIntervalMs ?? FAL_CUTOUT_DEFAULT_POLL.pollIntervalMs,
      pollTimeoutMs: config.pollTimeoutMs ?? (config.maxPolls === undefined ? FAL_CUTOUT_DEFAULT_POLL.pollTimeoutMs : undefined),
      maxPolls: config.maxPolls,
      now: config.now,
    });
    this.minTimeoutMs = config.minTimeoutMs ?? this.gateway.minTimeoutMs + ASYNC_JOB_TIMEOUT_MARGIN_MS;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /** Exact: the flat seeded per call price, what invoke meters on success. */
  estimateCostMicros(): number {
    return this.priceTable.perCallMicros;
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as CutoutInput;
    const bytes = new Uint8Array(input.imageBytes);
    const imageUrl = `data:${sniffMime(bytes)};base64,${Buffer.from(bytes).toString("base64")}`;
    // Spread the routed request so the router's abort signal and billing
    // hook reach the gateway.
    const queued = await this.gateway.invoke<Record<string, unknown>, FalGatewayOutput>({
      ...(req as ProviderRequest<unknown>),
      input: { ...this.modelParams, image_url: imageUrl },
    });
    const image = (queued.output.result as { image?: FalImageFile } | null)?.image;
    const url = typeof image?.url === "string" ? image.url : null;
    if (!url || !url.startsWith("https://")) {
      throw new ProviderError(`${this.name} returned no https image url`, this.name, req.task, false, undefined, {
        code: "empty_output",
      });
    }
    const downloaded = await downloadBytes(this.fetchFn, url, {
      provider: this.name,
      task: req.task,
      signal: (req as { signal?: AbortSignal }).signal,
    });
    if (!isPng(downloaded)) {
      throw new ProviderError(`${this.name} returned a cutout that is not a PNG`, this.name, req.task, false, undefined, {
        code: "empty_output",
      });
    }
    const output: CutoutOutput = { imageBytes: downloaded, contentType: "image/png" };
    return { output: output as TOut, costMicros: this.priceTable.perCallMicros };
  }
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/** MIME type of the upload from its magic bytes; PNG when unknown. */
function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "image/png";
}
