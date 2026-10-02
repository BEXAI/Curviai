import type { Metadata } from "next";
import Link from "next/link";
export const metadata: Metadata = { title: "Page not found | Curvi", robots: { index: false, follow: false } };
export default function NotFound() {
  return <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col justify-center px-6 py-16">
    <Link href="/" className="text-xl font-semibold">Curvi</Link>
    <h1 className="mt-8 text-3xl font-bold">We could not find that page</h1>
    <p className="mt-4 text-ink-600">It may have moved, or the link may be wrong.</p>
    <nav aria-label="Find your way" className="mt-6 flex gap-5 underline"><Link href="/">Home</Link><Link href="/pricing">Pricing</Link><Link href="/help">Help</Link></nav>
  </main>;
}
