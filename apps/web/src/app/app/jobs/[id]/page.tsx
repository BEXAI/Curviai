import type { Metadata } from "next";
import { JobProgressBoard } from "@/components/app/job-progress-board";

export const metadata: Metadata = { title: "Pack progress" };
export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JobProgressBoard jobId={id} />;
}
