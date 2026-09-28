/**
 * Builds the worker payload for a pack job. Pure so it is unit testable: the
 * db service feeds it rows and it returns the GeneratePackInput the
 * generate-pack task and the inline runner both consume.
 */

import type { GeneratePackInput } from "@curvi/trigger/runner";
import { socialBadgeByTier, type TierKey } from "@curvi/pipeline/seed";

export interface PayloadProduct {
  id: string;
  title: string | null;
  mode: "listing" | "concept";
  amazonSku: string | null;
}

export interface PayloadMedia {
  /** Object key in the private bucket; the worker's media loader reads it. */
  r2Key: string;
  kind: "image" | "video" | "frame" | null;
}

export function seoSlugFor(title: string | null): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "product";
}

export function buildGeneratePackInput(args: {
  jobId: string;
  workspaceId: string;
  tier: TierKey;
  channels: string[];
  mode: "listing" | "concept";
  creditBudget: number;
  product: PayloadProduct;
  media: PayloadMedia[];
  userDescription?: string;
  /** Brand kit colors; only valid #RRGGBB values pass through. */
  brandColors?: string[] | null;
}): GeneratePackInput {
  return {
    jobId: args.jobId,
    workspaceId: args.workspaceId,
    tier: args.tier,
    mode: args.mode,
    channels: args.channels,
    creditBudget: args.creditBudget,
    images: args.media
      .filter((m) => m.kind !== "video")
      .map((m) => ({ mediaId: m.r2Key })),
    userDescription: args.userDescription,
    brandColors: (Array.isArray(args.brandColors) ? args.brandColors : [])
      .filter((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c))
      .slice(0, 6),
    sku: args.product.amazonSku ?? undefined,
    seoSlug: seoSlugFor(args.product.title),
    hasVideoSource: args.media.some((m) => m.kind === "video"),
    // The "Made with Curvi" badge on social exports, by plan (seed).
    socialBadge: socialBadgeByTier[args.tier] ?? false,
  };
}
