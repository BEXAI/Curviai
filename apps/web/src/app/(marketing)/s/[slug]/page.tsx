import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { buttonVariants } from "@curvi/ui";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { OutputPreview } from "@/components/app/output-preview";
import { previewAspect } from "@/lib/output-preview";
import { fitDescription, pageMetadata } from "@/lib/seo";
import { getShareStore, type PublicShare } from "@/lib/shares";
import { shareDescription, shareIntro, shareOgAlt, sharePackHeading, shareTitle } from "@/lib/shares/page-copy";
import { ILLUSTRATION_LABEL } from "@/components/marketing/demo-images";

// Published and unpublished at any moment by the owner, so never cached.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

/** One read per request, shared by the metadata and the page. */
const loadShare = cache(async (slug: string): Promise<PublicShare | null> => getShareStore().getPublic(slug));

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const share = await loadShare(slug);
  if (!share) {
    return { title: "Share page not found", robots: { index: false, follow: false } };
  }
  const path = `/s/${share.slug}`;
  return pageMetadata({
    title: shareTitle(share),
    description: fitDescription(shareDescription(share)),
    path,
    // Only makeovers the owner put in the public gallery are offered to
    // search engines; a page shared by link stays out of the index.
    noIndex: !share.inGallery || share.illustration,
    ...(share.illustration
      ? {}
      : { image: { url: `${path}/og`, width: 1200, height: 630, alt: shareOgAlt(share) } }),
  });
}

export default async function SharePage({ params }: Params) {
  const { slug } = await params;
  const share = await loadShare(slug);
  if (!share || !share.after) {
    notFound();
  }
  if (!share.illustration) {
    await getShareStore().recordView(share.slug);
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-center text-sm font-medium text-accent-600">Made with Curvi</p>
      <h1 data-testid="share-title" className="mt-2 text-center text-3xl font-bold tracking-tight text-ink-950">
        {share.title}
      </h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-ink-600">
        {shareIntro(share)}
      </p>
      {share.illustration ? (
        <p className="mx-auto mt-4 max-w-xl rounded-lg bg-ink-50 p-3 text-center text-sm text-ink-600">
          {ILLUSTRATION_LABEL}: these images are drawn to show the format, not a real Curvi result.
        </p>
      ) : null}

      <div data-testid="share-hero" className="mx-auto mt-10 max-w-xl">
        {share.before ? (
          <BeforeAfterSlider beforeSrc={share.before.src} afterSrc={share.after.src} />
        ) : (
          <OutputPreview
            src={share.after.src}
            alt={share.after.alt}
            aspect={previewAspect([share.after.specId])}
            className="rounded-xl bg-white"
            testId="share-hero-image"
          />
        )}
      </div>

      {share.images.length > 1 ? (
        <section className="mt-12" aria-labelledby="share-pack-heading">
          <h2 id="share-pack-heading" className="text-center text-xl font-semibold text-ink-950">
            {sharePackHeading(share)}
          </h2>
          <ul data-testid="share-pack" className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {share.images.map((image) => (
              <li key={image.ref}>
                <OutputPreview
                  src={image.src}
                  alt={image.alt}
                  aspect={previewAspect([image.specId])}
                  className="rounded-xl bg-white"
                  testId="share-pack-image"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-12 rounded-xl bg-ink-950 p-8 text-center">
        <h2 className="text-xl font-bold text-white">Want this for your product?</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-300">
          Upload one photo and get a compliant main image, lifestyle scenes and channel sized exports.
          Free to try, no card needed.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/signup" className={buttonVariants({ variant: "secondary", size: "lg" })}>
            Make mine
          </Link>
          <Link
            href="/gallery"
            className="inline-flex h-11 items-center justify-center rounded-lg border border-ink-700 px-6 text-sm font-medium text-white transition-colors hover:bg-ink-800"
          >
            See more makeovers
          </Link>
        </div>
      </div>
    </div>
  );
}
