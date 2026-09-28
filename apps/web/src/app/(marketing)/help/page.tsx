import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@curvi/ui";
import { JsonLd } from "@/components/json-ld";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { helpArticles, helpClosing, structuredHelpArticles } from "@/components/marketing/help-articles";
import { breadcrumbJsonLd, faqPageJsonLd, jsonLdGraph, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Help center for AI product images on Shopify and Amazon",
  description:
    "Plain answers about Curvi's AI e-commerce images for Shopify and Amazon: what photo to upload, how credits work, compliance reports, brand kits and channels.",
  path: "/help",
});

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <JsonLd
        data={jsonLdGraph([
          faqPageJsonLd(
            structuredHelpArticles().map((article) => ({ question: article.title, answer: article.body.join(" ") })),
          ),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Help center", path: "/help" },
          ]),
        ])}
      />
      <h1 className="text-4xl font-bold tracking-tight text-ink-950">Help center</h1>
      <p className="mt-4 text-lg text-ink-600">
        Plain answers, no ticket required. If something is missing, email{" "}
        <a href="mailto:hello@curvi.ai" className="font-medium text-ink-900 underline">
          hello@curvi.ai
        </a>{" "}
        and a human replies.
      </p>

      <nav aria-label="Articles" className="mt-8 rounded-xl border border-ink-100 bg-ink-50 p-5">
        <h2 className="text-sm font-semibold text-ink-900">In this help center</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {helpArticles.map((article) => (
            <li key={article.slug}>
              <a href={`#${article.slug}`} className="text-sm text-ink-600 underline hover:text-ink-950">
                {article.title}
              </a>
              {article.status === "coming_soon" ? <ComingSoonBadge className="ml-2 align-middle" /> : null}
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-10 space-y-12">
        {helpArticles.map((article) => (
          <article key={article.slug} id={article.slug} className="scroll-mt-24">
            <h2 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-ink-950">
              {article.title}
              {article.status === "coming_soon" ? <ComingSoonBadge /> : null}
            </h2>
            {article.body.map((paragraph) => (
              <p key={paragraph.slice(0, 40)} className="mt-3 text-ink-600">
                {paragraph}
              </p>
            ))}
          </article>
        ))}
      </div>

      <div className="mt-16 rounded-xl border border-ink-100 p-8 text-center">
        <h2 className="text-xl font-semibold text-ink-950">Ready to try it?</h2>
        <p className="mt-2 text-sm text-ink-600">{helpClosing}</p>
        <Link
          href="/signup"
          className={buttonVariants({ variant: "secondary", size: "lg", className: "mt-5" })}
        >
          Get started
        </Link>
      </div>
    </div>
  );
}
