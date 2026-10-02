/**
 * A small typed client for the Curvi public API v1 (see types.ts for the
 * routes and wire shapes). Its method names are the OpenAPI operation ids.
 * It has no dependencies beyond the platform fetch, so the CLI, the skill
 * and later SDKs can share it.
 *
 * Retries: a GET, the main image check (it stores nothing) and a pack
 * create (it carries an Idempotency-Key) are sent again after a network
 * error, a 429 or a 5xx, waiting for Retry-After when the server gives one.
 * The same Idempotency-Key is reused on every attempt, so a retried create
 * never makes a second pack or holds credits twice.
 */
import type {
  ApiErrorBody,
  ChannelsResponse,
  CreatePackRequest,
  MainImageCheck,
  MainImageCheckRequest,
  PackFiles,
  PackResponse,
  PhotoAngle,
  PhotoInput,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://curvi.ai/api/v1";

/** Attempts per request, the first one included. */
const MAX_ATTEMPTS = 3;
/** Wait before a retry when the server sends no Retry-After, in ms, doubled per attempt. */
const BASE_BACKOFF_MS = 1000;
/** Never wait longer than this for one retry, whatever Retry-After says. */
const MAX_BACKOFF_MS = 30_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A photo read from disk, sent base64 encoded as a photo's data. */
export interface PhotoFile {
  name: string;
  bytes: Uint8Array;
}

/** A photo from disk or a public https link, with what it shows when it is
 * not the front. */
export type PhotoSource = ({ file: PhotoFile } | { url: string }) & { angle?: PhotoAngle };

/** The wire form of a photo: { url } or { data } (base64). */
export function photoInput(photo: PhotoSource): PhotoInput {
  const angle = photo.angle ? { angle: photo.angle } : {};
  if ("url" in photo) {
    return { url: photo.url, ...angle };
  }
  return { data: Buffer.from(photo.file.bytes).toString("base64"), ...angle };
}

/** The API refuses a pack with more photos than this. */
export const MAX_PACK_PHOTOS = 8;

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
  /** The server's machine readable reason, for example upgrade_required;
   * null when the answer carried none. */
  readonly reason: string | null;
  readonly issues: string[];
  /** Seconds the server asked the caller to wait, when it said. */
  readonly retryAfter: number | null;
  /** On a 409 idempotency_conflict: the pack the key already started. */
  readonly existingPackId: string | null;

  constructor(
    status: number,
    message: string,
    details: { reason?: string | null; issues?: string[]; retryAfter?: number | null; existingPackId?: string | null } = {},
  ) {
    super(message);
    this.name = "CurviApiError";
    this.status = status;
    this.reason = details.reason ?? null;
    this.issues = details.issues ?? [];
    this.retryAfter = details.retryAfter ?? null;
    this.existingPackId = details.existingPackId ?? null;
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
  const bodyRetry =
    typeof body?.retryAfterSeconds === "number" && body.retryAfterSeconds >= 0 ? body.retryAfterSeconds : null;
  return new CurviApiError(response.status, message, {
    reason: typeof body?.reason === "string" ? body.reason : null,
    issues,
    retryAfter: retryAfterSeconds(response) ?? bodyRetry,
    existingPackId: typeof body?.existingPackId === "string" ? body.existingPackId : null,
  });
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
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    let end = baseUrl.length;
    while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) end--;
    this.baseUrl = baseUrl.slice(0, end);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * POST /packs (createPack): starts a pack and holds its credits, like the
   * web form. Photos go in the body as links or base64 bytes.
   */
  createPack(
    photos: readonly PhotoSource[],
    request: Omit<CreatePackRequest, "photos">,
    options: CreatePackOptions = {},
  ): Promise<PackResponse> {
    if (photos.length > MAX_PACK_PHOTOS) {
      throw new Error(`A pack takes at most ${MAX_PACK_PHOTOS} photos.`);
    }
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    const body: CreatePackRequest = { ...request, ...(photos.length > 0 ? { photos: photos.map(photoInput) } : {}) };
    return this.send<PackResponse>("POST", "/packs", { idempotencyKey, retryable: true, json: body });
  }

  /** GET /packs/{id} (getPack). */
  getPack(id: string): Promise<PackResponse> {
    return this.send<PackResponse>("GET", `/packs/${encodeURIComponent(id)}`);
  }

  /** GET /packs/{id}/files (listPackFiles): signed, short lived file URLs. */
  listPackFiles(id: string): Promise<PackFiles> {
    return this.send<PackFiles>("GET", `/packs/${encodeURIComponent(id)}/files`);
  }

  /** POST /checks/main-image (checkMainImage): the free Amazon main image
   * checker. It stores nothing, so a retry is safe without a key. */
  checkMainImage(photo: PhotoSource): Promise<MainImageCheck> {
    const { angle: _angle, ...rest } = photoInput(photo);
    const body: MainImageCheckRequest = rest;
    return this.send<MainImageCheck>("POST", "/checks/main-image", { retryable: true, json: body });
  }

  /** GET /channels (listChannels): the channel specs and bundles a pack can
   * name, with availability on the key's plan. */
  listChannels(): Promise<ChannelsResponse> {
    return this.send<ChannelsResponse>("GET", "/channels");
  }

  private async send<T>(
    method: "GET" | "POST",
    path: string,
    options: { idempotencyKey?: string; retryable?: boolean; json?: unknown } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const retryable = method === "GET" || options.retryable === true;
    const body = options.json === undefined ? undefined : JSON.stringify(options.json);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      };
      if (this.userAgent) headers["User-Agent"] = this.userAgent;
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      let response: Response;
      try {
        response = await this.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}) });
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
