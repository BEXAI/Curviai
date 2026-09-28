import type { Metadata } from "next";
import Link from "next/link";
import { Badge, buttonVariants } from "@curvi/ui";
import { ILLUSTRATION_LABEL, galleryCases, isIllustrationSrc } from "@/components/marketing/demo-images";
import { pageMetadata } from "@/lib/seo";
import { getShareStore, type GalleryEntry } from "@/lib/shares";

// Makeovers join and leave the gallery whenever their owners choose.
export const dynamic = "force-dynamic";

const GALLERY_LIMIT = 24;

async function customerMakeovers(): Promise<GalleryEntry[]> {
  try {
    return await getShareStore().listGallery(GALLERY_LIMIT);
  } catch (err) {
    // The page still shows the illustrations when the list cannot load.
    console.error("[gallery] could not list makeovers", err instanceof Error ? err.message : err);
    return [];
  }
}

function MakeoverCard({ entry }: { entry: GalleryEntry }) {
  return (
    <article className="overflow-hidden rounded-xl border border-ink-100 bg-white shadow-sm">
      <Link href={`/s/${entry.slug}`} className="block">
        <div className={entry.before ? "grid grid-cols-2" : "grid grid-cols-1"}>
          {entry.before ? (
            <figure className="relative">
              <img src={entry.before.src} alt={entry.before.alt} loading="lazy" className="aspect-square w-full object-cover" />
              <figcaption className="absolute left-2 top-2 rounded-full bg-ink-900/80 px-2 py-0.5 text-[10px] font-medium text-white">
                Before
              </figcaption>
            </figure>
          ) : null}
          <figure className={entry.before ? "relative border-l border-ink-100" : "relative"}>
            <img src={entry.after.src} alt={entry.after.alt} loading="lazy" className="aspect-square w-full object-cover" />
            <figcaption className="absolute right-2 top-2 rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-medium text-white">
              After
            </figcaption>
          </figure>
        </div>
        <div className="flex items-center justify-between gap-3 p-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{entry.title}</h3>
            <p className="text-xs text-ink-500">Shared by the seller</p>
          </div>
          {/* Demo mode packs are drawn, and say so. */}
          {isIllustrationSrc(entry.after.src) ? (
            <Badge variant="outline" data-testid="illustration-label">
              {ILLUSTRATION_LABEL}
            </Badge>
          ) : null}
        </div>
      </Link>
    </article>
  );
}

export const metadata: Metadata = pageMetadata({
  title: "AI product photo makeovers, before and after",
  description:
    "Before and after AI product photo makeovers for Shopify and Amazon listings. Illustrations of the format now, opted in customer makeovers as they come in.",
  path: "/gallery",
});

export default async function GalleryPage() {
  const makeovers = await customerMakeovers();
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight text-ink-950">Makeover gallery</h1>
        <p className="mt-4 text-lg text-ink-600">
          Each case shows a phone photo on the left and a studio result on the right, with the
          product pixels identical in both.
        </p>
      </div>

      {makeovers.length > 0 ? (
        <section className="mt-12" aria-labelledby="customer-makeovers">
          <h2 id="customer-makeovers" className="text-xl font-semibold text-ink-950">
            Customer makeovers
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Real packs, shown here because their owners chose to share them.
          </p>
          <div data-testid="customer-makeovers" className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {makeovers.map((entry) => (
              <MakeoverCard key={entry.slug} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}

      <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-ink-100 bg-ink-50 p-5 text-center text-sm text-ink-600">
        The cases below are illustrations drawn to show the format, not real customer photos or
        Curvi results. Customer makeovers appear here only when the customer opts in, and each one
        says so.
      </div>

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {galleryCases.map((item) => {
          const illustration = isIllustrationSrc(item.before) || isIllustrationSrc(item.after);
          const alt = (side: string) =>
            illustration ? `${ILLUSTRATION_LABEL} of ${item.title}, ${side}` : `${item.title}, ${side}`;
          return (
            <article key={item.slug} className="overflow-hidden rounded-xl border border-ink-100 bg-white shadow-sm">
              <div className="grid grid-cols-2">
                <figure className="relative">
                  <img src={item.before} alt={alt("before")} className="aspect-square w-full object-cover" />
                  <figcaption className="absolute left-2 top-2 rounded-full bg-ink-900/80 px-2 py-0.5 text-[10px] font-medium text-white">
                    Before
                  </figcaption>
                </figure>
                <figure className="relative border-l border-ink-100">
                  <img src={item.after} alt={alt("after")} className="aspect-square w-full object-cover" />
                  <figcaption className="absolute right-2 top-2 rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-medium text-white">
                    After
                  </figcaption>
                </figure>
              </div>
              <div className="flex items-center justify-between gap-3 p-4">
                <div>
                  <h2 className="text-sm font-semibold text-ink-900">{item.title}</h2>
                  <p className="text-xs text-ink-500">{item.category}</p>
                </div>
                {illustration ? (
                  <Badge variant="outline" data-testid="illustration-label">
                    {ILLUSTRATION_LABEL}
                  </Badge>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <div className="mt-14 rounded-xl bg-ink-950 p-10 text-center">
        <h2 className="text-2xl font-bold text-white">
          {makeovers.length > 0 ? "Put your product in the gallery" : "Your product could be the first real case here"}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-300">
          Run one photo through Curvi and get your pack. When it is ready, you can publish a share
          page and choose to show it here. Featuring is always your call, and you can take it down
          any time.
        </p>
        <Link
          href="/signup"
          className={buttonVariants({ variant: "secondary", size: "lg", className: "mt-6" })}
        >
          Start free
        </Link>
      </div>
    </div>
  );
}
