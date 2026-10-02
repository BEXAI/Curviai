import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@curvi/ui";
import { JsonLd } from "@/components/json-ld";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { categories, categoryForSlug } from "@/components/marketing/categories";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import { EmailCapture } from "@/components/marketing/email-capture";
import { pillarPages } from "@/components/marketing/pillar-copy";
import { SignupLink } from "@/components/marketing/signup-link";
import { freeCredits, freeCreditsReach } from "@/lib/marketing-facts";
import { breadcrumbJsonLd, categoryPageSeo, jsonLdGraph, pageMetadata } from "@/lib/seo";

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
  return pageMetadata({ ...categoryPageSeo(page.name), path: `/for/${page.slug}` });
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
      <JsonLd
        data={jsonLdGraph([
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: `AI product photos for ${page.name.toLowerCase()}`, path: `/for/${page.slug}` },
          ]),
        ])}
      />
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <p className="text-sm font-medium text-accent-600">Curvi for {page.name.toLowerCase()}</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-ink-950">{page.headline}</h1>
          <p className="mt-4 text-lg text-ink-600">{page.intro}</p>
          <p className="mt-4 text-sm font-medium text-ink-800">{page.proofLine}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <SignupLink
              source="category"
              extra={{ category: page.slug }}
              className={buttonVariants({ variant: "secondary", size: "lg" })}
            >
              Start free
            </SignupLink>
            <Link
              href="/pricing"
              className={buttonVariants({ variant: "outline", size: "lg" })}
            >
              See pricing
            </Link>
          </div>
        </div>
        <div>
          <BeforeAfterSlider beforeSrc={beforeDemoImage} afterSrc={afterDemoImage} />
          <p className="mt-2 text-center text-xs text-ink-400">
            Illustration of the before and after format, not a {page.name.toLowerCase()} sample.
          </p>
        </div>
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
            {page.comingSoon.map((item) => (
              <li
                key={item}
                className="flex items-start justify-between gap-3 rounded-lg border border-dashed border-ink-200 p-4 text-sm text-ink-500"
              >
                <span className="flex gap-3">
                  <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-ink-300" aria-hidden="true" />
                  {item}
                </span>
                <ComingSoonBadge />
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
          Start free with {freeCredits()} credits, {freeCreditsReach()}.
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

      <h2 className="mt-10 text-lg font-semibold text-ink-950">Guides</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {pillarPages.map((guide) => (
          <li key={guide.path}>
            <Link
              href={guide.path}
              className="inline-block rounded-full border border-ink-200 px-3 py-1 text-sm text-ink-600 hover:bg-ink-50"
            >
              {guide.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
