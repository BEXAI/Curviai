"use client";
import Link from "next/link";
import { useState } from "react";
export function HelpIndex({ articles }: { articles: Array<{ slug: string; title: string; group?: string }> }) {
  const [query, setQuery] = useState("");
  const filtered = articles.filter((article) => article.title.toLowerCase().includes(query.toLowerCase().trim()));
  const groups = ["Making packs", "Selling channels", "Billing and account"];
  return <div className="mt-8"><label className="block text-sm font-medium">Find an article<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="mt-2 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ink-950" /></label><p className="mt-2 text-sm text-ink-600" role="status">{filtered.length} articles</p>{groups.map((group) => { const matches = filtered.filter((article) => (article.group ?? "Making packs") === group); return matches.length ? <section key={group} className="mt-8"><h2 className="text-lg font-semibold">{group}</h2><ul className="mt-3 space-y-3">{matches.map((article) => <li key={article.slug} id={article.slug} className="scroll-mt-24"><Link href={`/help/${article.slug}`} className="text-ink-600 underline">{article.title}</Link></li>)}</ul></section> : null; })}</div>;
}
