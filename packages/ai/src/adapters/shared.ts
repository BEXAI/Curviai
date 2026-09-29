/**
 * Shared plumbing for the thin REST adapters. Adapters are constructed with
 * explicit model IDs and price tables; nothing in this directory hardcodes a
 * model, prompt or price. API keys are resolved once at construction, from
 * the constructor argument first and the named environment variable second.
 */

import { ProviderError } from "../types";
import type { ProviderErrorCode, ProviderRequest } from "../types";
import type { RoutedProviderRequest } from "../router";

export type FetchLike = typeof fetch;

export interface AdapterCommonConfig {
  /** Registry key, e.g. "flux2-pro". */
  name: string;
  /** Task names this adapter serves; routing stays data driven. */
  tasks: string[];
  /** Explicit key wins; otherwise the adapter's env var is read at construction. */
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  /**
   * The shortest per attempt timeout the router may apply to this adapter,
   * whatever timeout the caller asked for. Async job adapters derive a
   * default from their polling window; pass a value here to override it or
   * to give a synchronous adapter a longer floor.
   */
  minTimeoutMs?: number;
}

/** Extra time on top of an async job's polling window: the create call, the
 * last poll and the result fetch. The router's timeout floor for an async
 * adapter is its polling window plus this margin, so the adapter's own
 * deadline (a clean, metered failure) always fires before the router aborts. */
export const ASYNC_JOB_TIMEOUT_MARGIN_MS = 30_000;

export function resolveApiKey(name: string, explicit: string | undefined, envVar: string): string {
  const key = explicit ?? process.env[envVar];
  if (!key) {
    throw new Error(`Adapter ${name} needs an API key: pass apiKey or set ${envVar}`);
  }
  return key;
}

/** The abort signal the router threads through, when present. */
export function signalOf(req: ProviderRequest): AbortSignal | undefined {
  return (req as RoutedProviderRequest).signal;
}

/**
 * Tells the router that the provider accepted billable work for this attempt,
 * for example an async job that was created. From then on a failure of the
 * attempt (timeout, network error, polling error) is metered at this cost,
 * kept against the spend caps and never retried on the same provider, since a
 * retry would pay for another generation. A no op outside the router.
 */
export function reportBilled(req: ProviderRequest, costMicros: number): void {
  (req as RoutedProviderRequest).onBilled?.(costMicros);
}

/**
 * Rewraps a failure that happened after the provider accepted billable work:
 * never retryable on the same provider, carrying the billed cost. Keeps the
 * original code (for example content_blocked) and the larger billed amount.
 */
export function billedFailure(err: unknown, provider: string, task: string, billedCostMicros: number): ProviderError {
  if (err instanceof ProviderError && !err.retryable && err.billedCostMicros >= billedCostMicros) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  const known = err instanceof ProviderError ? err : undefined;
  return new ProviderError(message, provider, task, false, err, {
    code: known?.code,
    billedCostMicros: Math.max(billedCostMicros, known?.billedCostMicros ?? 0),
    // Unknown failures (an abort, a thrown TypeError) are treated as transient.
    transient: known ? known.transient : true,
  });
}

/** Maps an HTTP error response to a failure class, for example a moderation
 * refusal to content_blocked. Returning undefined keeps the default mapping. */
export type HttpErrorClassifier = (status: number, bodyText: string) => ProviderErrorCode | undefined;

/**
 * Recognizes an answer that says the provider account ran out of quota,
 * credit or plan images, so the router stops asking that provider
 * (provider_quota) instead of retrying it. Matches:
 * - any HTTP 402 Payment Required (BFL "Insufficient credits", fal);
 * - "You have exhausted the number of images in your plan" (a cutout plan);
 * - BFL "Insufficient credits";
 * - OpenAI `insufficient_quota` and Anthropic "credit balance is too low";
 * - fal "Exhausted balance" and "User is locked";
 * - Gemini RESOURCE_EXHAUSTED when it names a billing, prepayment or daily
 *   quota, never a per minute rate limit, which stays a transient 429.
 */
export function quotaErrorCode(status: number, bodyText: string): ProviderErrorCode | undefined {
  if (status === 402) return "provider_quota";
  const body = bodyText.toLowerCase();
  const plainMarkers = [
    "exhausted the number of images",
    "insufficient credits",
    "insufficient_quota",
    "credit balance is too low",
    "exhausted balance",
    "user is locked",
  ];
  if (plainMarkers.some((marker) => body.includes(marker))) {
    return "provider_quota";
  }
  if (body.includes("resource_exhausted") && !body.includes("per minute") && !body.includes("perminute")) {
    const quotaMarkers = ["billing", "prepay", "depleted", "per day", "perday", "daily", "limit: 0"];
    if (quotaMarkers.some((marker) => body.includes(marker))) {
      return "provider_quota";
    }
  }
  return undefined;
}

/**
 * The ProviderError for a non 2xx answer. The adapter's own classifier runs
 * first (for example a moderation refusal to content_blocked), then the
 * quota check. 5xx and 429 are transient and retryable; other 4xx are not.
 * A content block or a quota answer is never retryable, whatever the status.
 */
export function httpProviderError(
  provider: string,
  task: string,
  status: number,
  bodyText: string,
  classify?: HttpErrorClassifier,
): ProviderError {
  const code = classify?.(status, bodyText) ?? quotaErrorCode(status, bodyText);
  const retryable = code !== "content_blocked" && code !== "provider_quota" && (status >= 500 || status === 429);
  return new ProviderError(`${provider} responded ${status}: ${bodyText.slice(0, 500)}`, provider, task, retryable, undefined, {
    code,
  });
}

export async function requestJson<T>(
  fetchFn: FetchLike,
  provider: string,
  task: string,
  url: string,
  init: RequestInit,
  classify?: HttpErrorClassifier,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    throw new ProviderError(
      `Network error calling ${provider}: ${err instanceof Error ? err.message : String(err)}`,
      provider,
      task,
      true,
      err,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw httpProviderError(provider, task, res.status, body, classify);
  }
  return (await res.json()) as T;
}

/**
 * Downloads a provider result URL (for example a BFL sample or an OpenAI
 * image url) with the router's abort signal, so a timed out attempt stops
 * downloading too. Non 2xx and network errors become ProviderErrors with the
 * usual retryable mapping; the router turns them non retryable when the
 * attempt already reported billed work.
 */
export async function downloadBytes(
  fetchFn: FetchLike,
  url: string,
  opts: { provider: string; task: string; signal?: AbortSignal },
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", signal: opts.signal });
  } catch (err) {
    throw new ProviderError(
      `Network error downloading the ${opts.provider} result: ${err instanceof Error ? err.message : String(err)}`,
      opts.provider,
      opts.task,
      true,
      err,
    );
  }
  if (!res.ok) {
    throw new ProviderError(
      `Downloading the ${opts.provider} result failed with status ${res.status}`,
      opts.provider,
      opts.task,
      res.status >= 500 || res.status === 429,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Polling budget of an async job adapter. */
export interface PollBudget {
  pollIntervalMs: number;
  /** Wall clock budget for polling after a successful create. */
  pollTimeoutMs: number;
  /** Safety cap on poll requests. */
  maxPolls: number;
}

/** Resolves an async adapter's polling budget. The wall clock window wins
 * when both are given; maxPolls defaults to enough polls to fill it. */
export function resolvePollBudget(
  config: { pollIntervalMs?: number; pollTimeoutMs?: number; maxPolls?: number },
  defaults: { pollIntervalMs: number; pollTimeoutMs: number },
): PollBudget {
  const pollIntervalMs = config.pollIntervalMs ?? defaults.pollIntervalMs;
  const pollTimeoutMs =
    config.pollTimeoutMs ??
    (config.maxPolls !== undefined ? pollIntervalMs * config.maxPolls : defaults.pollTimeoutMs);
  const maxPolls = config.maxPolls ?? Math.max(1, Math.ceil(pollTimeoutMs / Math.max(1, pollIntervalMs)));
  return { pollIntervalMs, pollTimeoutMs, maxPolls };
}

/** Pixel size of an encoded PNG, JPEG, GIF or WebP image, read from its
 * header without decoding it. Null for anything else or a truncated header. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const at = (i: number) => bytes[i] ?? 0;
  const u16be = (i: number) => (at(i) << 8) | at(i + 1);
  const u16le = (i: number) => at(i) | (at(i + 1) << 8);
  const u24le = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  const u32be = (i: number) => ((at(i) << 24) >>> 0) + ((at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3));
  const ascii = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  const valid = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);

  // PNG: signature, then the IHDR chunk with big endian width and height.
  if (bytes.length >= 24 && at(0) === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return valid(u32be(16), u32be(20));
  }
  // GIF: logical screen size, little endian.
  if (bytes.length >= 10 && ascii(0, 3) === "GIF") {
    return valid(u16le(6), u16le(8));
  }
  // WebP: RIFF container with a VP8, VP8L or VP8X chunk.
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") {
      return valid(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    }
    if (chunk === "VP8L") {
      const b0 = at(21);
      const b1 = at(22);
      const b2 = at(23);
      const b3 = at(24);
      return valid(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (chunk === "VP8X") {
      return valid(1 + u24le(24), 1 + u24le(27));
    }
    return null;
  }
  // JPEG: walk the segments to the first start of frame marker.
  if (bytes.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (at(offset) !== 0xff) return null;
      const marker = at(offset + 1);
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      // Standalone markers carry no length.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return valid(u16be(offset + 7), u16be(offset + 5));
      }
      const length = u16be(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  return null;
}

/** Decodes base64 image data for header inspection. */
export function base64Bytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}
