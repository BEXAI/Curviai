/**
 * Share pages in the sitemap (docs/phases/PHASE_18.md P18-14): only pages
 * their owners listed in the public gallery, the same ones the share page
 * lets search engines index, never a page shared by link only and never a
 * drawn demo illustration. Reread at most every shareLoop.sitemapRefreshSeconds
 * per process; a failed read lists none and is not kept. Server only.
 */

import type { MetadataRoute } from "next";
import { shareLoop } from "@curvi/pipeline/seed";
import { isIllustrationSrc } from "@/components/marketing/demo-images";
import type { GalleryEntry } from "./types";

type Cache = { at: number; entries: MetadataRoute.Sitemap };
const scope = globalThis as typeof globalThis & { __curviShareSitemap?: Cache };

/** The sitemap rows of gallery listed, real share pages. Pure. */
export function shareSitemapRows(baseUrl: string, entries: readonly GalleryEntry[]): MetadataRoute.Sitemap {
  return entries
    .filter((entry) => !isIllustrationSrc(entry.after.src) && !(entry.before && isIllustrationSrc(entry.before.src)))
    .slice(0, shareLoop.sitemapMaxShares)
    .map((entry) => ({ url: `${baseUrl}/s/${entry.slug}`, changeFrequency: "monthly", priority: 0.5 }));
}

/**
 * The share rows, cached per process. listGallery is the share store's own
 * gallery listing, so a page taken down leaves the sitemap within the
 * refresh window.
 */
export async function gallerySitemapRows(
  baseUrl: string,
  listGallery: (limit: number) => Promise<GalleryEntry[]>,
  now: number = Date.now(),
): Promise<MetadataRoute.Sitemap> {
  const cached = scope.__curviShareSitemap;
  if (cached && now - cached.at < shareLoop.sitemapRefreshSeconds * 1000) {
    return cached.entries;
  }
  try {
    const entries = shareSitemapRows(baseUrl, await listGallery(shareLoop.sitemapMaxShares));
    scope.__curviShareSitemap = { at: now, entries };
    return entries;
  } catch (err) {
    console.error("[sitemap] could not list gallery shares", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Approval and takedown changes invalidate the process-local sitemap. */
export function clearShareSitemapCache(): void {
  scope.__curviShareSitemap = undefined;
}

export const resetShareSitemapCacheForTests = clearShareSitemapCache;
