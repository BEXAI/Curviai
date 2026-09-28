/**
 * Reads a pasted product link and decides how to import it. Amazon is known
 * by its storefront hosts and needs an ASIN in the path. Anything else with
 * /products/<handle> in the path is treated as a Shopify store, since
 * Shopify stores often sit on the seller's own domain. The link must pass
 * the same checks the fetch applies (checkFetchUrl) before anything else.
 */

import { ImportFetchError, checkFetchUrl } from "./safe-fetch";

export type ProductUrlTarget =
  | { platform: "amazon"; pageUrl: URL; asin: string; slugTitle: string | null }
  | { platform: "shopify"; pageUrl: URL; jsonUrl: URL; handle: string };

export type ProductUrlParse =
  | { ok: true; target: ProductUrlTarget }
  | { ok: false; reason: "invalid_url" | "blocked_host" | "unsupported"; message: string };

const AMAZON_HOST =
  /^(?:www\.|smile\.)?amazon\.(?:com|ca|com\.mx|com\.br|co\.uk|de|fr|it|es|nl|se|pl|com\.be|com\.tr|ae|sa|eg|in|co\.jp|com\.au|sg)$/;

const ASIN_PATH = /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})(?=[/?#]|$)/i;

const SHOPIFY_HANDLE_PATH = /(?:^|\/)products\/([^/?#]+)/;

export const MESSAGES = {
  invalid_url: "Paste the full product link, starting with https.",
  blocked_host: "That link does not point to a public store page. Paste the link to your product page.",
  unsupported:
    "Paste a link to a product on a Shopify store or on Amazon. Shopify links have /products/ in them and Amazon links have /dp/.",
  amazon_no_asin: "That Amazon link does not point to one product. Open the product page and copy its link.",
} as const;

export function isAmazonHost(hostname: string): boolean {
  return AMAZON_HOST.test(hostname.toLowerCase().replace(/\.$/, ""));
}

/** "Echo-Dot-3rd-Gen" from /Echo-Dot-3rd-Gen/dp/B07FZ8S74R reads as a name
 * when Amazon will not show us the page. */
export function amazonSlugTitle(pathname: string): string | null {
  const match = /^\/([^/]+)\/(?:dp|gp\/product)\//i.exec(pathname);
  if (!match?.[1]) {
    return null;
  }
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const title = slug.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
  return title.length >= 3 && /[a-z]/i.test(title) ? title : null;
}

export function parseProductUrl(raw: string): ProductUrlParse {
  const trimmed = raw.trim();
  // A link pasted without a scheme (www.amazon.com/dp/...) is read as
  // https; an explicit http:// is refused by checkFetchUrl.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = checkFetchUrl(withScheme);
  } catch (err) {
    const reason = err instanceof ImportFetchError && err.reason === "blocked_host" ? "blocked_host" : "invalid_url";
    return { ok: false, reason, message: MESSAGES[reason] };
  }

  if (isAmazonHost(url.hostname)) {
    const asin = ASIN_PATH.exec(url.pathname)?.[1]?.toUpperCase();
    if (!asin) {
      return { ok: false, reason: "unsupported", message: MESSAGES.amazon_no_asin };
    }
    // The bare /dp/ASIN page drops tracking parameters and variant noise.
    const pageUrl = new URL(`https://${url.hostname}/dp/${asin}`);
    return { ok: true, target: { platform: "amazon", pageUrl, asin, slugTitle: amazonSlugTitle(url.pathname) } };
  }

  const rawHandle = SHOPIFY_HANDLE_PATH.exec(url.pathname)?.[1];
  if (!rawHandle) {
    return { ok: false, reason: "unsupported", message: MESSAGES.unsupported };
  }
  let handle: string;
  try {
    handle = decodeURIComponent(rawHandle).replace(/\.(?:json|js|oembed|xml)$/i, "");
  } catch {
    return { ok: false, reason: "unsupported", message: MESSAGES.unsupported };
  }
  if (!handle || handle.length > 255 || handle.startsWith(".")) {
    return { ok: false, reason: "unsupported", message: MESSAGES.unsupported };
  }
  const encoded = encodeURIComponent(handle);
  const pageUrl = new URL(`/products/${encoded}`, url.origin);
  const jsonUrl = new URL(`/products/${encoded}.json`, url.origin);
  return { ok: true, target: { platform: "shopify", pageUrl, jsonUrl, handle } };
}
