/**
 * The store image audit (docs/phases/PHASE_18.md P18-18). A visitor names a
 * Shopify store; the server reads its public product list and checks the
 * first image of each product against one checker channel's registry rules,
 * the same checks as the free main image checker. Deterministic: no AI call
 * and nothing stored.
 *
 * Every outside fetch is attacker controlled (the store and the image links
 * it lists), so all of them go through the SSRF safe fetch
 * (lib/url-import/safe-fetch.ts) and every image through the product photo
 * import's guards (lib/url-import/image.ts importPhoto: blocked hosts, the
 * upload byte and pixel caps, type proven by magic bytes), with the seeded
 * per image deadline and concurrency. One audit deadline bounds the whole
 * run, so a slow store cannot hold a request open.
 */

import { storeAudit } from "@curvi/pipeline/seed";
import { flatPixelsOnWhite, type FlatPixels } from "@curvi/pipeline/pixels";
import { storeAuditErrors } from "@/components/marketing/search-copy";
import type { CheckerChannel } from "@/lib/tools/checker-rules";
import { checkRows, flattenOnWhite, measurePixels } from "@/lib/tools/main-image-analysis";
import { importPhoto } from "@/lib/url-import/image";
import type { ImportFetcher } from "@/lib/url-import/import-product";
import { ImportFetchError, safeFetch } from "@/lib/url-import/safe-fetch";
import { parseProductList, productListUrl, type ListedProduct } from "./parse";
import type {
  StoreAuditOutcome,
  StoreAuditProduct,
  StoreAuditProductResult,
  StoreAuditReport,
  StoreAuditSummary,
} from "./types";

export interface StoreAuditLimits {
  maxProducts: number;
  imageConcurrency: number;
  imageTimeoutMs: number;
  productListTimeoutMs: number;
  productListMaxBytes: number;
  auditDeadlineMs: number;
  thinImageCount: number;
}

export interface StoreAuditDeps {
  /** Every outside fetch. Defaults to the SSRF safe fetch. */
  fetcher?: ImportFetcher;
  /** Decodes an image to flat pixels. Defaults to the pipeline's sharp reader. */
  decode?: (bytes: Uint8Array) => Promise<FlatPixels>;
  /** Overrides for tests; the seed (growth.ts storeAudit) otherwise. */
  limits?: Partial<StoreAuditLimits>;
}

type AuditFailure = Extract<StoreAuditOutcome, { ok: false }>;

function fail(reason: AuditFailure["reason"]): AuditFailure {
  return { ok: false, reason, message: storeAuditErrors[reason] };
}

/** Reads the store's product list, or the reason it could not. */
async function readProductList(
  origin: URL,
  fetcher: ImportFetcher,
  limits: StoreAuditLimits,
): Promise<{ ok: true; products: ListedProduct[] } | AuditFailure> {
  let response;
  try {
    response = await fetcher(productListUrl(origin, limits.maxProducts), {
      accept: "application/json",
      maxBytes: limits.productListMaxBytes,
      timeoutMs: limits.productListTimeoutMs,
    });
  } catch (err) {
    const reason = err instanceof ImportFetchError ? err.reason : "network";
    switch (reason) {
      case "invalid_url":
        return fail("invalid_store");
      case "blocked_host":
      case "timeout":
      case "too_large":
        return fail(reason);
      default:
        return fail("unreachable");
    }
  }
  if (response.status === 429) {
    return fail("store_busy");
  }
  if (response.status >= 500) {
    return fail("unreachable");
  }
  if (response.status !== 200) {
    return fail("not_shopify");
  }
  let json: unknown = null;
  try {
    json = JSON.parse(response.body.toString("utf8"));
  } catch {
    json = null;
  }
  // Relative image links resolve against where the list came from, after
  // any redirect to the store's main domain.
  const products = parseProductList(json, response.url, limits.maxProducts);
  if (!products) {
    return fail("not_shopify");
  }
  if (products.length === 0) {
    return fail("no_products");
  }
  return { ok: true, products };
}

/** Downloads and checks one product's first image. Never throws. */
async function checkImage(
  src: string,
  channel: CheckerChannel,
  fetcher: ImportFetcher,
  decode: (bytes: Uint8Array) => Promise<FlatPixels>,
): Promise<StoreAuditProductResult> {
  const read = await importPhoto(src, { fetcher });
  if (!read.ok) {
    return { status: "not_checked", reason: read.reason };
  }
  let pixels: FlatPixels;
  try {
    pixels = await decode(read.photo.body);
  } catch {
    return { status: "not_checked", reason: "not_image" };
  }
  flattenOnWhite(pixels.data);
  const rows = checkRows(
    { width: pixels.naturalWidth, height: pixels.naturalHeight },
    measurePixels(pixels.data, pixels.width, pixels.height),
    channel.rules,
  );
  return {
    status: "checked",
    pass: rows.every((row) => row.pass),
    width: pixels.naturalWidth,
    height: pixels.naturalHeight,
    rows,
  };
}

export function summarize(products: readonly StoreAuditProduct[], thinImageCount: number): StoreAuditSummary {
  let checked = 0;
  let failing = 0;
  let notChecked = 0;
  let thin = 0;
  for (const product of products) {
    if (product.imageCount < thinImageCount) {
      thin += 1;
    }
    if (product.result.status === "checked") {
      checked += 1;
      if (!product.result.pass) {
        failing += 1;
      }
    } else if (product.result.status === "not_checked") {
      notChecked += 1;
    }
  }
  return { listed: products.length, checked, failing, thin, notChecked, thinImageCount };
}

/**
 * Runs one audit of the store at `origin` (already checked by
 * parseStoreAddress) against `channel`. Resolves by the audit deadline,
 * which counts from the start and so covers the product list too; products
 * not finished by then are reported as not checked. A download still in
 * flight at the deadline ends on its own image deadline, its result unused.
 */
export async function runStoreAudit(origin: URL, channel: CheckerChannel, deps: StoreAuditDeps = {}): Promise<StoreAuditOutcome> {
  const limits: StoreAuditLimits = { ...storeAudit, ...deps.limits };
  const baseFetcher = deps.fetcher ?? safeFetch;
  // The photo import asks for its own 15 second deadline; the audit keeps
  // each image to the seeded one.
  const imageFetcher: ImportFetcher = (url, options) =>
    baseFetcher(url, { ...options, timeoutMs: Math.min(options.timeoutMs, limits.imageTimeoutMs) });
  const decode = deps.decode ?? ((bytes: Uint8Array) => flatPixelsOnWhite(bytes));
  const startedAt = Date.now();
  const deadlineAt = startedAt + limits.auditDeadlineMs;

  const list = await readProductList(origin, baseFetcher, limits);
  if (!list.ok) {
    return list;
  }

  // A product with an image keeps "deadline" until a worker finishes it.
  const results = list.products.map(
    (product): StoreAuditProductResult =>
      product.firstImage ? { status: "not_checked", reason: "deadline" } : { status: "no_image" },
  );
  let next = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), Math.max(0, deadlineAt - Date.now()));
  });

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const product = list.products[index];
      if (!product || Date.now() >= deadlineAt) {
        return;
      }
      if (!product.firstImage) {
        continue;
      }
      const outcome = await Promise.race([checkImage(product.firstImage, channel, imageFetcher, decode), deadline]);
      if (outcome === "deadline") {
        return;
      }
      results[index] = outcome;
    }
  };

  try {
    const workers = Array.from({ length: Math.max(1, Math.min(limits.imageConcurrency, list.products.length)) }, worker);
    await Promise.race([Promise.all(workers), deadline]);
  } finally {
    clearTimeout(timer);
  }

  const products: StoreAuditProduct[] = list.products.map((product, index) => ({
    title: product.title,
    url: product.url,
    imageCount: product.imageCount,
    result: results[index] ?? { status: "not_checked", reason: "deadline" },
  }));
  const report: StoreAuditReport = {
    store: origin.hostname,
    channel: { key: channel.key, name: channel.name },
    summary: summarize(products, limits.thinImageCount),
    products,
  };
  return { ok: true, report };
}
