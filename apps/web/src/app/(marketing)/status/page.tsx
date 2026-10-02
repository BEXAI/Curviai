import Link from "next/link";
import { statusNotes } from "@/content/status-notes";
import { customerStatus } from "@/lib/customer-status";
import { siteUrl } from "@/lib/env";
import { pageMetadata } from "@/lib/seo";
export const revalidate = 60;
export const metadata = pageMetadata({ title: "Service status", description: "Current availability of Curvi packs, downloads and account services.", path: "/status" });
async function read(path: string) {
  try { const response = await fetch(`${siteUrl()}${path}`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(4000) }); return await response.json(); } catch { return null; }
}
export default async function StatusPage() {
  const [health, acquisition] = await Promise.all([read("/api/health"), read("/api/status")]);
  const lines = customerStatus(health, acquisition);
  return <div className="mx-auto max-w-3xl px-6 py-16"><h1 className="text-4xl font-semibold">Service status</h1><p className="mt-4 text-ink-600">Updated about once a minute.</p>{!health ? <p className="mt-4 text-sm">We could not check the service just now. Please check again shortly.</p> : null}<dl className="mt-8 divide-y divide-ink-100 rounded-xl border border-ink-200 px-5">{lines.map((line) => <div key={line.name} className="flex flex-wrap justify-between gap-3 py-4"><dt>{line.name}</dt><dd className="font-medium">{line.state}</dd></div>)}</dl><h2 className="mt-10 text-xl font-semibold">Updates</h2>{statusNotes.length ? statusNotes.map((note) => <article key={`${note.date}:${note.title}`} className="mt-5"><time className="text-sm text-ink-600">{note.date}</time><h3 className="font-semibold">{note.title}</h3><p className="mt-2 text-ink-600">{note.body}</p></article>) : <p className="mt-3 text-ink-600">No incident notes have been posted.</p>}<p className="mt-8"><Link href="/support" className="underline">Contact us</Link> if you need help with a pack.</p></div>;
}
