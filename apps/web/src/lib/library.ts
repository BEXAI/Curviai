/**
 * The image gallery (docs/phases/PHASE_16.md workstream 6): every delivered
 * image in a masonry grid at its true aspect ratio, with favorites and
 * filters by channel and shot type. /app/library shows the workspace's
 * images and the job page shows one pack's. Pure and client safe, so the
 * grouping, the filters and the labels are unit tested without a database.
 *
 * Only picked files are shown: an extra scene version the seller has not
 * picked is not in the pack, so it is not in the gallery either. The job
 * page's shot cards are where versions are picked.
 */

import { Shot } from "@curvi/pipeline/schemas";
import { parseVariationShotId } from "@curvi/pipeline/variations";
import { familyName } from "@/lib/preflight/copy";
import type { JobView } from "@/lib/services/types";

/** One image in the gallery: one delivered shot, shown from its first file. */
export interface GalleryItem {
  assetId: string;
  jobId: string;
  shotId: string | null;
  shotType: string;
  productTitle: string;
  /** Every channel spec the shot's picked files went to. */
  channels: string[];
  /** Pixel size of the file shown, for its true aspect ratio; null when
   * the pack did not measure it. */
  width: number | null;
  height: number | null;
  /** Signed preview url, or null when files are not stored. */
  imageUrl: string | null;
  /** Same origin link that downloads the file shown. */
  downloadUrl: string | null;
  favorite: boolean;
  createdAt: string;
}

export interface GalleryFilters {
  /** A channel family, e.g. "amazon". */
  channel: string | null;
  /** A shot type, e.g. "lifestyle". */
  shotType: string | null;
  /** Favorites only. */
  favorites: boolean;
}

export const NO_FILTERS: GalleryFilters = { channel: null, shotType: null, favorites: false };

/** Most images one library page lists. */
export const LIBRARY_PAGE_SIZE = 120;

const FAMILY = /^[a-z0-9_]{1,40}$/;

/** Filters from a query string: anything out of shape is dropped. */
export function parseGalleryFilters(params: Record<string, string | string[] | undefined>): GalleryFilters {
  const one = (key: string): string | null => {
    const value = params[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const channel = one("channel");
  const shotType = one("type");
  return {
    channel: channel && FAMILY.test(channel) ? channel : null,
    shotType: shotType && Shot.shape.type.safeParse(shotType).success ? shotType : null,
    favorites: one("favorites") === "1",
  };
}

/** The query string of filters, empty when none apply. */
export function galleryQuery(filters: GalleryFilters): string {
  const params = new URLSearchParams();
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.shotType) params.set("type", filters.shotType);
  if (filters.favorites) params.set("favorites", "1");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The channel family of a spec id, e.g. "amazon" for "amazon.main". */
export function familyOfSpec(specId: string): string {
  return specId.split(".")[0] ?? specId;
}

/** True when the item passes every filter. */
export function matchesFilters(item: GalleryItem, filters: GalleryFilters): boolean {
  if (filters.favorites && !item.favorite) return false;
  if (filters.shotType && item.shotType !== filters.shotType) return false;
  if (filters.channel && !item.channels.some((specId) => familyOfSpec(specId) === filters.channel)) return false;
  return true;
}

/** The items that pass the filters, in their order. */
export function filterGallery<T extends GalleryItem>(items: readonly T[], filters: GalleryFilters): T[] {
  return items.filter((item) => matchesFilters(item, filters));
}

/** The filter choices the items offer, each with its label, sorted by label. */
export function galleryFacets(items: readonly GalleryItem[]): {
  channels: Array<{ value: string; label: string }>;
  shotTypes: Array<{ value: string; label: string }>;
} {
  const channels = new Set<string>();
  const shotTypes = new Set<string>();
  for (const item of items) {
    for (const specId of item.channels) channels.add(familyOfSpec(specId));
    shotTypes.add(item.shotType);
  }
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  return {
    channels: [...channels].map((value) => ({ value, label: familyName(`${value}.x`) })).sort(byLabel),
    shotTypes: [...shotTypes].map((value) => ({ value, label: shotTypeLabel(value) })).sort(byLabel),
  };
}

const SHOT_TYPE_LABELS: Readonly<Partial<Record<string, string>>> = {
  amazon_main: "Main image",
  alt_angle_white: "Other angle",
  cutout_png: "Transparent PNG",
  sweep_gray: "Studio backdrop",
  sweep_brand: "Brand backdrop",
  lifestyle: "Lifestyle scene",
  infographic: "Infographic",
  dimensions: "Dimensions",
  in_the_box: "In the box",
  comparison: "Comparison",
  aplus_banner: "A plus banner",
  aplus_pain_points: "A plus problems solved",
  aplus_features: "A plus features",
  aplus_ingredients: "A plus materials",
  aplus_results: "A plus results",
  aplus_how_to: "A plus how to use",
  aplus_endorsement: "A plus reviews and awards",
  shopify_hero: "Shopify hero",
  collection_thumb: "Collection thumbnail",
  social_1x1: "Square post",
  social_4x5: "Portrait post",
  social_9x16: "Story",
  social_2x3: "Pinterest pin",
  original_photo: "Your photo",
};

/** A plain name for a shot type; an unknown one reads from its key. */
export function shotTypeLabel(shotType: string): string {
  const base = shotType.split(":")[0];
  const known = SHOT_TYPE_LABELS[base];
  if (known) return known;
  const pretty = base.replaceAll("_", " ").trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** The CSS aspect ratio for an item: its measured size, else a square. */
export function itemAspect(item: Pick<GalleryItem, "width" | "height">): string {
  return item.width && item.height && item.width > 0 && item.height > 0 ? `${item.width} / ${item.height}` : "1 / 1";
}

/** The rows the gallery is built from. */
export interface GalleryAssetRow {
  id: string;
  jobId: string;
  shotType: string;
  qc: Record<string, unknown> | null;
  approved: boolean;
  createdAt: Date;
}

export interface GalleryVariantRow {
  id: string;
  assetId: string;
  channelSpecId: string;
  r2Key: string;
  width: number | null;
  height: number | null;
  picked: boolean;
  createdAt: Date;
}

/**
 * One gallery item per delivered asset with at least one picked file,
 * newest first. The file shown is the asset's first picked file; the
 * channels are all its picked files'. Signing is the caller's: imageUrl and
 * downloadUrl start null and the caller fills them for the items it shows.
 */
export function galleryItemsOf(args: {
  assets: readonly GalleryAssetRow[];
  variants: readonly GalleryVariantRow[];
  productTitleOfJob: ReadonlyMap<string, string>;
  favoriteAssetIds: ReadonlySet<string>;
}): Array<GalleryItem & { r2Key: string; variantId: string }> {
  const byAsset = new Map<string, GalleryVariantRow[]>();
  for (const variant of [...args.variants].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (!variant.picked) continue;
    byAsset.set(variant.assetId, [...(byAsset.get(variant.assetId) ?? []), variant]);
  }
  const items: Array<GalleryItem & { r2Key: string; variantId: string }> = [];
  for (const asset of [...args.assets].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const files = byAsset.get(asset.id);
    if (!asset.approved || !files || files.length === 0) continue;
    const first = files[0];
    items.push({
      assetId: asset.id,
      jobId: asset.jobId,
      shotId: typeof asset.qc?.shotId === "string" ? asset.qc.shotId : null,
      shotType: asset.shotType,
      productTitle: args.productTitleOfJob.get(asset.jobId) ?? "Untitled product",
      channels: [...new Set(files.map((f) => f.channelSpecId))],
      width: first.width,
      height: first.height,
      imageUrl: null,
      downloadUrl: null,
      favorite: args.favoriteAssetIds.has(asset.id),
      createdAt: asset.createdAt.toISOString(),
      r2Key: first.r2Key,
      variantId: first.id,
    });
  }
  return items;
}

/** "Version 2 of this scene" for an extra version's shot id, else null. */
export function versionLabel(shotId: string | null | undefined): string | null {
  const parsed = shotId ? parseVariationShotId(shotId) : null;
  return parsed ? `Version ${parsed.variation} of this scene` : null;
}

/** The job page's gallery: every finished shot with a stored preview whose
 * files ship (an unpicked scene version is left out), in board order. */
export function galleryItemsFromJob(job: Pick<JobView, "id" | "productTitle" | "createdAt" | "shots">): GalleryItem[] {
  return job.shots.flatMap((shot) =>
    shot.status === "done" && shot.imageUrl && shot.assetId && shot.version?.picked !== false
      ? [
          {
            assetId: shot.assetId,
            jobId: job.id,
            shotId: shot.shotId,
            shotType: shot.shotType,
            productTitle: job.productTitle,
            channels: [...shot.channels],
            width: shot.width ?? null,
            height: shot.height ?? null,
            imageUrl: shot.imageUrl,
            downloadUrl: shot.downloadUrl ?? null,
            favorite: shot.favorite === true,
            createdAt: job.createdAt,
          },
        ]
      : [],
  );
}
