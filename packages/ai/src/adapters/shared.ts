/**
 * Shared plumbing for the thin REST adapters. Adapters are constructed with
 * explicit model IDs and price tables; nothing in this directory hardcodes a
 * model, prompt or price. API keys are resolved once at construction, from
 * the constructor argument first and the named environment variable second.
 */

import { ProviderError } from "../types";
import type { ProviderRequest } from "../types";
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
}

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

export async function requestJson<T>(
  fetchFn: FetchLike,
  provider: string,
  task: string,
  url: string,
  init: RequestInit,
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
    // 5xx and 429 are transient; other 4xx are not.
    const retryable = res.status >= 500 || res.status === 429;
    throw new ProviderError(
      `${provider} responded ${res.status}: ${body.slice(0, 500)}`,
      provider,
      task,
      retryable,
    );
  }
  return (await res.json()) as T;
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
