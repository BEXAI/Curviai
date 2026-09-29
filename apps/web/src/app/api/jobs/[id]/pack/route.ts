/**
 * GET /api/jobs/:id/pack
 * Streams one zip of every delivered file of a finished job (Update.md 6.5).
 * It agrees with the per channel downloads: one folder per channel, each file
 * under the exact name stored for it, and the pack's compliance report at the
 * root. Every object is checked before streaming starts, so the zip is never
 * quietly missing a file: a missing object answers 409 instead. Files are
 * streamed from storage one at a time (lib/http/zip-stream), never held in
 * memory together, and the route is rate limited by IP and by user
 * (jobs.pack). Workspace scoped through the caller's membership, db mode
 * only, since demo jobs keep no durable files.
 */

import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { isR2Configured } from "@/lib/env";
import { resolveSignedIn } from "@/lib/http/services";
import { zipStream } from "@/lib/http/zip-stream";
import { packZipEntries } from "@/lib/pack-zip";
import { isWorkspaceKey, objectExists, privateBucket, r2Client } from "@/lib/r2";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NOT_FOUND = "This job does not exist in your workspace.";

/** One stored object as a Node stream; null when it is missing. */
async function openObject(key: string): Promise<Readable | null> {
  try {
    const res = await r2Client().send(new GetObjectCommand({ Bucket: privateBucket(), Key: key }));
    return res.Body instanceof Readable ? res.Body : null;
  } catch {
    return null;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ipLimited = await limitByIp(request, "jobs.pack");
  if (ipLimited) {
    return ipLimited;
  }
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  if (!isDbMode() || !isR2Configured()) {
    return NextResponse.json({ error: "Pack downloads are not available on this server." }, { status: 404 });
  }
  const resolved = await resolveSignedIn("Sign in to download packs.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const workspaceId = resolved.workspace.id;
  const userLimited = await limitByUser("jobs.pack", await userRateLimitSubject(workspaceId));
  if (userLimited) {
    return userLimited;
  }

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
  // Only picked files ship (PHASE_16 workstream 6): an extra scene version
  // the seller has not picked stays out of the zip.
  const ownVariants = variants.filter((v) => v.picked && isWorkspaceKey(workspaceId, v.r2Key));
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

  const body = zipStream(
    entries.map((entry) => ({ name: entry.name, source: entry.r2Key })),
    openObject,
    (err) => console.error(`[pack] zip for job ${job.id} failed`, err),
  );
  return new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="curvi-pack-${job.id}.zip"`,
      "cache-control": "no-store",
    },
  });
}
