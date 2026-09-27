import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { categories, categoryForSlug } from "@/components/marketing/categories";
import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import { EmailCapture } from "@/components/marketing/email-capture";

export const dynamicParams = false;

export function generateStaticParams(): { category: string }[] {
  return categories.map((category) => ({ category: category.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  const page = categoryForSlug(category);
  if (!page) {
    return { title: "Curvi for your category" };
  }
  return {
    title: `Curvi for ${page.name.toLowerCase()}`,
    description: page.intro.slice(0, 155),
  };
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  const page = categoryForSlug(category);
  if (!page) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <p className="text-sm font-medium text-accent-600">Curvi for {page.name.toLowerCase()}</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-ink-950">{page.headline}</h1>
          <p className="mt-4 text-lg text-ink-600">{page.intro}</p>
          <p className="mt-4 text-sm font-medium text-ink-800">{page.proofLine}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="inline-flex h-11 items-center justify-center rounded-lg bg-accent-500 px-6 text-sm font-medium text-white transition-colors hover:bg-accent-600"
            >
              Start free
            </Link>
            <Link
              href="/pricing"
              className="inline-flex h-11 items-center justify-center rounded-lg border border-ink-200 bg-white px-6 text-sm font-medium text-ink-900 transition-colors hover:bg-ink-50"
            >
              See pricing
            </Link>
          </div>
        </div>
        <BeforeAfterSlider
          beforeSrc={beforeDemoImage}
          afterSrc={afterDemoImage}
          beforeLabel="Your photo"
          afterLabel="Curvi output"
        />
      </div>

      <div className="mt-16 grid gap-10 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold text-ink-950">
            What goes wrong in {page.name.toLowerCase()} today
          </h2>
          <ul className="mt-5 space-y-3">
            {page.painPoints.map((point) => (
              <li key={point} className="flex gap-3 rounded-lg border border-ink-100 p-4 text-sm text-ink-700">
                <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-red-400" aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-2xl font-semibold text-ink-950">What a {page.name.toLowerCase()} pack includes</h2>
          <ul className="mt-5 space-y-3">
            {page.packContents.map((item) => (
              <li key={item} className="flex gap-3 rounded-lg border border-ink-100 p-4 text-sm text-ink-700">
                <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-accent-500" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-16 rounded-xl border border-ink-100 bg-ink-50 p-8 text-center">
        <h2 className="text-xl font-semibold text-ink-950">
          Try it on your best selling {page.name.toLowerCase()} product
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-ink-600">
          Start free with 15 credits, enough for a compliant main image, two lifestyle shots and a
          share page.
        </p>
        <div className="mt-6">
          <EmailCapture />
        </div>
      </div>

      <h2 className="mt-12 text-lg font-semibold text-ink-950">Other categories</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {categories
          .filter((other) => other.slug !== page.slug)
          .map((other) => (
            <li key={other.slug}>
              <Link
                href={`/for/${other.slug}`}
                className="inline-block rounded-full border border-ink-200 px-3 py-1 text-sm text-ink-600 hover:bg-ink-50"
              >
                {other.name}
              </Link>
            </li>
          ))}
      </ul>
    </div>
  );
}
