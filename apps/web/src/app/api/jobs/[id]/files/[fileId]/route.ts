/**
 * GET /api/jobs/:id/files/:fileId
 * Downloads one delivered file. Re-checks that the job and the file belong to
 * the caller's workspace, then redirects to a freshly signed R2 url that saves
 * the file under its channel file name. Download links on the page point
 * here, so they keep working however long the page stays open
 * (Update.md 6.6), and the browser saves the real name even though the
 * download attribute is ignored on cross origin links.
 */

import { NextResponse } from "next/server";
import { recordFunnel } from "@/lib/funnel";
import { resolveSignedIn } from "@/lib/http/services";
import { isUuid } from "@/lib/validation/ids";
import { attachmentDisposition } from "@/lib/r2";

export const dynamic = "force-dynamic";

const NOT_FOUND = "This file does not exist in your workspace.";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
): Promise<NextResponse> {
  const { id, fileId } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  const resolved = await resolveSignedIn("Sign in to download your files.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const { services } = resolved;
  const download = await services.getJobFileDownload(resolved.workspace.id, id, fileId, { report: "inline" });
  if (!download || (download.body === undefined && !download.url)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  // The server side funnel (P18-02): a download, and the workspace's first.
  await recordFunnel({ workspaceId: resolved.workspace.id, name: "download", first: true, props: { kind: "file" } });
  const response = download.body !== undefined
    ? new NextResponse(download.body, { headers: {
        "Content-Type": "application/json; charset=utf-8", "Content-Disposition": attachmentDisposition(download.filename),
        "X-Content-Type-Options": "nosniff",
      } })
    : NextResponse.redirect(download.url!, 302);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
