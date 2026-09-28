/**
 * GET /api/jobs/:id/pack
 * Streams a zip of every stored variant for a finished job, plus a
 * report.json with the QC verdicts. Owner scoped through the workspace, db
 * mode only, since demo jobs keep no durable files.
 */

import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { NextResponse } from "next/server";
import { isR2Configured } from "@/lib/env";
import { getObjectBytes } from "@/lib/r2";
import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { isWorkspaceObjectKey } from "@/lib/object-keys";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  // A non uuid id can never match a job; answer 404 before Postgres raises
  // 22P02 (Update.md 4.7).
  if (!isUuid(id)) {
    return NextResponse.json({ error: "This job does not exist in your workspace." }, { status: 404 });
  }
  if (!isDbMode() || !isR2Configured()) {
    return NextResponse.json({ error: "Pack downloads need the full setup." }, { status: 404 });
  }
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to download packs." }, { status: 401 });
  }
  const job = await services.getJob(workspace.id, id);
  if (!job) {
    return NextResponse.json({ error: "This job does not exist in your workspace." }, { status: 404 });
  }

  const db = getDb();
  const assetRows = await db.query.assets.findMany({
    where: (t, { and, eq }) => and(eq(t.jobId, id), eq(t.workspaceId, workspace.id)),
  });
  if (assetRows.length === 0) {
    return NextResponse.json({ error: "This job has no stored files yet." }, { status: 404 });
  }
  // Only this workspace's rows and keys are ever fetched with owner R2
  // credentials (Update.md 4.1), including rows written before migration 0011.
  const variants = (
    await db.query.assetVariants.findMany({
      where: (t, { and, eq, inArray }) =>
        and(
          eq(t.workspaceId, workspace.id),
          inArray(
            t.assetId,
            assetRows.map((a) => a.id),
          ),
        ),
    })
  ).filter((variant) => isWorkspaceObjectKey(workspace.id, variant.r2Key));
  if (variants.length === 0) {
    return NextResponse.json({ error: "This job has no stored files yet." }, { status: 404 });
  }

  const archive = archiver("zip", { zlib: { level: 6 } });
  const out = new PassThrough();
  archive.pipe(out);

  const qcByAssetId = new Map(assetRows.map((a) => [a.id, { shotType: a.shotType, approved: a.approved, qc: a.qc }]));
  void (async () => {
    for (const variant of variants) {
      const bytes = await getObjectBytes(variant.r2Key);
      if (!bytes) {
        continue;
      }
      const base = variant.r2Key.split("/").pop() ?? variant.filename;
      const meta = qcByAssetId.get(variant.assetId);
      archive.append(bytes, { name: `${meta?.shotType ?? "shot"}-${base}` });
    }
    archive.append(
      JSON.stringify(
        {
          jobId: id,
          product: job.productTitle,
          status: job.status,
          creditsCharged: job.creditsCharged,
          shots: assetRows.map((a) => ({ shotType: a.shotType, approved: a.approved, qc: a.qc })),
        },
        null,
        2,
      ),
      { name: "report.json" },
    );
    await archive.finalize();
  })().catch(() => {
    archive.abort();
  });

  return new Response(Readable.toWeb(out) as ReadableStream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="curvi-pack-${id}.zip"`,
    },
  });
}
