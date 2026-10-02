import type { Metadata } from "next";
import Link from "next/link";
import { requireOperator } from "@/lib/ops/access";
import { listGalleryQueue } from "@/lib/ops/gallery";
import { getDb } from "@/lib/services/db";
import { reviewGallery } from "./actions";

export const metadata: Metadata = { title: "Gallery review", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function GalleryReviewPage() {
  await requireOperator();
  const items = await listGalleryQueue(getDb());
  return <main className="space-y-6">
    <div><h1 className="text-2xl font-semibold">Gallery review</h1><p className="text-sm text-muted-foreground">Review each submission before it appears in the public gallery.</p></div>
    {items.length === 0 ? <p>No submissions need review.</p> : <ul className="space-y-4">
      {items.map((item) => <li key={item.id} className="rounded-lg border p-4 space-y-3">
        <div><h2 className="font-medium">{item.title ?? "Product photo makeover"}</h2><p className="text-sm text-muted-foreground">{item.category ?? "Uncategorized"} · Submitted {item.submittedAt.toISOString().slice(0, 10)}</p></div>
        <Link href={`/s/${item.slug}`} target="_blank" rel="noopener noreferrer" className="underline">Review share page</Link>
        <form action={reviewGallery} className="flex gap-3">
          <input type="hidden" name="itemId" value={item.id} />
          <button type="submit" name="decision" value="approved" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Approve</button>
          <button type="submit" name="decision" value="rejected" className="rounded-md border px-4 py-2 text-sm">Reject</button>
        </form>
      </li>)}
    </ul>}
  </main>;
}
