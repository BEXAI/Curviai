import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@curvi/ui";
import { GalleryGrid } from "@/components/app/gallery-grid";
import { LIBRARY_PAGE_SIZE, parseGalleryFilters } from "@/lib/library";
import { getServices } from "@/lib/services";

export const metadata: Metadata = { title: "Library" };
export const dynamic = "force-dynamic";

/**
 * The image library (docs/phases/PHASE_16.md workstream 6): every image the
 * workspace's packs delivered, in a masonry grid at each image's true
 * aspect ratio, with favorites and filters by channel and shot type. The
 * filters ride in the query string, so a filtered view can be bookmarked.
 */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to see your images</h1>
        <p className="mt-3 text-ink-600">Every image your packs made appears here after you sign in.</p>
        <Link href="/login?next=/app/library" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
          Log in
        </Link>
      </div>
    );
  }

  const filters = parseGalleryFilters(await searchParams);
  const library = await services.listLibrary(workspace.id, filters);
  const filtered = filters.channel !== null || filters.shotType !== null || filters.favorites;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-950">Library</h1>
          <p className="mt-1 text-sm text-ink-500">Every image your packs made, newest first.</p>
        </div>
        <Link href="/app/new" className={buttonVariants({ variant: "secondary" })}>
          New pack
        </Link>
      </div>

      <GalleryGrid
        items={library.items}
        facets={library.facets}
        filters={filters}
        basePath="/app/library"
        canFavorite={workspace.role !== "client"}
        showProduct
        emptyText={
          filtered
            ? "No images match these filters."
            : services.mode === "demo"
              ? "Demo packs keep no stored images. Connect a database and storage to build your library."
              : "No images yet. Images appear here once a pack is finished."
        }
        testId="library-grid"
      />

      {library.truncated ? (
        <p className="text-sm text-ink-500" data-testid="library-truncated">
          Showing the newest {LIBRARY_PAGE_SIZE} images. Use the filters to find older ones.
        </p>
      ) : null}
    </div>
  );
}
