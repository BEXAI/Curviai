import Link from "next/link";
import { notFound } from "next/navigation";
import { articleSnippet, liveHelpArticles } from "@/components/marketing/help-articles";
import { pageMetadata, fitDescription, serializeJsonLd } from "@/lib/seo";
import { siteUrl } from "@/lib/env";
export function generateStaticParams() { return liveHelpArticles().map(({ slug }) => ({ slug })); }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = liveHelpArticles().find((item) => item.slug === slug);
  if (!article) return {};
  return pageMetadata({ title: article.title, description: fitDescription(article.body[0] ?? article.title), path: `/help/${slug}` });
}
export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = liveHelpArticles().find((item) => item.slug === slug);
  if (!article) notFound();
  const snippet = articleSnippet(article);
  return <article className="mx-auto max-w-3xl px-6 py-16">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd({ "@context": "https://schema.org", "@type": "Article", headline: article.title, articleBody: article.body.join("\n\n"), url: `${siteUrl()}/help/${article.slug}`, author: { "@type": "Organization", name: "Curvi" } }) }} />
    <Link href="/help" className="text-sm underline">Help center</Link>
    <h1 className="mt-5 text-3xl font-semibold text-ink-950">{article.title}</h1>
    {article.body.map((paragraph) => <p key={paragraph} className="mt-5 text-ink-600">{paragraph}</p>)}
    {snippet ? <pre className="mt-5 overflow-x-auto rounded-lg border p-4 text-sm"><code>{snippet}</code></pre> : null}
    {article.sources ? <div className="mt-8"><h2 className="font-semibold">Official guides</h2><ul className="mt-2 space-y-2">{article.sources.map((source) => <li key={source.url}><a href={source.url} className="underline" rel="noreferrer">{source.label}</a></li>)}</ul><p className="mt-3 text-xs text-ink-600">Upload guides checked October 2, 2026.</p></div> : null}
    <p className="mt-10 text-sm">Still need help? <Link href="/support" className="underline">Contact us</Link>.</p>
  </article>;
}
