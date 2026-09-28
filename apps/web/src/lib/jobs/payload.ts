/**
 * Builds the worker payload for a pack job. Pure so it is unit testable: the
 * db service feeds it rows and it returns the GeneratePackInput the
 * generate-pack task and the inline runner both consume.
 */

import type { BrandStyle, GeneratePackInput } from "@curvi/trigger/runner";
import { isTemplateFontKey, presets, socialBadgeByTier, type TierKey } from "@curvi/pipeline/seed";
import { isAngleRole, printableSellerLines } from "@curvi/pipeline/seller-inputs";

export interface PayloadProduct {
  id: string;
  title: string | null;
  mode: "listing" | "concept";
  amazonSku: string | null;
  /** The seller's own SKU; wins over amazonSku for file names. */
  sku?: string | null;
  boxContents?: string[] | null;
  comparisonFacts?: string[] | null;
}

export interface PayloadMedia {
  /** Object key in the private bucket; the worker's media loader reads it. */
  r2Key: string;
  kind: "image" | "video" | "frame" | null;
  /** The role the seller gave the photo, when they gave one. */
  angle?: string | null;
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

/** The brand kit row fields a pack uses beyond colors. */
export interface PayloadBrandKit {
  fonts: Record<string, string> | null;
  logoKey: string | null;
  stylePreset: string | null;
}

/**
 * The brand style the worker receives: only catalog font keys, a logo key
 * inside this workspace's prefix (the worker checks it again before
 * loading), and a seeded preset key. Anything else is dropped, so a legacy
 * or tampered row falls back to the defaults. Null when nothing is left.
 */
export function brandStyleFor(workspaceId: string, kit: PayloadBrandKit | null | undefined): BrandStyle | null {
  if (!kit) {
    return null;
  }
  const heading = isTemplateFontKey(kit.fonts?.heading) ? kit.fonts.heading : null;
  const body = isTemplateFontKey(kit.fonts?.body) ? kit.fonts.body : null;
  const logoKey =
    typeof kit.logoKey === "string" && kit.logoKey.startsWith(`ws/${workspaceId}/`) && !kit.logoKey.includes("..")
      ? kit.logoKey
      : null;
  const stylePreset = kit.stylePreset && Object.hasOwn(presets, kit.stylePreset) ? kit.stylePreset : null;
  if (!heading && !body && !logoKey && !stylePreset) {
    return null;
  }
  return {
    ...(heading || body ? { fonts: { heading, body } } : {}),
    ...(logoKey ? { logoKey } : {}),
    ...(stylePreset ? { stylePreset } : {}),
  };
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
  /** Brand kit fonts, logo and style preset; see brandStyleFor. */
  brandKit?: PayloadBrandKit | null;
}): GeneratePackInput {
  const brand = brandStyleFor(args.workspaceId, args.brandKit);
  return {
    jobId: args.jobId,
    workspaceId: args.workspaceId,
    tier: args.tier,
    mode: args.mode,
    channels: args.channels,
    creditBudget: args.creditBudget,
    // The seller's front photo goes first: the worker treats the first photo
    // as the primary one, and the analyzer looks at the first few.
    images: args.media
      .filter((m) => m.kind !== "video")
      .map((m) => (isAngleRole(m.angle) ? { mediaId: m.r2Key, angle: m.angle } : { mediaId: m.r2Key }))
      .sort((a, b) => Number(b.angle === "front") - Number(a.angle === "front")),
    userDescription: args.userDescription,
    brandColors: (Array.isArray(args.brandColors) ? args.brandColors : [])
      .filter((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c))
      .slice(0, 6),
    sku: args.product.sku || args.product.amazonSku || undefined,
    seoSlug: seoSlugFor(args.product.title),
    hasVideoSource: args.media.some((m) => m.kind === "video"),
    boxContents: printableSellerLines(args.product.boxContents),
    comparisonFacts: printableSellerLines(args.product.comparisonFacts),
    // The "Made with Curvi" badge on social exports, by plan (seed).
    socialBadge: socialBadgeByTier[args.tier] ?? false,
    ...(brand ? { brand } : {}),
  };
}
