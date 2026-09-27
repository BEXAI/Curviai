import { listSpecs, type ChannelSpec } from "@curvi/specs";

/** Turn a channel spec id like "amazon.main" into a URL slug like "amazon-main". */
export function specSlug(id: string): string {
  return id.replace(/[._]/g, "-");
}

/** Find the spec whose slugified id matches the given slug, if any. */
export function specForSlug(slug: string): ChannelSpec | undefined {
  return listSpecs().find((spec) => specSlug(spec.id) === slug);
}

/** Specs that describe still images, which is what the SEO pages and resizer cover. */
export function imageSpecs(): ChannelSpec[] {
  return listSpecs().filter((spec) => !spec.id.startsWith("video."));
}

/** Human readable channel name from a spec id, for headings and links. */
export function specDisplayName(id: string): string {
  const names: Record<string, string> = {
    "amazon.main": "Amazon main image",
    "amazon.secondary": "Amazon secondary images",
    "amazon.aplus.basic_header": "Amazon A plus basic header",
    "amazon.aplus.premium_full": "Amazon A plus premium module",
    "shopify.product": "Shopify product image",
    "shopify.hero_banner": "Shopify hero banner",
    "google.merchant.main": "Google Merchant main image",
    "google.merchant.lifestyle": "Google Merchant lifestyle image",
    "etsy.listing": "Etsy listing image",
    "ebay.listing": "eBay listing image",
    "walmart.main": "Walmart main image",
    "tiktokshop.main": "TikTok Shop main image",
    "meta.feed_1x1": "Meta feed square",
    "meta.feed_4x5": "Meta feed portrait",
    "meta.story_9x16": "Meta story",
    "pinterest.pin": "Pinterest pin",
    "video.amazon_listing": "Amazon listing video",
    "video.social_9x16": "Social vertical video",
  };
  return names[id] ?? id;
}
