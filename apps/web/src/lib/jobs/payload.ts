/**
 * Builds the worker payload for a pack job. Pure so it is unit testable: the
 * db service feeds it rows and it returns the GeneratePackInput the
 * generate-pack task and the inline runner both consume.
 */

import type { BrandStyle, GeneratePackInput } from "@curvi/trigger/runner";
import type { PreflightIntake } from "@curvi/trigger/preflight-intake";
import { isTemplateFontKey, presets, socialBadgeByTier, type TierKey } from "@curvi/pipeline/seed";
import { isAngleRole, printableSellerLines } from "@curvi/pipeline/seller-inputs";
import { ResolvedOutputOptions } from "@curvi/pipeline/output-options";

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
  /** The product the seller tapped in the chooser (source_media.target_box). */
  targetBox?: { x: number; y: number; width: number; height: number } | null;
  /** The preflight's intake answer, for the runner to reuse when fresh. */
  preflight?: PreflightIntake;
  /** The product box the preflight found (upload_preflights.result
   * productBox), for the P1 crop fit; targetBox wins over it. */
  productBox?: { x: number; y: number; width: number; height: number } | null;
  /** Stored upright pixel size (source_media width and height, from the
   * ingest check), so the runner sizes kept photos without a decode. */
  width?: number | null;
  height?: number | null;
  /** The stored copy was decoded and written again at upload
   * (source_media.ingest); unknown for uploads before PHASE_15. */
  reencoded?: boolean | null;
}

/** PHASE_15 worker payload: each photo carries its stored size and re-encode
 * flag, and the job carries its resolved output options. The runner's own
 * GeneratePackInput defines these fields, so the payload is that type. */
export type PayloadImage = GeneratePackInput["images"][number];

export type GeneratePackPayload = GeneratePackInput;

/** A positive whole pixel count, or undefined. */
function pixels(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The stored output options for a worker payload, parsed again with the
 * shared schema (PHASE_15 item 27). Null or undefined means no options
 * (today's pack); a value the schema refuses throws, so a pack never runs on
 * options nobody can read.
 */
export function payloadOutputOf(stored: unknown): ResolvedOutputOptions | undefined {
  if (stored === null || stored === undefined) {
    return undefined;
  }
  return ResolvedOutputOptions.parse(stored);
}

/** A box the runner can use: every side inside the photo. */
function validBox(
  box: PayloadMedia["targetBox"] | PayloadMedia["productBox"],
): box is NonNullable<PayloadMedia["targetBox"]> {
  return (
    !!box &&
    [box.x, box.y, box.width, box.height].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1.0001 &&
    box.y + box.height <= 1.0001
  );
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
  /** generation_jobs.output_options as stored; see payloadOutputOf. */
  outputOptions?: unknown;
}): GeneratePackPayload {
  const brand = brandStyleFor(args.workspaceId, args.brandKit);
  const output = payloadOutputOf(args.outputOptions);
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
      .map((m): PayloadImage => {
        const width = pixels(m.width);
        const height = pixels(m.height);
        return {
          mediaId: m.r2Key,
          ...(isAngleRole(m.angle) ? { angle: m.angle } : {}),
          ...(validBox(m.targetBox) ? { targetBox: m.targetBox } : {}),
          ...(m.preflight ? { preflight: m.preflight } : {}),
          ...(validBox(m.productBox) ? { productBox: m.productBox } : {}),
          ...(width !== undefined && height !== undefined ? { width, height } : {}),
          ...(typeof m.reencoded === "boolean" ? { reencoded: m.reencoded } : {}),
        };
      })
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
    ...(output ? { output } : {}),
  };
}
