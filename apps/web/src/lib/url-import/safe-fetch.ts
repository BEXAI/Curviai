/**
 * Server side fetch for URLs a seller pastes (product pages, product JSON
 * and the photos they list). Every URL here is attacker controlled, so the
 * fetch is built to be SSRF safe:
 *
 * - https only, on the default port, with no credentials in the URL and no
 *   IP literal hosts (the URL parser has already turned forms such as
 *   2130706433 or 0x7f.1 into dotted IPv4, so those are caught too).
 * - DNS is resolved by our own lookup, and the connection is made to exactly
 *   the addresses it returned. If any address for the name is not public
 *   (see address.ts) the connection is refused, so DNS rebinding between a
 *   check and the connect has no gap to use.
 * - Redirects are followed by hand, at most three, and every hop goes
 *   through the same checks, so a public page cannot bounce the fetch to a
 *   private address or down to plain http.
 * - One deadline covers every hop and the whole body, and the body is
 *   capped in bytes after decompression, so a slow or endless response and
 *   a compression bomb both stop early.
 * - node:https ignores HTTP_PROXY style env vars, so no proxy can reroute it.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";
import { isPublicAddress } from "./address";

export type ImportFetchReason =
  | "invalid_url"
  | "blocked_host"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "network";

export class ImportFetchError extends Error {
  constructor(
    readonly reason: ImportFetchReason,
    message: string,
  ) {
    super(message);
    this.name = "ImportFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Sent on every import request. Honest about who is asking. */
export const IMPORT_USER_AGENT = "Mozilla/5.0 (compatible; CurviImport/1.0; +https://curvi.ai)";

export const DEFAULT_MAX_REDIRECTS = 3;

const BLOCKED_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];

/**
 * Checks a URL before any network work and returns it parsed. Throws
 * ImportFetchError with reason invalid_url or blocked_host.
 */
export function checkFetchUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImportFetchError("invalid_url", "Not a valid link.");
  }
  if (url.protocol !== "https:") {
    throw new ImportFetchError("invalid_url", "Only https links are allowed.");
  }
  if (url.username || url.password) {
    throw new ImportFetchError("invalid_url", "Links with a user name or password are not allowed.");
  }
  // The URL parser drops :443, so any port left is a non default one.
  if (url.port !== "") {
    throw new ImportFetchError("invalid_url", "Links on a custom port are not allowed.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || isIP(host) !== 0) {
    throw new ImportFetchError("blocked_host", "Links to a bare IP address are not allowed.");
  }
  if (!host.includes(".") || host === "localhost" || BLOCKED_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new ImportFetchError("blocked_host", "That host is not a public website.");
  }
  url.hash = "";
  return url;
}

/**
 * A dns.lookup replacement for the socket. It resolves the name, refuses
 * the connection when any address is not public, and hands the socket only
 * the checked addresses. Node calls it with all: true when it races IPv4 and
 * IPv6 (autoSelectFamily), and without it otherwise; both are handled.
 */
export function guardedLookup(resolver: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        if (addresses.some((entry) => !isPublicAddress(entry.address))) {
          callback(new ImportFetchError("blocked_host", "That host is not a public website."), "", 0);
          return;
        }
        const family = typeof options.family === "number" ? options.family : 0;
        const usable = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        const first = usable[0];
        if (!first) {
          callback(Object.assign(new Error(`No usable address for ${hostname}`), { code: "ENOTFOUND" }), "", 0);
          return;
        }
        if (options.all) {
          callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
        } else {
          callback(null, first.address, first.family);
        }
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), "", 0),
    );
  };
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

export interface TransportInit {
  headers: Record<string, string>;
  lookup: LookupFunction;
  signal: AbortSignal;
}

/** Sends one GET and resolves once the response headers arrive. */
export type Transport = (url: URL, init: TransportInit) => Promise<RawResponse>;

export const httpsTransport: Transport = (url, init) =>
  new Promise<RawResponse>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: init.headers,
        lookup: init.lookup,
        signal: init.signal,
        // A fresh agent per request: no pooled socket from an earlier host
        // can be reused, and every connect goes through the lookup above.
        agent: false,
      },
      (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }),
    );
    request.on("error", reject);
    request.end();
  });

export interface SafeFetchOptions {
  /** Most bytes the (decompressed) body may have. */
  maxBytes: number;
  /** One deadline for every hop and the whole body. */
  timeoutMs: number;
  accept: string;
  maxRedirects?: number;
  resolver?: Resolver;
  transport?: Transport;
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  body: Buffer;
  /** Where the body came from, after redirects. */
  url: URL;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function asFetchError(err: unknown, signal: AbortSignal): ImportFetchError {
  if (err instanceof ImportFetchError) {
    return err;
  }
  if (signal.aborted) {
    return new ImportFetchError("timeout", "The site took too long to answer.");
  }
  return new ImportFetchError("network", "The site could not be reached.");
}

function decoded(response: RawResponse): Readable {
  const encoding = (headerValue(response.headers["content-encoding"]) ?? "identity").trim().toLowerCase();
  const noop = () => undefined;
  switch (encoding) {
    case "":
    case "identity":
      return response.body;
    case "gzip":
    case "x-gzip":
      return pipeline(response.body, zlib.createGunzip(), noop);
    case "deflate":
      return pipeline(response.body, zlib.createInflate(), noop);
    case "br":
      return pipeline(response.body, zlib.createBrotliDecompress(), noop);
    default:
      response.body.destroy();
      throw new ImportFetchError("network", `The site sent an encoding we do not read (${encoding}).`);
  }
}

async function readCapped(response: RawResponse, maxBytes: number): Promise<Buffer> {
  const declared = Number(headerValue(response.headers["content-length"]));
  const encoding = headerValue(response.headers["content-encoding"]);
  if ((!encoding || encoding === "identity") && Number.isFinite(declared) && declared > maxBytes) {
    response.body.destroy();
    throw new ImportFetchError("too_large", "The response is too large.");
  }
  const stream = decoded(response);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      stream.destroy();
      response.body.destroy();
      throw new ImportFetchError("too_large", "The response is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/**
 * GETs an https URL under the rules at the top of this file. Any status is
 * returned (callers decide what a 404 or a 503 means); redirects are
 * followed. Throws ImportFetchError for every refusal and failure.
 */
export async function safeFetch(input: string | URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
  let url = checkFetchUrl(input);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const transport = options.transport ?? httpsTransport;
  const lookup = guardedLookup(options.resolver ?? systemResolver);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const headers = {
    "User-Agent": IMPORT_USER_AGENT,
    Accept: options.accept,
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
  };
  try {
    for (let hop = 0; ; hop += 1) {
      let response: RawResponse;
      try {
        response = await transport(url, { headers, lookup, signal: controller.signal });
      } catch (err) {
        throw asFetchError(err, controller.signal);
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        response.body.destroy();
        const location = headerValue(response.headers.location);
        if (!location) {
          throw new ImportFetchError("network", "The site sent a redirect with no destination.");
        }
        if (hop >= maxRedirects) {
          throw new ImportFetchError("too_many_redirects", "The site redirected too many times.");
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new ImportFetchError("network", "The site sent a redirect we could not follow.");
        }
        url = checkFetchUrl(next);
        continue;
      }
      let body: Buffer;
      try {
        body = await readCapped(response, options.maxBytes);
      } catch (err) {
        response.body.destroy();
        throw asFetchError(err, controller.signal);
      }
      return {
        status: response.status,
        contentType: (headerValue(response.headers["content-type"]) ?? "").toLowerCase(),
        body,
        url,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
