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
 *
 * The zip is served whenever the file list is (servesFiles): a finished
 * pack, and a delivered pack while a retried shot or an added photo runs
 * again. "Download all files" is a plain link, so a refusal answered to a
 * browser navigation is a short page with the message and a way back to the
 * pack instead of raw JSON: a refusal with a code (not finished, no files,
 * missing files) redirects to the job page, which shows plain copy for it,
 * and any other refusal is a short page with a link back. API callers still
 * get JSON.
 */

import { publicOrigin } from "@/lib/http/public-origin";
import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { ADS_CSV_NAME } from "@curvi/pipeline/csv";
import { pickedComplianceReport } from "@/lib/compliance-report";
import { isR2Configured } from "@/lib/env";
import { recordFunnel } from "@/lib/funnel";
import { resolveSignedIn } from "@/lib/http/services";
import { zipStream } from "@/lib/http/zip-stream";
import { isPageNavigation, packZipEntries, packZipAdsCsv, zipAssetMetadata, packZipRefusalPath, type PackZipRefusal } from "@/lib/pack-zip";
import { isWorkspaceKey, objectExists, privateBucket, r2Client } from "@/lib/r2";
import { readStoredReportBytes } from "@/lib/selected-report-download";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { isDbMode } from "@/lib/services";
import { getDb, servesFiles } from "@/lib/services/db";
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

/** A refusal after the job is found. The Download all link is a top level
 * navigation, so a browser goes back to the job page, which shows plain copy
 * for the code; a fetch still gets the JSON answer. */
function refuse(request: Request, jobId: string, code: PackZipRefusal, error: string, status: number): Response {
  if (isPageNavigation(request)) {
    return NextResponse.redirect(new URL(packZipRefusalPath(jobId, code), publicOrigin(request)), 303);
  }
  return NextResponse.json({ error }, { status });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const response = await packZip(request, context);
  // A refusal with a code already sends the browser back to the job page.
  if (response.ok || response.status === 303 || !wantsHtml(request)) {
    return response;
  }
  const { id } = await context.params;
  return refusalPage(response, isUuid(id) ? id : null);
}

/** True for a browser navigation (the Download all link), not a fetch. */
function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The refusal's message as a small page with a link back to the pack. The
 * status and a Retry-After header are kept. */
async function refusalPage(response: Response, jobId: string | null): Promise<Response> {
  let message = "We could not prepare this download right now. Try again in a moment.";
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      message = body.error;
    }
  } catch {
    // Not JSON: keep the default message.
  }
  const back = jobId ? `/app/jobs/${jobId}` : "/app";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Download not available</title><style>body{font-family:system-ui,sans-serif;background:#fafaf9;color:#1c1917;margin:0;padding:48px 16px}main{max-width:32rem;margin:0 auto}a{color:inherit}</style></head><body><main><h1>Download not available</h1><p>${escapeHtml(message)}</p><p><a href="${back}">Back to your pack</a></p></main></body></html>`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    headers.set("retry-after", retryAfter);
  }
  return new Response(html, { status: response.status, headers });
}

async function packZip(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
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
  if (!servesFiles(job)) {
    return refuse(request, job.id, "not_finished", "This pack is not finished yet. Download it once it is done.", 409);
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
  const ownVariants = variants.filter((v) => v.picked && isWorkspaceKey(workspaceId, v.r2Key))
    .map((v) => ({ ...v, ...zipAssetMetadata(assetRows.find((a) => a.id === v.assetId)?.qc ?? null) }));
  if (ownVariants.length === 0) {
    return refuse(request, job.id, "no_files", "This pack has no files to download.", 404);
  }
  const report = reports.find((r) => isWorkspaceKey(workspaceId, r.r2Key)) ?? null;
  const entries = packZipEntries(ownVariants, null);
  const inline = new Map<string, Buffer>();
  let raw: unknown = null;
  if (report) {
    try {
      const bytes = await readStoredReportBytes(report.r2Key);
      raw = bytes ? JSON.parse(bytes.toString("utf8")) : null;
    } catch { /* Exact per-file records below may still supply the report. */ }
  }
  const selected = pickedComplianceReport(raw, ownVariants.map((v) => ({ ...v, workspaceId, jobId: job.id })), assetRows);
  if (report && !selected) {
    return refuse(request, job.id, "missing_files", "This pack's saved checks are not available right now. Try again or contact us.", 409);
  }
  if (selected) inline.set("inline:report", Buffer.from(JSON.stringify(selected, null, 2)));
  const csv = packZipAdsCsv(ownVariants, entries);
  if (csv) inline.set("inline:ads", Buffer.from(csv));

  const present = await Promise.all(entries.map((entry) => objectExists(entry.r2Key)));
  const missing = entries.filter((_, index) => !present[index]);
  if (missing.length > 0) {
    console.error(
      `[pack] job ${job.id} is missing ${missing.length} stored files: ${missing.map((m) => m.r2Key).join(", ")}`,
    );
    return refuse(
      request,
      job.id,
      "missing_files",
      "Some files in this pack are missing, so the full zip is not available. Download each channel on this page, or contact us and we will sort it out.",
      409,
    );
  }

  // The server side funnel (P18-02): a download, and the workspace's first.
  await recordFunnel({ workspaceId, name: "download", first: true, props: { kind: "zip" } }, db);

  const body = zipStream(
    [
      ...entries.map((entry) => ({ name: entry.name, source: entry.r2Key })),
      ...(inline.has("inline:report") ? [{ name: "compliance-report.json", source: "inline:report" }] : []),
      ...(inline.has("inline:ads") ? [{ name: ADS_CSV_NAME, source: "inline:ads" }] : []),
    ],
    async (source) => inline.has(source) ? Readable.from([inline.get(source)!]) : openObject(source),
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
