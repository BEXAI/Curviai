/**
 * Turns a pasted product link into a title, notes and a list of photos for
 * the new pack form. Shopify reads GET /products/<handle>.json and falls
 * back to the page's Open Graph tags; Amazon reads the product page and,
 * when Amazon shows its robot check or cannot be reached, still returns the
 * name from the link with a notice instead of failing outright.
 */

import { MESSAGES, isAmazonHost, parseProductUrl, type ProductUrlTarget } from "./product-url";
import { isAmazonBlockPage, parseAmazonPage, parseOpenGraph, parseShopifyProduct, type ParsedProduct } from "./parsers";
import { ImportFetchError, safeFetch, type ImportFetchReason, type SafeFetchOptions, type SafeFetchResult } from "./safe-fetch";
import { clip } from "./html";
import { IMPORT_TITLE_MAX, type ImportedProduct } from "./types";

export type ImportFailureReason =
  | "invalid_url"
  | "blocked_host"
  | "unsupported"
  | "not_found"
  | "timeout"
  | "too_large"
  | "unreachable"
  | "blocked";

export type ProductImportResult =
  | { ok: true; product: ImportedProduct }
  | { ok: false; reason: ImportFailureReason; message: string };

export type ImportFetcher = (url: string | URL, options: SafeFetchOptions) => Promise<SafeFetchResult>;

export interface ImportDeps {
  fetcher?: ImportFetcher;
}

/** Caps for the page and JSON fetches. */
export const PRODUCT_JSON_MAX_BYTES = 2 * 1024 * 1024;
export const PRODUCT_PAGE_MAX_BYTES = 4 * 1024 * 1024;
export const PRODUCT_FETCH_TIMEOUT_MS = 10_000;

const FAILURE_MESSAGES: Record<Exclude<ImportFailureReason, "invalid_url" | "blocked_host" | "unsupported">, string> = {
  not_found: "We could not find a product at that link. Check the link, or add a photo instead.",
  timeout: "That store took too long to answer. Try again, or add a photo instead.",
  too_large: "That page is too large for us to read. Add a photo instead.",
  unreachable: "We could not reach that page. Check the link and try again, or add a photo instead.",
  blocked:
    "Amazon would not show us that page right now. Save the main photo from your listing and add it with Choose a file.",
};

const AMAZON_PARTIAL_NOTICE =
  "Amazon would not show us that page right now, so we only filled in the name. Save the main photo from your listing and add it with Choose a file.";

const PAGE_PARTIAL_NOTICE = "We could only read the basics from that page. Check the name and notes before you start.";

function failure(reason: ImportFailureReason, message?: string): ProductImportResult {
  const text =
    message ??
    (reason === "invalid_url" || reason === "blocked_host" || reason === "unsupported"
      ? MESSAGES[reason]
      : FAILURE_MESSAGES[reason]);
  return { ok: false, reason, message: text };
}

function reasonFromFetch(reason: ImportFetchReason): ImportFailureReason {
  switch (reason) {
    case "invalid_url":
    case "blocked_host":
    case "timeout":
    case "too_large":
      return reason;
    default:
      return "unreachable";
  }
}

function fetchFailure(err: unknown): ProductImportResult {
  if (err instanceof ImportFetchError) {
    return failure(reasonFromFetch(err.reason));
  }
  return failure("unreachable");
}

function hasContent(parsed: ParsedProduct): boolean {
  return parsed.title.length > 0 || parsed.images.length > 0;
}

function product(
  target: ProductUrlTarget,
  platform: ImportedProduct["platform"],
  parsed: ParsedProduct,
  notice?: string,
): ImportedProduct {
  return {
    platform,
    sourceUrl: target.pageUrl.toString(),
    title: parsed.title,
    description: parsed.description,
    bullets: parsed.bullets,
    images: parsed.images,
    partial: notice !== undefined,
    ...(notice ? { notice } : {}),
  };
}

async function importShopify(target: Extract<ProductUrlTarget, { platform: "shopify" }>, fetcher: ImportFetcher) {
  let jsonError: unknown = null;
  try {
    const response = await fetcher(target.jsonUrl, {
      accept: "application/json",
      maxBytes: PRODUCT_JSON_MAX_BYTES,
      timeoutMs: PRODUCT_FETCH_TIMEOUT_MS,
    });
    if (response.status === 200) {
      let json: unknown = null;
      try {
        json = JSON.parse(response.body.toString("utf8"));
      } catch {
        json = null;
      }
      const parsed = parseShopifyProduct(json, response.url);
      if (parsed && hasContent(parsed)) {
        return { ok: true as const, product: product(target, "shopify", parsed) };
      }
    }
  } catch (err) {
    // A blocked host or a too large answer will not change on the page
    // itself, so only a plain miss falls through to the page.
    if (err instanceof ImportFetchError && (err.reason === "blocked_host" || err.reason === "invalid_url")) {
      return fetchFailure(err);
    }
    jsonError = err;
  }

  // Not a Shopify store after all (or its JSON is switched off): read the
  // page's Open Graph tags instead.
  try {
    const response = await fetcher(target.pageUrl, {
      accept: "text/html,application/xhtml+xml",
      maxBytes: PRODUCT_PAGE_MAX_BYTES,
      timeoutMs: PRODUCT_FETCH_TIMEOUT_MS,
    });
    if (response.status === 404 || response.status === 410) {
      return failure("not_found");
    }
    if (response.status !== 200) {
      return failure("unreachable");
    }
    const parsed = parseOpenGraph(response.body.toString("utf8"), response.url);
    return hasContent(parsed)
      ? { ok: true as const, product: product(target, "page", parsed, PAGE_PARTIAL_NOTICE) }
      : failure("not_found");
  } catch (err) {
    return fetchFailure(jsonError ?? err);
  }
}

async function importAmazon(target: Extract<ProductUrlTarget, { platform: "amazon" }>, fetcher: ImportFetcher) {
  const fromSlug = (): ProductImportResult =>
    target.slugTitle
      ? {
          ok: true,
          product: product(
            target,
            "amazon",
            { title: clip(target.slugTitle, IMPORT_TITLE_MAX), description: "", bullets: [], images: [] },
            AMAZON_PARTIAL_NOTICE,
          ),
        }
      : failure("blocked");

  let response: SafeFetchResult;
  try {
    response = await fetcher(target.pageUrl, {
      accept: "text/html,application/xhtml+xml",
      maxBytes: PRODUCT_PAGE_MAX_BYTES,
      timeoutMs: PRODUCT_FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof ImportFetchError && (err.reason === "blocked_host" || err.reason === "invalid_url")) {
      return fetchFailure(err);
    }
    return fromSlug();
  }
  if (response.status === 404) {
    return failure("not_found");
  }
  // A redirect off Amazon is not a product page we know how to read.
  if (!isAmazonHost(response.url.hostname)) {
    return fromSlug();
  }
  const html = response.body.toString("utf8");
  if (response.status !== 200 || isAmazonBlockPage(response.status, html)) {
    return fromSlug();
  }
  const parsed = parseAmazonPage(html, response.url);
  if (!hasContent(parsed)) {
    return fromSlug();
  }
  if (!parsed.title && target.slugTitle) {
    parsed.title = clip(target.slugTitle, IMPORT_TITLE_MAX);
  }
  return { ok: true as const, product: product(target, "amazon", parsed) };
}

export async function importProduct(rawUrl: string, deps: ImportDeps = {}): Promise<ProductImportResult> {
  const parsed = parseProductUrl(rawUrl);
  if (!parsed.ok) {
    return failure(parsed.reason, parsed.message);
  }
  const fetcher = deps.fetcher ?? safeFetch;
  const { target } = parsed;
  return target.platform === "amazon" ? importAmazon(target, fetcher) : importShopify(target, fetcher);
}
