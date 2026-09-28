import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JobProgressBoard } from "@/components/app/job-progress-board";
import { isUuid } from "@/lib/uuid";

export const metadata: Metadata = { title: "Pack progress" };
export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  return <JobProgressBoard jobId={id} />;
}
