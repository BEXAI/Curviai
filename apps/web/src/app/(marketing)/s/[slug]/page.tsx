import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@curvi/ui";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Share links are not stored yet, so every slug renders the same demo
  // makeover. Keep them out of the index to avoid duplicate pages; social
  // cards still work.
  return pageMetadata({
    title: "An AI product photo makeover, before and after",
    description:
      "One photo in, a studio pack out, with the product pixels untouched. Drag the slider to compare, then run your own product through Curvi.",
    // The slug param arrives percent encoded, so it is used as is.
    path: `/s/${slug}`,
    noIndex: true,
  });
}

export default function SharePage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <p className="flex items-center justify-center gap-2 text-center text-sm font-medium text-accent-600">
        Share pages
        <ComingSoonBadge />
      </p>
      <h1 className="mt-2 text-center text-3xl font-bold tracking-tight text-ink-950">
        Before and after, same product pixels
      </h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-ink-600">
        Share pages for finished packs are coming soon. Until then, this page shows an illustration of
        the format. Drag the divider to compare a phone photo with a studio result. The product itself
        is never regenerated, so what a buyer sees is the real item.
      </p>

      <div className="mx-auto mt-10 max-w-xl">
        <BeforeAfterSlider beforeSrc={beforeDemoImage} afterSrc={afterDemoImage} />
      </div>

      <div className="mt-12 rounded-xl bg-ink-950 p-8 text-center">
        <h2 className="text-xl font-bold text-white">Want this for your product?</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-300">
          Upload one photo and get a compliant main image, lifestyle scenes and channel sized exports.
          Free to try, no card needed.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            href="/signup"
            className={buttonVariants({ variant: "secondary", size: "lg" })}
          >
            Make mine
          </Link>
          <Link
            href="/gallery"
            className="inline-flex h-11 items-center justify-center rounded-lg border border-ink-700 px-6 text-sm font-medium text-white transition-colors hover:bg-ink-800"
          >
            See more examples
          </Link>
        </div>
      </div>
    </div>
  );
}
