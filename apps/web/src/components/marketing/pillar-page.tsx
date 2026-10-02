import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import { JsonLd } from "@/components/json-ld";
import { breadcrumbJsonLd, faqPageJsonLd, jsonLdGraph, pageMetadata, webPageJsonLd } from "@/lib/seo";
import type { PillarPage } from "./pillar-copy";
import { SignupLink } from "./signup-link";

/** Metadata for a guide page: canonical, social card and keywords. */
export function pillarMetadata(page: PillarPage, keywords?: string[]): Metadata {
  return pageMetadata({
    title: page.title,
    description: page.description,
    path: page.path,
    ...(keywords ? { keywords } : {}),
  });
}

/** The signup source key of a guide page's Start free links (P18-01):
 * comparison pages count apart from the other guides. */
export function signupSourceFor(page: Pick<PillarPage, "path">): "compare" | "pillar" {
  return page.path.startsWith("/compare/") ? "compare" : "pillar";
}

/** Home, then the page. */
function breadcrumbs(page: PillarPage): { name: string; path: string }[] {
  return [
    { name: "Home", path: "/" },
    { name: page.name, path: page.path },
  ];
}

/**
 * One long form guide page on the dark marketing theme: an answer first
 * summary, question headings, an optional comparison table, FAQs and a call
 * to action to /signup. JSON-LD carries the WebPage, BreadcrumbList and
 * FAQPage for answer engines.
 */
export function PillarPageView({ page }: { page: PillarPage }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <JsonLd
        data={jsonLdGraph([
          webPageJsonLd({ name: page.h1, path: page.path, description: page.description }),
          breadcrumbJsonLd(breadcrumbs(page)),
          faqPageJsonLd(page.faqs.map((faq) => ({ question: faq.q, answer: faq.a }))),
        ])}
      />
      <nav aria-label="Breadcrumb" className="text-sm text-ink-500">
        <ol className="flex flex-wrap items-center gap-2">
          {breadcrumbs(page).map((crumb, index, all) => (
            <li key={crumb.path} className="flex items-center gap-2">
              {index < all.length - 1 ? (
                <>
                  <Link href={crumb.path} className="hover:text-ink-950">
                    {crumb.name}
                  </Link>
                  <span aria-hidden="true">/</span>
                </>
              ) : (
                <span className="text-ink-700">{crumb.name}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <Badge variant="outline" className="mt-8">
        {page.eyebrow}
      </Badge>
      <h1 className="mt-4 text-4xl font-bold tracking-tight text-ink-950 sm:text-5xl">{page.h1}</h1>
      <p data-testid="pillar-summary" className="mt-6 text-lg leading-relaxed text-ink-700">
        {page.summary}
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <SignupLink source={signupSourceFor(page)} className={buttonVariants({ variant: "secondary", size: "lg" })}>
          Start free
        </SignupLink>
        <Link href="/pricing" className={buttonVariants({ variant: "outline", size: "lg" })}>
          See pricing
        </Link>
      </div>

      <div className="mt-14 space-y-12">
        {page.sections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-2xl font-semibold text-ink-950">{section.heading}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph.slice(0, 48)} className="mt-3 leading-relaxed text-ink-600">
                {paragraph}
              </p>
            ))}
            {section.bullets ? (
              <ul className="mt-4 space-y-2">
                {section.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-3 text-ink-600">
                    <span className="mt-2 inline-block h-2 w-2 shrink-0 rounded-full bg-accent-500" aria-hidden="true" />
                    {bullet}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>

      {page.table ? (
        <section className="mt-14">
          <h2 className="text-2xl font-semibold text-ink-950">{page.table.caption}</h2>
          <div className="mt-5 overflow-x-auto rounded-xl border border-ink-100">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <caption className="sr-only">{page.table.caption}</caption>
              <thead className="bg-ink-50">
                <tr>
                  {page.table.columns.map((column) => (
                    <th key={column} scope="col" className="px-4 py-3 font-semibold text-ink-900">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.table.rows.map((row) => (
                  <tr key={row[0]} className="border-t border-ink-100 align-top">
                    {row.map((cell, index) =>
                      index === 0 ? (
                        <th key={index} scope="row" className="px-4 py-3 font-medium text-ink-950">
                          {cell}
                        </th>
                      ) : (
                        <td key={index} className="px-4 py-3 text-ink-600">
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.table.note ? <p className="mt-3 text-xs text-ink-500">{page.table.note}</p> : null}
          {page.table.sources ? (
            <p className="mt-2 text-xs text-ink-500">
              Sources:{" "}
              {page.table.sources.map((source, index, all) => (
                <span key={source.url}>
                  <a href={source.url} rel="nofollow noopener" target="_blank" className="underline hover:text-ink-900">
                    {source.name}
                  </a>
                  {index < all.length - 1 ? ", " : "."}
                </span>
              ))}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mt-14">
        <h2 className="text-2xl font-semibold text-ink-950">Questions, answered</h2>
        <div className="mt-5 grid gap-4">
          {page.faqs.map((faq) => (
            <Card key={faq.q}>
              <CardHeader>
                <CardTitle className="text-base leading-snug text-ink-950">
                  {faq.q}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed text-ink-600">{faq.a}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-14 rounded-xl border border-ink-100 bg-ink-50 p-8 text-center">
        <h2 className="text-xl font-semibold text-ink-950">{page.ctaTitle}</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-ink-600">{page.ctaBody}</p>
        <SignupLink
          source={signupSourceFor(page)}
          className={buttonVariants({ variant: "secondary", size: "lg", className: "mt-6" })}
        >
          Start free
        </SignupLink>
      </section>

      <nav aria-label="Related guides" className="mt-12">
        <h2 className="text-lg font-semibold text-ink-950">Related guides</h2>
        <ul className="mt-3 flex flex-wrap gap-2">
          {page.related.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="inline-block rounded-full border border-ink-200 px-3 py-1 text-sm text-ink-600 hover:bg-ink-50"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
