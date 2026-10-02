/**
 * Pure parts of the store image audit (P18-18): reading the address a
 * visitor typed, and reading a Shopify store's public product list. The
 * list's shape (GET https://{store}/products.json?limit=N answers
 * { products: [{ title, handle, images: [{ src, position, width, height }] }] })
 * is recorded in docs/verification.md; Shopify does not document it.
 */

import { z } from "zod";
import { storeAuditErrors } from "@/components/marketing/search-copy";
import { absoluteHttpsUrl, clip, htmlToText } from "@/lib/url-import/html";
import { isAmazonHost } from "@/lib/url-import/product-url";
import { ImportFetchError, checkFetchUrl } from "@/lib/url-import/safe-fetch";
import { IMPORT_TITLE_MAX } from "@/lib/url-import/types";

export type StoreAddressResult =
  | { ok: true; origin: URL }
  | { ok: false; reason: "invalid_store" | "blocked_host" | "amazon"; message: string };

/** Longest address the form accepts. */
export const STORE_ADDRESS_MAX = 2048;

/**
 * The store's https origin from what a visitor typed: "yourstore.com",
 * "https://yourstore.com/collections/all" or a product link all give
 * https://yourstore.com. A plain http:// address is read as https, since
 * stores serve https. The origin passes the same checks the fetch applies
 * (checkFetchUrl: https, default port, no credentials, no IP literal, a
 * public looking name); Amazon is refused because it blocks fetches.
 */
export function parseStoreAddress(raw: string): StoreAddressResult {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > STORE_ADDRESS_MAX) {
    return { ok: false, reason: "invalid_store", message: storeAuditErrors.invalid_store };
  }
  const upgraded = trimmed.replace(/^http:\/\//i, "https://");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(upgraded) ? upgraded : `https://${upgraded}`;
  let url: URL;
  try {
    url = checkFetchUrl(withScheme);
  } catch (err) {
    if (err instanceof ImportFetchError && err.reason === "blocked_host") {
      return { ok: false, reason: "blocked_host", message: storeAuditErrors.blocked_host };
    }
    return { ok: false, reason: "invalid_store", message: storeAuditErrors.invalid_store };
  }
  if (isAmazonHost(url.hostname)) {
    return { ok: false, reason: "amazon", message: storeAuditErrors.amazon };
  }
  return { ok: true, origin: new URL(url.origin) };
}

/** The store's public product list, limited to the first `limit` products. */
export function productListUrl(origin: URL, limit: number): URL {
  const url = new URL("/products.json", origin);
  url.searchParams.set("limit", String(limit));
  return url;
}

export interface ListedProduct {
  title: string;
  /** The product page, https. */
  url: string;
  /** The first image by position, absolute https, or null when there is none. */
  firstImage: string | null;
  imageCount: number;
}

const ProductList = z.object({ products: z.array(z.unknown()) });

const ListedProductJson = z.object({
  title: z.string(),
  handle: z.string().min(1).max(255),
  images: z.array(z.unknown()).nullish(),
});

const ListedImageJson = z.object({
  src: z.string().min(1).max(2048),
  position: z.number().nullish(),
});

/**
 * Reads the product list. Null when the body is not that shape (not a
 * Shopify store, or its list is switched off or behind a password page).
 * Entries that are not products are skipped; at most `limit` are kept.
 */
export function parseProductList(json: unknown, base: URL, limit: number): ListedProduct[] | null {
  const list = ProductList.safeParse(json);
  if (!list.success) {
    return null;
  }
  const products: ListedProduct[] = [];
  for (const entry of list.data.products) {
    if (products.length >= limit) {
      break;
    }
    const parsed = ListedProductJson.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    const images = (parsed.data.images ?? [])
      .map((image) => ListedImageJson.safeParse(image))
      .filter((result) => result.success)
      .map((result) => result.data)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((image) => absoluteHttpsUrl(image.src, base))
      .filter((url): url is string => url !== null);
    const title = clip(htmlToText(parsed.data.title).replace(/\s+/g, " ").trim(), IMPORT_TITLE_MAX);
    products.push({
      title: title || parsed.data.handle,
      url: new URL(`/products/${encodeURIComponent(parsed.data.handle)}`, base.origin).toString(),
      firstImage: images[0] ?? null,
      imageCount: images.length,
    });
  }
  return products;
}
