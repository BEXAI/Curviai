import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JobProgressBoard } from "@/components/app/job-progress-board";
import { PackFeedbackCard } from "@/components/app/pack-feedback-card";
import { SharePanel } from "@/components/app/share-panel";
import { isUuid } from "@/lib/validation/ids";

export const metadata: Metadata = { title: "Pack progress" };
export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A non uuid id can never be a job (Update.md 4.7): show the 404 page
  // instead of a board that polls an id the API will never find.
  if (!isUuid(id)) {
    notFound();
  }
  return (
    <>
      <JobProgressBoard jobId={id} />
      {/* "Would you use these files?" once the pack is done (P18-05). */}
      <PackFeedbackCard jobId={id} />
      {/* Appears once the pack has finished images (plan 9.6.1). */}
      <SharePanel jobId={id} />
    </>
  );
}
