/**
 * Pure parsers for the three page shapes an import can meet: the Shopify
 * product JSON (GET /products/<handle>.json), an Amazon product page, and
 * any other page's Open Graph tags. The shapes they rely on are recorded in
 * docs/verification.md (checked 2026-09-28). Every image URL they return is
 * absolute https; the photo itself is fetched later through safeFetch.
 */

import { z } from "zod";
import {
  absoluteHttpsUrl,
  asciiLower,
  attribute,
  clip,
  elementInner,
  htmlToText,
  listItems,
  metaContent,
  tagWithId,
} from "./html";
import { IMPORT_TITLE_MAX, type ImportedImage } from "./types";

/** Most photos offered to pick from. */
export const MAX_IMPORT_IMAGES = 12;

/** Longest description kept from any page. */
const DESCRIPTION_MAX = 5000;
/** Most bullet points kept. */
const BULLETS_MAX = 12;

export interface ParsedProduct {
  title: string;
  description: string;
  bullets: string[];
  images: ImportedImage[];
}

function addImage(images: ImportedImage[], seen: Set<string>, raw: string | null | undefined, base: URL, extra: Omit<ImportedImage, "url"> = {}) {
  if (!raw || images.length >= MAX_IMPORT_IMAGES) {
    return;
  }
  const url = absoluteHttpsUrl(raw, base);
  if (!url || seen.has(url)) {
    return;
  }
  seen.add(url);
  images.push({ url, ...extra });
}

function cleanTitle(text: string): string {
  return clip(text.replace(/\s+/g, " ").trim(), IMPORT_TITLE_MAX);
}

// ---------------------------------------------------------------- Shopify

const ShopifyImage = z.object({
  src: z.string().min(1),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  alt: z.string().nullish(),
  position: z.number().nullish(),
});

const ShopifyProductJson = z.object({
  product: z.object({
    title: z.string(),
    body_html: z.string().nullish(),
    images: z.array(z.unknown()).nullish(),
    image: z.unknown().nullish(),
  }),
});

/** Reads the Shopify product JSON. Null when the body is not that shape. */
export function parseShopifyProduct(json: unknown, base: URL): ParsedProduct | null {
  const parsed = ShopifyProductJson.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const product = parsed.data.product;
  const body = (product.body_html ?? "").slice(0, 200_000);
  const images: ImportedImage[] = [];
  const seen = new Set<string>();
  const candidates = [...(product.images ?? []), product.image]
    .map((entry) => ShopifyImage.safeParse(entry))
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const image of candidates) {
    addImage(images, seen, image.src, base, {
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {}),
      ...(image.alt ? { alt: clip(image.alt, 200) } : {}),
    });
  }
  return {
    title: cleanTitle(htmlToText(product.title)),
    description: clip(htmlToText(body), DESCRIPTION_MAX),
    bullets: listItems(body).slice(0, BULLETS_MAX).map((b) => clip(b, 500)),
    images,
  };
}

// ----------------------------------------------------------------- Amazon

/** True when Amazon answered with its robot check instead of the page. */
export function isAmazonBlockPage(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) {
    return true;
  }
  const head = asciiLower(html.slice(0, 200_000));
  return (
    head.includes("/errors/validatecaptcha") ||
    head.includes("enter the characters you see below") ||
    head.includes("api-services-support@amazon.com")
  );
}

/** The main photo list from the page's colorImages 'initial' block: hiRes
 * per photo, or large when hiRes is null. */
function amazonGalleryUrls(html: string): string[] {
  const start = html.indexOf("'colorImages'");
  if (start < 0) {
    return [];
  }
  const block = html.slice(start, start + 60_000);
  const initialAt = block.indexOf("'initial'");
  if (initialAt < 0) {
    return [];
  }
  const segment = block.slice(initialAt);
  // Each photo's "main" size map holds arrays such as [355,355], so the
  // list ends at the first "}]", where the last photo object closes it.
  const end = segment.indexOf("}]");
  const list = end < 0 ? segment : segment.slice(0, end);
  const urls: string[] = [];
  let pendingHiRes: string | null | undefined;
  for (const match of list.matchAll(/"(hiRes|large)":(?:null|"([^"]{1,2048})")/g)) {
    if (match[1] === "hiRes") {
      if (pendingHiRes) {
        urls.push(pendingHiRes);
      }
      pendingHiRes = match[2] ?? null;
      continue;
    }
    // "large" closes the current photo: hiRes wins when present.
    const chosen = pendingHiRes ?? match[2];
    if (chosen) {
      urls.push(chosen);
    }
    pendingHiRes = undefined;
  }
  if (pendingHiRes) {
    urls.push(pendingHiRes);
  }
  return urls;
}

/** The biggest entry in the landing image's data-a-dynamic-image map. */
function largestDynamicImage(json: string | null): string | null {
  if (!json) {
    return null;
  }
  try {
    const map = z.record(z.string(), z.tuple([z.number(), z.number()])).parse(JSON.parse(json));
    let best: string | null = null;
    let bestArea = -1;
    for (const [url, [w, h]] of Object.entries(map)) {
      if (w * h > bestArea) {
        best = url;
        bestArea = w * h;
      }
    }
    return best;
  } catch {
    return null;
  }
}

export function parseAmazonPage(html: string, base: URL): ParsedProduct {
  const titleTag = tagWithId(html, "productTitle");
  let title = titleTag ? htmlToText(elementInner(html, titleTag, 4000)) : "";
  if (!title) {
    title = (metaContent(html, "og:title") ?? metaContent(html, "title") ?? "").replace(/^amazon\.[a-z.]+\s*:\s*/i, "");
  }

  const bulletsTag = tagWithId(html, "feature-bullets");
  const bullets = bulletsTag
    ? listItems(elementInner(html, bulletsTag, 40_000, "ul"))
        .filter((b) => !/make sure this fits/i.test(b))
        .slice(0, BULLETS_MAX)
        .map((b) => clip(b, 500))
    : [];

  const descriptionTag = tagWithId(html, "productDescription");
  const description = descriptionTag
    ? clip(htmlToText(elementInner(html, descriptionTag, 40_000, "div")), DESCRIPTION_MAX)
    : "";

  const images: ImportedImage[] = [];
  const seen = new Set<string>();
  for (const url of amazonGalleryUrls(html)) {
    addImage(images, seen, url, base);
  }
  const landing = tagWithId(html, "landingImage");
  if (landing) {
    addImage(images, seen, attribute(landing.source, "data-old-hires"), base);
    addImage(images, seen, largestDynamicImage(attribute(landing.source, "data-a-dynamic-image")), base);
  }
  addImage(images, seen, metaContent(html, "og:image"), base);

  return { title: cleanTitle(title), description, bullets, images };
}

// ------------------------------------------------------------ Open Graph

/** Title, description and image from a page's Open Graph tags, the
 * fallback when a /products/ link is not a Shopify store after all. */
export function parseOpenGraph(html: string, base: URL): ParsedProduct {
  const head = html.slice(0, 1_000_000);
  const images: ImportedImage[] = [];
  const seen = new Set<string>();
  addImage(images, seen, metaContent(head, "og:image:secure_url"), base);
  addImage(images, seen, metaContent(head, "og:image"), base);
  addImage(images, seen, metaContent(head, "twitter:image"), base);
  const title = metaContent(head, "og:title") ?? metaContent(head, "twitter:title") ?? "";
  const description = metaContent(head, "og:description") ?? metaContent(head, "description") ?? "";
  return {
    title: cleanTitle(htmlToText(title)),
    description: clip(htmlToText(description), DESCRIPTION_MAX),
    bullets: [],
    images,
  };
}
