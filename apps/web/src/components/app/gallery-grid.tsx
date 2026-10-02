"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { cn } from "@curvi/ui";
import {
  NO_FILTERS,
  filterGallery,
  galleryFacets,
  galleryQuery,
  itemAspect,
  shotTypeLabel,
  type GalleryFilters,
  type GalleryItem,
} from "@/lib/library";
import { channelName } from "@/lib/output-options-copy";
import { isTransparentShot } from "@/lib/output-preview";
import { FAVORITE_COPY } from "@/lib/variation-picks";
import { CHECKERBOARD } from "./output-preview";

type Facets = ReturnType<typeof galleryFacets>;

interface GalleryGridProps {
  items: GalleryItem[];
  /** Filter choices. Defaults to the ones the items offer. */
  facets?: Facets;
  /** The filters in effect. */
  filters?: GalleryFilters;
  /** With a base path, the filters are links (the server filters the
   * items, as on /app/library); without one they filter on the page. */
  basePath?: string;
  /** Owners, admins and editors may change favorites. */
  canFavorite: boolean;
  /** Show each image's product name (the library mixes products). */
  showProduct?: boolean;
  emptyText: string;
  testId?: string;
}

/**
 * The image gallery (docs/phases/PHASE_16.md workstream 6): a masonry grid
 * in columns, each image in a box at its own measured aspect ratio, so a
 * tall story and a wide banner both show whole. Filters by channel and shot
 * type, and favorites.
 */
export function GalleryGrid({
  items,
  facets,
  filters = NO_FILTERS,
  basePath,
  canFavorite,
  showProduct = false,
  emptyText,
  testId = "gallery-grid",
}: GalleryGridProps) {
  const [local, setLocal] = useState<GalleryFilters>(filters);
  // Favorite taps on this page, by asset id, over what the server said.
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const current = basePath ? filters : local;
  const withFavorites = useMemo(
    () => items.map((item) => (item.assetId in favorites ? { ...item, favorite: favorites[item.assetId] } : item)),
    [items, favorites],
  );
  const shown = basePath ? withFavorites : filterGallery(withFavorites, current);
  const choices = facets ?? galleryFacets(items);

  const chip = (label: string, next: GalleryFilters, active: boolean, key: string) => {
    const className = cn(
      "inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-medium transition-colors",
      active ? "border-ink-900 bg-ink-900 text-white" : "border-ink-200 bg-white text-ink-700 hover:border-ink-400",
    );
    return basePath ? (
      <Link key={key} href={`${basePath}${galleryQuery(next)}`} className={className} aria-current={active ? "true" : undefined}>
        {label}
      </Link>
    ) : (
      <button key={key} type="button" className={className} aria-pressed={active} onClick={() => setLocal(next)}>
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter images">
        {chip("All channels", { ...current, channel: null }, current.channel === null, "channel-all")}
        {choices.channels.map((c) =>
          chip(c.label, { ...current, channel: c.value }, current.channel === c.value, `channel-${c.value}`),
        )}
        <span className="mx-1 h-5 w-px bg-ink-200" aria-hidden="true" />
        {chip("All images", { ...current, shotType: null }, current.shotType === null, "type-all")}
        {choices.shotTypes.map((t) =>
          chip(t.label, { ...current, shotType: t.value }, current.shotType === t.value, `type-${t.value}`),
        )}
        <span className="mx-1 h-5 w-px bg-ink-200" aria-hidden="true" />
        {chip("Favorites", { ...current, favorites: !current.favorites }, current.favorites, "favorites")}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-ink-200 px-4 py-8 text-center text-sm text-ink-500" data-testid="gallery-empty">
          {emptyText}
        </p>
      ) : (
        <ul className="columns-2 gap-4 sm:columns-3 lg:columns-4" aria-label="Images">
          {shown.map((item) => (
            <li
              key={item.assetId}
              className="mb-4 break-inside-avoid"
              data-testid="gallery-item"
              data-shot-type={item.shotType}
              data-favorite={item.favorite ? "true" : "false"}
            >
              <figure className="overflow-hidden rounded-lg border border-ink-200 bg-white">
                {/* A transparent PNG gets the job board's checkerboard, so a
                    dark cutout never vanishes into the dark surface. */}
                <div
                  className="flex items-center justify-center bg-ink-50"
                  style={{ aspectRatio: itemAspect(item) }}
                  data-transparent={isTransparentShot(item.shotType) ? "true" : undefined}
                >
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={`${shotTypeLabel(item.shotType)} of ${item.productTitle}`}
                      className={cn(
                        "block max-h-full max-w-full object-contain",
                        isTransparentShot(item.shotType) && CHECKERBOARD,
                      )}
                      loading="lazy"
                    />
                  ) : null}
                </div>
                <figcaption className="space-y-1 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-ink-900">{shotTypeLabel(item.shotType)}</p>
                    {canFavorite ? (
                      <FavoriteButton
                        assetId={item.assetId}
                        favorite={item.favorite}
                        onChange={(on) => setFavorites((prev) => ({ ...prev, [item.assetId]: on }))}
                      />
                    ) : null}
                  </div>
                  {showProduct ? (
                    <Link href={`/app/jobs/${item.jobId}`} className="block text-xs text-ink-600 hover:text-ink-900">
                      {item.productTitle}
                    </Link>
                  ) : null}
                  <p className="text-xs text-ink-500">{item.channels.map(channelName).join(", ")}</p>
                  {item.downloadUrl ? (
                    <a href={item.downloadUrl} className="inline-block text-xs font-medium text-accent-600 hover:text-accent-700">
                      Download
                    </a>
                  ) : null}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A star that adds the image to the favorites, or takes it out. */
export function FavoriteButton({
  assetId,
  favorite,
  onChange,
}: {
  assetId: string;
  favorite: boolean;
  onChange: (favorite: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (busy) return;
    const next = !favorite;
    setBusy(true);
    setError(null);
    onChange(next);
    try {
      const response = await fetch(`/api/assets/${assetId}/favorite`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ favorite: next }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        onChange(!next);
        setError(data?.error ?? FAVORITE_COPY.failed);
      }
    } catch {
      onChange(!next);
      setError(FAVORITE_COPY.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={favorite}
        aria-label={favorite ? FAVORITE_COPY.remove : FAVORITE_COPY.add}
        title={favorite ? FAVORITE_COPY.remove : FAVORITE_COPY.add}
        className={cn(
          "-m-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors",
          favorite ? "text-amber-500 hover:text-amber-600" : "text-ink-500 hover:text-ink-700",
        )}
        data-testid="favorite-toggle"
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true" fill={favorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5}>
          <path d="M10 2.5l2.3 4.7 5.2.8-3.8 3.7.9 5.2L10 14.4l-4.6 2.5.9-5.2-3.8-3.7 5.2-.8L10 2.5z" strokeLinejoin="round" />
        </svg>
      </button>
      {error ? (
        <span className="text-xs text-red-700" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
