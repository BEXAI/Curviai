/**
 * Black Forest Labs FLUX adapter (POST {baseUrl}/v1/{model} with the x-key
 * header, then polling the returned polling_url until the result is Ready).
 * The model path segment, e.g. "flux-2-pro", and the per image price are
 * constructor parameters.
 *
 * Billing: a successful create is treated as billed at the per image price.
 * The adapter reports it to the router right away, so any later failure
 * (polling error, moderation, deadline, router timeout) is metered at that
 * price and never retried on this provider, since a retry would pay for a
 * second generation. BFL does not document whether moderated or failed jobs
 * are charged, so this is a deliberate upper bound for the spend caps.
 *
 * Timing: polling stops at pollTimeoutMs of wall clock after the create
 * (default 120 s) or maxPolls, whichever comes first, and minTimeoutMs tells
 * the router never to abort an attempt before that window plus a margin.
 *
 * VERIFY AT FIRST LIVE CALL: the create endpoint path for the current FLUX 2
 * pro model, the polling_url response contract, terminal status names
 * (Ready, Error, Content Moderated, Request Moderated, Task not found) and
 * the result.sample field against https://docs.bfl.ai. Status names checked
 * against the integration guidelines on 2026-09-28.
 *
 * The polling_url must be used as returned (it can name a regional host),
 * but it carries the x-key credential, so it is fetched only when it is
 * https on bfl.ai or one of its subdomains, or on the configured base
 * origin; anything else fails before the key leaves the process.
 */

import type { CostAwareProvider } from "../router";
import { ProviderError } from "../types";
import type { ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { probeRequest, type ProbeOptions, type ProbeResult } from "../probe";
import {
  ASYNC_JOB_TIMEOUT_MARGIN_MS,
  billedFailure,
  isHostOrSubdomain,
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

export const BFL_API_KEY_ENV = "BFL_API_KEY";

/** Default polling budget: every 500 ms for up to 120 s after the create. */
export const BFL_DEFAULT_POLL = { pollIntervalMs: 500, pollTimeoutMs: 120_000 } as const;

/** Terminal statuses where BFL's moderation declined the prompt or output. */
const BFL_MODERATED_STATUSES = new Set(["Content Moderated", "Request Moderated"]);
/** Terminal failure statuses. */
const BFL_FAILED_STATUSES = new Set(["Error", "Failed", "Task not found"]);

/** Host a BFL polling_url may name, besides the configured base origin.
 * Matches the host exactly or any subdomain, e.g. a regional api host. */
const ALLOWED_BFL_HOST_SUFFIX = "bfl.ai";

export interface BflFluxConfig extends AdapterCommonConfig {
  /** Model path segment from seed data, e.g. "flux-2-pro". */
  model: string;
  priceTable: { perImageMicros: number };
  pollIntervalMs?: number;
  /** Wall clock polling budget after a successful create. */
  pollTimeoutMs?: number;
  /** Safety cap on polling attempts; defaults to fill pollTimeoutMs. */
  maxPolls?: number;
  /** Injectable millisecond clock for the polling deadline. */
  now?: () => number;
}

export interface BflFluxInput {
  prompt: string;
  width?: number;
  height?: number;
  /** Base64 reference image for image to image edits. */
  inputImageBase64?: string;
  seed?: number;
}

export interface BflFluxOutput {
  /** Signed URL of the generated image; download promptly, BFL URLs expire. */
  imageUrl: string;
  raw: unknown;
}

interface CreateResponse {
  id?: string;
  polling_url?: string;
}

interface PollResponse {
  status?: string;
  result?: { sample?: string };
}

export class BflFluxProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "image";
  /** The router never aborts an attempt before the polling window ends. */
  readonly minTimeoutMs: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly model: string;
  private readonly priceTable: { perImageMicros: number };
  private readonly poll: PollBudget;
  private readonly now: () => number;

  constructor(config: BflFluxConfig) {
    this.name = config.name;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, BFL_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://api.bfl.ai";
    this.fetchFn = config.fetchFn ?? fetch;
    this.model = config.model;
    this.priceTable = config.priceTable;
    this.poll = resolvePollBudget(config, BFL_DEFAULT_POLL);
    this.now = config.now ?? Date.now;
    this.minTimeoutMs = config.minTimeoutMs ?? this.poll.pollTimeoutMs + ASYNC_JOB_TIMEOUT_MARGIN_MS;
  }

  /**
   * Key probe: GET /v1/credits, which returns the account's credit balance
   * (BFL API reference, checked 2026-09-28). Never creates a job.
   */
  probe(options?: ProbeOptions): Promise<ProbeResult> {
    return probeRequest(this.fetchFn, `${this.baseUrl}/v1/credits`, { method: "GET", headers: { "x-key": this.apiKey } }, options);
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  /**
   * Exact bound: each BFL create call yields at most one image, billed at
   * the injected per image price, which is exactly what invoke meters on
   * success.
   */
  estimateCostMicros(): number {
    return this.priceTable.perImageMicros;
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as BflFluxInput;
    const signal = signalOf(req);
    const body: Record<string, unknown> = { prompt: input.prompt };
    if (input.width !== undefined) body.width = input.width;
    if (input.height !== undefined) body.height = input.height;
    if (input.inputImageBase64 !== undefined) body.input_image = input.inputImageBase64;
    if (input.seed !== undefined) body.seed = input.seed;

    const created = await requestJson<CreateResponse>(
      this.fetchFn,
      this.name,
      req.task,
      `${this.baseUrl}/v1/${this.model}`,
      {
        method: "POST",
        headers: { "x-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );

    // The job exists and is paid for from here on; a retry would pay again.
    const billed = this.priceTable.perImageMicros;
    reportBilled(req, billed);
    try {
      return await this.pollUntilReady<TOut>(created, req.task, signal);
    } catch (err) {
      throw billedFailure(err, this.name, req.task, billed);
    }
  }

  /**
   * Refuses a polling_url that would send the x-key credential anywhere but
   * BFL: it must be https on bfl.ai or a subdomain, or share the configured
   * base origin (a test server or proxy). Mirrors the fal gateway check.
   */
  private assertAllowedPollingUrl(raw: string, task: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ProviderError("BFL create response polling_url is not a valid URL", this.name, task, false);
    }
    const sameOrigin = url.origin === new URL(this.baseUrl).origin;
    const knownBflHost = url.protocol === "https:" && isHostOrSubdomain(url.hostname.toLowerCase(), ALLOWED_BFL_HOST_SUFFIX);
    if (!sameOrigin && !knownBflHost) {
      throw new ProviderError(
        `BFL create response polling_url points at disallowed host ${url.host}; refusing to forward credentials`,
        this.name,
        task,
        false,
      );
    }
    return url.toString();
  }

  private async pollUntilReady<TOut>(
    created: CreateResponse,
    task: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderResponse<TOut>> {
    if (!created.polling_url) {
      throw new ProviderError("BFL create response had no polling_url", this.name, task, false);
    }
    const pollingUrl = this.assertAllowedPollingUrl(created.polling_url, task);
    const deadline = this.now() + this.poll.pollTimeoutMs;
    for (let poll = 0; poll < this.poll.maxPolls && this.now() < deadline; poll++) {
      await sleepMs(this.poll.pollIntervalMs, signal);
      const state = await requestJson<PollResponse>(this.fetchFn, this.name, task, pollingUrl, {
        method: "GET",
        headers: { "x-key": this.apiKey },
        signal,
      });
      if (state.status === "Ready") {
        const imageUrl = state.result?.sample;
        if (!imageUrl) {
          throw new ProviderError("BFL Ready result had no sample URL", this.name, task, false, undefined, {
            code: "empty_output",
          });
        }
        const output: BflFluxOutput = { imageUrl, raw: state };
        return { output: output as TOut, costMicros: this.priceTable.perImageMicros };
      }
      if (state.status !== undefined && BFL_MODERATED_STATUSES.has(state.status)) {
        throw new ProviderError(`BFL declined the generation with status ${state.status}`, this.name, task, false, undefined, {
          code: "content_blocked",
        });
      }
      if (state.status !== undefined && BFL_FAILED_STATUSES.has(state.status)) {
        throw new ProviderError(`BFL generation failed with status ${state.status}`, this.name, task, false);
      }
    }
    // A stalled job says the provider is struggling: it counts toward the
    // breaker, but is not retried since the job was already paid for.
    throw new ProviderError(
      `BFL polling ended after ${this.poll.pollTimeoutMs}ms or ${this.poll.maxPolls} polls without a result`,
      this.name,
      task,
      false,
      undefined,
      { transient: true },
    );
  }
}
