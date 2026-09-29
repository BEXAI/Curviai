/**
 * A small typed client for the Curvi public API v1 (see types.ts for the
 * routes and wire shapes). It has no dependencies beyond the platform fetch,
 * FormData and Blob, so the CLI, the skill and later SDKs can share it.
 *
 * Retries: a GET, and a POST that carries an Idempotency-Key, is sent again
 * after a network error, a 429 or a 5xx, waiting for Retry-After when the
 * server gives one. The same Idempotency-Key is reused on every attempt, so a
 * retried create never makes a second pack or holds credits twice.
 */

import type {
  ApiErrorBody,
  CreatePackRequest,
  MainImageCheck,
  Pack,
  PackFiles,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://curvi.ai/api/v1";

/** Attempts per request, the first one included. */
const MAX_ATTEMPTS = 3;
/** Wait before a retry when the server sends no Retry-After, in ms, doubled per attempt. */
const BASE_BACKOFF_MS = 1000;
/** Never wait longer than this for one retry, whatever Retry-After says. */
const MAX_BACKOFF_MS = 30_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A photo read from disk, sent as the multipart "photo" part. */
export interface PhotoFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export type PhotoSource = { file: PhotoFile } | { url: string };

export interface CurviClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Sent as User-Agent, for example "curvi-cli/0.1.0". */
  userAgent?: string;
  /** Injected in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CreatePackOptions {
  /** Reused on every retry. A fresh one is made when absent. */
  idempotencyKey?: string;
}

export class CurviApiError extends Error {
  readonly status: number;
  readonly issues: string[];
  /** Seconds the server asked the caller to wait, when it said. */
  readonly retryAfter: number | null;

  constructor(status: number, message: string, issues: string[] = [], retryAfter: number | null = null) {
    super(message);
    this.name = "CurviApiError";
    this.status = status;
    this.issues = issues;
    this.retryAfter = retryAfter;
  }
}

/** The request never reached the API, or no answer came back. */
export class CurviNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CurviNetworkError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function errorFrom(response: Response): Promise<CurviApiError> {
  const text = await response.text().catch(() => "");
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = text ? (JSON.parse(text) as Partial<ApiErrorBody>) : null;
  } catch {
    body = null;
  }
  const message =
    typeof body?.error === "string" && body.error.length > 0
      ? body.error
      : `The Curvi API answered ${response.status}.`;
  const issues = Array.isArray(body?.issues) ? body.issues.filter((i): i is string => typeof i === "string") : [];
  return new CurviApiError(response.status, message, issues, retryAfterSeconds(response));
}

export class CurviClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CurviClientOptions) {
    if (!options.apiKey) {
      throw new Error("An API key is required.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** POST /packs: starts a pack and holds its credits, like the web form. */
  createPack(photo: PhotoSource, request: CreatePackRequest, options: CreatePackOptions = {}): Promise<Pack> {
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    return this.send<Pack>("POST", "/packs", {
      idempotencyKey,
      body: () => this.photoBody(photo, request),
    });
  }

  /** GET /packs/{id}. */
  getPack(id: string): Promise<Pack> {
    return this.send<Pack>("GET", `/packs/${encodeURIComponent(id)}`);
  }

  /** GET /packs/{id}/files: signed, short lived file URLs. */
  getPackFiles(id: string): Promise<PackFiles> {
    return this.send<PackFiles>("GET", `/packs/${encodeURIComponent(id)}/files`);
  }

  /** POST /checks/main-image: the free Amazon main image checker. */
  checkMainImage(photo: PhotoSource, options: CreatePackOptions = {}): Promise<MainImageCheck> {
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    return this.send<MainImageCheck>("POST", "/checks/main-image", {
      idempotencyKey,
      body: () => this.photoBody(photo, {}),
    });
  }

  /**
   * A fresh body per attempt: a FormData or string can be sent again, but
   * building it anew keeps every attempt independent of the last one.
   */
  private photoBody(photo: PhotoSource, fields: object): { body: NonNullable<RequestInit["body"]>; contentType?: string } {
    if ("url" in photo) {
      return { body: JSON.stringify({ ...fields, photoUrl: photo.url }), contentType: "application/json" };
    }
    const form = new FormData();
    // A copy into a plain ArrayBuffer, which every Blob constructor accepts.
    const bytes = new Uint8Array(photo.file.bytes).buffer;
    form.append("photo", new Blob([bytes], { type: photo.file.type }), photo.file.name);
    form.append("request", JSON.stringify(fields));
    // fetch sets the multipart boundary itself.
    return { body: form };
  }

  private async send<T>(
    method: "GET" | "POST",
    path: string,
    options: { idempotencyKey?: string; body?: () => { body: NonNullable<RequestInit["body"]>; contentType?: string } } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const retryable = method === "GET" || options.idempotencyKey !== undefined;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      };
      if (this.userAgent) headers["User-Agent"] = this.userAgent;
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
      const payload = options.body?.();
      if (payload?.contentType) headers["Content-Type"] = payload.contentType;

      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers, body: payload?.body });
      } catch (error) {
        lastError = new CurviNetworkError(`Could not reach the Curvi API at ${this.baseUrl}.`, { cause: error });
        if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
        await this.sleep(Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS));
        continue;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }
      const error = await errorFrom(response);
      if (!retryable || !isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS) {
        throw error;
      }
      lastError = error;
      const waitMs =
        error.retryAfter !== null ? error.retryAfter * 1000 : BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await this.sleep(Math.min(waitMs, MAX_BACKOFF_MS));
    }
    // The loop always returns or throws; this satisfies the type checker.
    throw lastError ?? new Error("The request did not complete.");
  }
}
