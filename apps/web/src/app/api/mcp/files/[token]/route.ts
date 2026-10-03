/**
 * GET /api/mcp/files/{token} (PHASE_19 P19-17)
 * A lasting download link an assistant shared from get_pack. After every
 * check in lib/mcp-links (signature, 24 hour expiry, the connection or key
 * still live, the member still in the workspace, the file still in the
 * pack), it redirects to a freshly signed 15 minute storage link that saves
 * the file under its name. The query string is never read (ChatGPT may
 * append ?redirectUrl=).
 */

import { getMcpLinkBackend } from "@/lib/mcp-links-backend";
import { checkMcpLink, linkRedirect, linkUnavailable } from "@/lib/mcp-links";
import { attachmentDisposition, presignDownload } from "@/lib/r2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  const check = await checkMcpLink(request, token, "file", { backend: getMcpLinkBackend });
  if (!check.ok) {
    return check.response;
  }
  if (check.file.kind === "report") {
    if (check.file.reportBody === undefined) return linkUnavailable();
    return new Response(check.file.reportBody, { headers: {
      "Content-Type": "application/json; charset=utf-8", "Content-Disposition": attachmentDisposition(check.file.filename),
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    } });
  }
  let location: string;
  try {
    location = await presignDownload(check.file.key, check.file.filename);
  } catch {
    console.warn("[mcp-links] signing a download failed");
    return linkUnavailable();
  }
  return linkRedirect(location);
}
