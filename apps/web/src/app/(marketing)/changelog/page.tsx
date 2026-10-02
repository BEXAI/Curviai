import { changelog } from "@/content/changelog";
import { pageMetadata } from "@/lib/seo";
export const metadata = pageMetadata({ title: "Changelog", description: "Updates to Curvi and your product image packs.", path: "/changelog" });
export default function ChangelogPage() {
  return <div className="mx-auto max-w-3xl px-6 py-16"><h1 className="text-4xl font-semibold">Changelog</h1>{changelog.length ? changelog.map((entry) => <article key={`${entry.date}:${entry.title}`} className="mt-8"><time className="text-sm text-ink-600">{entry.date}</time><h2 className="mt-2 text-xl font-semibold">{entry.title}</h2><p className="mt-3 text-ink-600">{entry.body}</p></article>) : <p className="mt-5 text-ink-600">Product updates will be posted here as they ship.</p>}</div>;
}
