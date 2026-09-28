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

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
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
  const assetRows = await db.query.assets.findMany({ where: (t, { eq }) => eq(t.jobId, id) });
  if (assetRows.length === 0) {
    return NextResponse.json({ error: "This job has no stored files yet." }, { status: 404 });
  }
  const variants = await db.query.assetVariants.findMany({
    where: (t, { inArray }) =>
      inArray(
        t.assetId,
        assetRows.map((a) => a.id),
      ),
  });
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
