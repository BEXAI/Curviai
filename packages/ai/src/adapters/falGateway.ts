/**
 * fal.ai queue gateway adapter, the generic secondary route for image and
 * video models (POST {baseUrl}/{modelId} with an Authorization "Key" header,
 * then polling status_url until COMPLETED and fetching response_url). The
 * fal model ID, provider kind and per call price are constructor parameters,
 * so one class covers any fal hosted model. Follow up URLs from the queue
 * response are validated against the configured base origin and known fal
 * hosts before being fetched, so credentials are never forwarded elsewhere.
 *
 * Billing: a successful queue submit is treated as billed at the per call
 * price. The adapter reports it to the router right away, so any later
 * failure (polling error, failed status, deadline, router timeout) is
 * metered at that price and never retried on this provider, since a retry
 * would pay for a second generation. This is a deliberate upper bound for
 * the spend caps until fal's charging of failed requests is verified.
 *
 * Timing: polling stops at pollTimeoutMs of wall clock after the submit
 * (default 300 s, sized for video) or maxPolls, whichever comes first, and
 * minTimeoutMs tells the router never to abort an attempt before that
 * window plus a margin.
 *
 * VERIFY AT FIRST LIVE CALL: queue response field names (request_id,
 * status_url, response_url), status values (IN_QUEUE, IN_PROGRESS,
 * COMPLETED) and per model output shapes against https://docs.fal.ai.
 */

import type { CostAwareProvider } from "../router";
import { ProviderError } from "../types";
import type { ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import {
  ASYNC_JOB_TIMEOUT_MARGIN_MS,
  billedFailure,
  reportBilled,
  requestJson,
  resolveApiKey,
  resolvePollBudget,
  signalOf,
  sleepMs,
  type AdapterCommonConfig,
  type FetchLike,
  type PollBudget,
} from "./shared";

export const FAL_API_KEY_ENV = "FAL_KEY";

/** Default polling budget: every second for up to 300 s after the submit. */
export const FAL_DEFAULT_POLL = { pollIntervalMs: 1_000, pollTimeoutMs: 300_000 } as const;

/** Hosts fal may hand back for polling, besides the configured base origin.
 * Matches the host exactly or any subdomain (dot boundary enforced). */
const ALLOWED_FAL_HOST_SUFFIXES = ["fal.run", "fal.ai"] as const;

function isHostOrSubdomain(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

export interface FalGatewayConfig extends AdapterCommonConfig {
  /** fal model ID from seed data, e.g. an image or video model path. */
  modelId: string;
  /** What this route serves; fal hosts several modalities. */
  kind: ProviderKind;
  priceTable: { perCallMicros: number };
  pollIntervalMs?: number;
  /** Wall clock polling budget after a successful submit. */
  pollTimeoutMs?: number;
  /** Safety cap on polling attempts; defaults to fill pollTimeoutMs. */
  maxPolls?: number;
  /** Injectable millisecond clock for the polling deadline. */
  now?: () => number;
}

/** Input is passed through to the fal model as the request body. */
export type FalGatewayInput = Record<string, unknown>;

export interface FalGatewayOutput {
  /** The model's response payload, shape depends on the fal model. */
  result: unknown;
}

interface QueueResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

interface StatusResponse {
  status?: string;
}

export class FalGatewayProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  /** The router never aborts an attempt before the polling window ends. */
  readonly minTimeoutMs: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly modelId: string;
  private readonly priceTable: { perCallMicros: number };
  private readonly poll: PollBudget;
  private readonly now: () => number;

  constructor(config: FalGatewayConfig) {
    this.name = config.name;
    this.kind = config.kind;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, FAL_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://queue.fal.run";
    this.fetchFn = config.fetchFn ?? fetch;
    this.modelId = config.modelId;
    this.priceTable = config.priceTable;
    this.poll = resolvePollBudget(config, FAL_DEFAULT_POLL);
    this.now = config.now ?? Date.now;
    this.minTimeoutMs = config.minTimeoutMs ?? this.poll.pollTimeoutMs + ASYNC_JOB_TIMEOUT_MARGIN_MS;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /**
   * Exact: this fal route is billed at the flat injected per call price,
   * which is exactly what invoke meters on success.
   */
  estimateCostMicros(): number {
    return this.priceTable.perCallMicros;
  }

  /**
   * fal's queue response echoes follow up URLs (status_url, response_url)
   * that we then fetch with the Authorization Key header attached. Fetching
   * them verbatim would let a compromised or spoofed queue response steer
   * the poll anywhere and forward the fal credential there (SSRF plus
   * credential forwarding). Both URLs must therefore sit on the configured
   * base origin or on a known fal host over https (fal.run, fal.ai or a
   * subdomain of either); anything else is a non retryable ProviderError.
   */
  private assertAllowedFollowUpUrl(raw: string, field: string, task: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ProviderError(`fal queue response ${field} is not a valid URL`, this.name, task, false);
    }
    const base = new URL(this.baseUrl);
    const sameOrigin = url.origin === base.origin;
    const knownFalHost =
      url.protocol === "https:" &&
      ALLOWED_FAL_HOST_SUFFIXES.some((suffix) => isHostOrSubdomain(url.hostname.toLowerCase(), suffix));
    if (!sameOrigin && !knownFalHost) {
      throw new ProviderError(
        `fal queue response ${field} points at disallowed host ${url.host}; refusing to forward credentials`,
        this.name,
        task,
        false,
      );
    }
    return url.toString();
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const signal = signalOf(req);
    const headers = { authorization: `Key ${this.apiKey}`, "content-type": "application/json" };

    const queued = await requestJson<QueueResponse>(
      this.fetchFn,
      this.name,
      req.task,
      `${this.baseUrl}/${this.modelId}`,
      { method: "POST", headers, body: JSON.stringify(req.input ?? {}), signal },
    );

    // The request is queued and paid for from here on; a retry would pay again.
    const billed = this.priceTable.perCallMicros;
    reportBilled(req, billed);
    try {
      return await this.pollUntilDone<TOut>(queued, headers, req.task, signal);
    } catch (err) {
      throw billedFailure(err, this.name, req.task, billed);
    }
  }

  private async pollUntilDone<TOut>(
    queued: QueueResponse,
    headers: Record<string, string>,
    task: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderResponse<TOut>> {
    if (!queued.status_url || !queued.response_url) {
      throw new ProviderError("fal queue response missing status_url or response_url", this.name, task, false);
    }
    const statusUrl = this.assertAllowedFollowUpUrl(queued.status_url, "status_url", task);
    const responseUrl = this.assertAllowedFollowUpUrl(queued.response_url, "response_url", task);

    const deadline = this.now() + this.poll.pollTimeoutMs;
    for (let poll = 0; poll < this.poll.maxPolls && this.now() < deadline; poll++) {
      await sleepMs(this.poll.pollIntervalMs, signal);
      const state = await requestJson<StatusResponse>(this.fetchFn, this.name, task, statusUrl, {
        method: "GET",
        headers,
        signal,
      });
      if (state.status === "COMPLETED") {
        const result = await requestJson<unknown>(this.fetchFn, this.name, task, responseUrl, {
          method: "GET",
          headers,
          signal,
        });
        const output: FalGatewayOutput = { result };
        return { output: output as TOut, costMicros: this.priceTable.perCallMicros };
      }
      if (state.status !== undefined && state.status !== "IN_QUEUE" && state.status !== "IN_PROGRESS") {
        throw new ProviderError(`fal request ended with status ${state.status}`, this.name, task, false);
      }
    }
    // A stalled request says the provider is struggling: it counts toward
    // the breaker, but is not retried since the request was already paid for.
    throw new ProviderError(
      `fal polling ended after ${this.poll.pollTimeoutMs}ms or ${this.poll.maxPolls} polls without a result`,
      this.name,
      task,
      false,
      undefined,
      { transient: true },
    );
  }
}
