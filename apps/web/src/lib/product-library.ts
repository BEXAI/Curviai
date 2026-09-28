/**
 * Plain copy for the products library (/app/products): which channels a pack
 * covered, what it cost and when it ran. Pure, so the page and its tests
 * share it.
 */

import { channelName, familyOf } from "@/lib/marketing-facts";
import type { JobStatus, ProductPackView } from "@/lib/services/types";

/** Pack states that still hold credits instead of having settled. */
const RUNNING: ReadonlySet<JobStatus> = new Set(["queued", "analyzing", "planning", "generating", "qc", "packaging"]);

function credits(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "credit" : "credits"}`;
}

/** "Amazon, Shopify, Meta" for the specs a pack picked, in pick order. */
export function packChannelsLine(channels: readonly string[]): string {
  const names: string[] = [];
  for (const channel of channels) {
    const family = familyOf(channel);
    const name = channelName(family);
    const label = name === family ? family.charAt(0).toUpperCase() + family.slice(1) : name;
    if (!names.includes(label)) {
      names.push(label);
    }
  }
  return names.length > 0 ? names.join(", ") : "No channels";
}

/** What a pack cost: the hold while it runs, the charge once it settled. */
export function packCreditsLine(pack: Pick<ProductPackView, "status" | "creditsReserved" | "creditsCharged">): string {
  if (RUNNING.has(pack.status)) {
    return `${credits(pack.creditsReserved)} held`;
  }
  if (pack.creditsCharged <= 0) {
    return "Nothing charged";
  }
  return `${credits(pack.creditsCharged)} charged`;
}

/** "Sep 28, 2026", the same on the server and in every time zone. */
export function packDateLine(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "3 photos, SKU MUG-12" under a product's name. */
export function productFactsLine(product: { photoCount: number; sku: string | null }): string {
  const parts = [`${product.photoCount} ${product.photoCount === 1 ? "photo" : "photos"}`];
  if (product.sku) {
    parts.push(`SKU ${product.sku}`);
  }
  return parts.join(", ");
}

/** Link that opens the new pack form with this product picked. */
export function newPackHref(productId: string): string {
  return `/app/new?product=${encodeURIComponent(productId)}`;
}
