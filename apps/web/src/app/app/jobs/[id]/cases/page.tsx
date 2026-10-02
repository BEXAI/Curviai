import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PackCases } from "@/components/app/pack-cases";
import { caseActor, getCaseStore } from "@/lib/cases";
import { getServices } from "@/lib/services";
import { isUuid } from "@/lib/validation/ids";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pack help", robots: { index: false, follow: false } };
export default async function PackCasesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; if (!isUuid(id)) notFound();
  const services = getServices(), workspace = await services.getCurrentWorkspace();
  if (!workspace) redirect("/login");
  const actor = await caseActor(workspace.id); if (!actor) redirect("/login");
  const [initial, job, outputs] = await Promise.all([getCaseStore().list(actor, id), services.getJob(workspace.id, id), services.listJobFiles(workspace.id, id)]);
  if (!initial || !job) notFound();
  const files = (outputs?.files ?? []).filter((file) => file.kind === "image" && file.id.startsWith("v_") && isUuid(file.id.slice(2))).map((file) => ({ id: file.id.slice(2), label: file.name, shotId: file.shotId ?? null }));
  return <div className="max-w-3xl space-y-6"><Link href={`/app/jobs/${id}`} className="text-sm underline">Back to pack</Link><h1 className="text-2xl font-semibold">Pack help</h1><p>{job.productTitle}</p><PackCases jobId={id} initial={initial} shots={job.shots.map((shot) => ({ id: shot.shotId, label: `${shot.shotType.replaceAll("_", " ")}${shot.version ? `, version ${shot.version.number}` : ""}` }))} files={files} /><p className="text-sm"><Link href="/support" className="underline">Contact us about another question</Link></p></div>;
}
