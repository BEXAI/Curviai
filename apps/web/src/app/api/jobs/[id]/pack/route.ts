/**
 * GET /api/jobs/:id/pack
 * Streams one zip of every delivered file of a finished job (Update.md 6.5).
 * It agrees with the per channel downloads: one folder per channel, each file
 * under the exact name stored for it, and the pack's compliance report at the
 * root. Every object is checked before streaming starts, so the zip is never
 * quietly missing a file: a missing object answers 409 instead. Workspace
 * scoped through the caller's membership, db mode only, since demo jobs keep
 * no durable files.
 */

import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { NextResponse } from "next/server";
import { isR2Configured } from "@/lib/env";
import { packZipEntries } from "@/lib/pack-zip";
import { getObjectBytes, isWorkspaceKey, objectExists } from "@/lib/r2";
import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

const NOT_FOUND = "This job does not exist in your workspace.";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  if (!isDbMode() || !isR2Configured()) {
    return NextResponse.json({ error: "Pack downloads are not available on this server." }, { status: 404 });
  }
  const resolved = await resolveWorkspace(getServices(), "Sign in to download packs.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const workspaceId = resolved.workspace.id;

  const db = getDb();
  const job = await db.query.generationJobs.findFirst({
    where: (t, { and, eq }) => and(eq(t.id, id), eq(t.workspaceId, workspaceId)),
  });
  if (!job) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  if (job.status !== "done") {
    return NextResponse.json(
      { error: "This pack is not finished yet. Download it once it is done." },
      { status: 409 },
    );
  }

  const assetRows = await db.query.assets.findMany({
    where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspaceId)),
  });
  const [variants, reports] = await Promise.all([
    assetRows.length > 0
      ? db.query.assetVariants.findMany({
          where: (t, { and, eq, inArray }) =>
            and(
              eq(t.workspaceId, workspaceId),
              inArray(
                t.assetId,
                assetRows.map((a) => a.id),
              ),
            ),
        })
      : Promise.resolve([]),
    db.query.packFiles.findMany({
      where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspaceId), eq(t.kind, "report")),
    }),
  ]);
  const ownVariants = variants.filter((v) => isWorkspaceKey(workspaceId, v.r2Key));
  if (ownVariants.length === 0) {
    return NextResponse.json({ error: "This pack has no files to download." }, { status: 404 });
  }
  const report = reports.find((r) => isWorkspaceKey(workspaceId, r.r2Key)) ?? null;
  const entries = packZipEntries(ownVariants, report);

  const present = await Promise.all(entries.map((entry) => objectExists(entry.r2Key)));
  const missing = entries.filter((_, index) => !present[index]);
  if (missing.length > 0) {
    console.error(
      `[pack] job ${job.id} is missing ${missing.length} stored files: ${missing.map((m) => m.r2Key).join(", ")}`,
    );
    return NextResponse.json(
      {
        error:
          "Some files in this pack are missing, so the full zip is not available. Download each channel on this page, or contact us and we will sort it out.",
      },
      { status: 409 },
    );
  }

  const archive = archiver("zip", { zlib: { level: 6 } });
  const out = new PassThrough();
  archive.on("error", (err) => out.destroy(err));
  archive.pipe(out);

  void (async () => {
    for (const entry of entries) {
      const bytes = await getObjectBytes(entry.r2Key);
      if (!bytes) {
        // Vanished after the check: end the download with an error rather
        // than hand over a zip that is silently short a file.
        throw new Error(`pack file ${entry.r2Key} disappeared while zipping`);
      }
      archive.append(bytes, { name: entry.name });
    }
    await archive.finalize();
  })().catch((err: unknown) => {
    console.error(`[pack] zip for job ${job.id} failed`, err);
    archive.abort();
    out.destroy(err instanceof Error ? err : new Error(String(err)));
  });

  return new Response(Readable.toWeb(out) as ReadableStream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="curvi-pack-${job.id}.zip"`,
      "cache-control": "no-store",
    },
  });
}
