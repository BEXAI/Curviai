/**
 * Key probes: the cheapest authenticated call each provider offers, used by
 * the protected GET /api/health/providers route so a bad or revoked key shows
 * up before a customer pack and not during one.
 *
 * A probe only reads account or model metadata (a model resource, a credit
 * balance). It never generates anything and never spends money, so it runs
 * outside callWithFailover on purpose: there is nothing to meter, a retry
 * would only hide a bad key, and a probe failure must not trip the circuit
 * breaker that live packs rely on. Every probe has a hard timeout and never
 * throws; failures come back as data.
 */

import type { Provider } from "./types";

/** Hard ceiling on one probe, network wait included. */
export const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProbeResult {
  /** BFL account credits when its metadata probe returns a finite balance. */
  balanceCredits?: number;
  /** True when the provider accepted the key. */
  ok: boolean;
  /** HTTP status of the probe call; null when no response came back. */
  status: number | null;
  latencyMs: number;
  /** Short plain reason when ok is false. Never a key or a response body. */
  error?: string;
  /** Set when the provider has no free authenticated endpoint to call. */
  skipped?: string;
}

/** A provider that can check its own key. */
export interface ProbeableProvider extends Provider {
  probe(options?: ProbeOptions): Promise<ProbeResult>;
}

export function isProbeable(provider: Provider): provider is ProbeableProvider {
  return typeof (provider as Partial<ProbeableProvider>).probe === "function";
}

/** Plain reason for a refused probe, by status. */
export function probeStatusReason(status: number): string {
  if (status === 401) return "The provider refused the key.";
  if (status === 403) return "The key is not allowed to make this call, or the account has no credit left.";
  if (status === 404) return "The provider does not know this model or endpoint.";
  if (status === 429) return "The provider is rate limiting this key.";
  if (status >= 500) return "The provider had a server error.";
  return `The provider answered with status ${status}.`;
}

/** Plain reason for a probe that ran out of time. */
function noAnswer(timeoutMs: number): string {
  if (timeoutMs < 1_000) return `No answer within ${timeoutMs} milliseconds.`;
  const seconds = Math.round(timeoutMs / 1_000);
  return `No answer within ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

type FetchLike = typeof fetch;

/**
 * One GET (or other metadata request) with a hard timeout. Resolves with the
 * status and latency; never throws. The response body is discarded unread,
 * so nothing the provider echoes can leak into the report.
 */
export async function probeRequest(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  options: ProbeOptions = {},
  now: () => number = Date.now,
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("probe timed out"));
  }, timeoutMs);
  const started = now();
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    const latencyMs = Math.max(0, now() - started);
    await res.body?.cancel().catch(() => undefined);
    return res.ok
      ? { ok: true, status: res.status, latencyMs }
      : { ok: false, status: res.status, latencyMs, error: probeStatusReason(res.status) };
  } catch (err) {
    const latencyMs = Math.max(0, now() - started);
    if (timedOut) {
      return { ok: false, status: null, latencyMs, error: noAnswer(timeoutMs) };
    }
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, status: null, latencyMs, error: `The call did not reach the provider (${name}).` };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * fal account balance (docs/phases/PHASE_18.md P18-03). fal has no free key
 * probe for the cutout key itself, but its Platform API reports the account's
 * credit balance to an Admin API key: GET
 * https://api.fal.ai/v1/account/billing?expand=credits with
 * "Authorization: Key <admin key>", answering
 * { username, credits: { current_balance, currency } } (docs/verification.md,
 * checked 2026-10-01). A read only metadata call that spends nothing, so it
 * runs outside callWithFailover like every probe here: one attempt, a hard
 * timeout, no retry, never throws, and the key never reaches a log or the
 * result.
 */
export const FAL_BILLING_URL = "https://api.fal.ai/v1/account/billing?expand=credits";
/** Default ceiling on one balance probe; the caller passes the seeded value. */
export const FAL_BALANCE_PROBE_TIMEOUT_MS = 5_000;

export interface FalBalanceProbeOptions {
  /** A fal Admin API key (not the inference key). */
  adminKey: string;
  timeoutMs?: number;
  /** Any fetch that takes a URL string; the global fetch by default. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  now?: () => number;
}

export interface FalBalanceResult {
  /** True when fal answered 200 with a numeric balance. */
  ok: boolean;
  /** HTTP status; null when no response came back. */
  status: number | null;
  /** The account's current credit balance; null when it could not be read. */
  balanceUsd: number | null;
  /** The balance's currency as fal reports it, e.g. "USD"; null when unread. */
  currency: string | null;
  latencyMs: number;
  /** Short plain reason when ok is false. Never a key or a response body. */
  error?: string;
}

/** Reads credits.current_balance and credits.currency from a billing body. */
export function parseFalBilling(body: unknown): { balanceUsd: number; currency: string | null } | null {
  const credits = (body as { credits?: unknown } | null)?.credits as
    | { current_balance?: unknown; currency?: unknown }
    | undefined;
  const balance = credits?.current_balance;
  if (typeof balance !== "number" || !Number.isFinite(balance)) {
    return null;
  }
  const currency = typeof credits?.currency === "string" && credits.currency.length <= 8 ? credits.currency : null;
  return { balanceUsd: balance, currency };
}

/** One balance read for one fal account. Never throws. */
export async function probeFalBalance(options: FalBalanceProbeOptions): Promise<FalBalanceResult> {
  const timeoutMs = options.timeoutMs ?? FAL_BALANCE_PROBE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const fetchFn = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    controller.abort(options.signal.reason);
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("probe timed out"));
  }, timeoutMs);
  const started = now();
  const unread = { balanceUsd: null, currency: null } as const;
  try {
    const res = await fetchFn(FAL_BILLING_URL, {
      method: "GET",
      headers: { Authorization: `Key ${options.adminKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, ...unread, latencyMs: Math.max(0, now() - started), error: probeStatusReason(res.status) };
    }
    const parsed = parseFalBilling(await res.json().catch(() => null));
    const latencyMs = Math.max(0, now() - started);
    if (!parsed) {
      return { ok: false, status: res.status, ...unread, latencyMs, error: "The provider answered without a credit balance." };
    }
    return { ok: true, status: res.status, ...parsed, latencyMs };
  } catch (err) {
    const latencyMs = Math.max(0, now() - started);
    if (timedOut) {
      return { ok: false, status: null, ...unread, latencyMs, error: noAnswer(timeoutMs) };
    }
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, status: null, ...unread, latencyMs, error: `The call did not reach the provider (${name}).` };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** A probe that was not run, for providers without a free endpoint. */
export function skippedProbe(reason: string): ProbeResult {
  return { ok: true, status: null, latencyMs: 0, skipped: reason };
}

/** A probe result kept with the time it was taken. */
export interface RecordedProbe extends ProbeResult {
  name: string;
  at: number;
}

const probeScope = globalThis as typeof globalThis & { __curviLastProbes?: Map<string, RecordedProbe> };

function lastProbes(): Map<string, RecordedProbe> {
  probeScope.__curviLastProbes ??= new Map();
  return probeScope.__curviLastProbes;
}

/**
 * Keeps the newest probe result per provider in this process, so cheap
 * readers (the new pack preflight) can use what the last probe learned
 * without calling the provider again.
 */
export function recordProbeReports(reports: ReadonlyArray<ProbeResult & { name: string }>, now: number = Date.now()): void {
  const store = lastProbes();
  for (const report of reports) {
    store.set(report.name, { ...report, at: now });
  }
}

/** The newest recorded probe for a provider, or null when none ran yet. */
export function lastProbeReport(name: string): RecordedProbe | null {
  return lastProbes().get(name) ?? null;
}

/** Forgets every recorded probe; for tests. */
export function clearProbeReports(): void {
  lastProbes().clear();
}

export interface ProbeTarget {
  name: string;
  provider: Provider;
}

export interface ProbeReport extends ProbeResult {
  name: string;
}

/**
 * Probes every target at once. A provider without a probe method is
 * reported as skipped. A probe that throws or ignores its timeout is caught
 * and reported as failed, so the caller always gets one result per target.
 */
export async function probeProviders(targets: ProbeTarget[], options: ProbeOptions = {}): Promise<ProbeReport[]> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return Promise.all(
    targets.map(async ({ name, provider }): Promise<ProbeReport> => {
      if (!isProbeable(provider)) {
        return { name, ...skippedProbe("This provider has no key probe.") };
      }
      let guard: ReturnType<typeof setTimeout> | undefined;
      const started = Date.now();
      try {
        const backstop = new Promise<ProbeResult>((resolve) => {
          guard = setTimeout(
            () =>
              resolve({
                ok: false,
                status: null,
                latencyMs: Date.now() - started,
                error: noAnswer(timeoutMs),
              }),
            timeoutMs + 1_000,
          );
        });
        return { name, ...(await Promise.race([provider.probe({ ...options, timeoutMs }), backstop])) };
      } catch (err) {
        const reason = err instanceof Error ? err.name : "Error";
        return { name, ok: false, status: null, latencyMs: Date.now() - started, error: `The probe failed (${reason}).` };
      } finally {
        if (guard) clearTimeout(guard);
      }
    }),
  );
}
