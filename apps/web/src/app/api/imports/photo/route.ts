/**
 * POST /api/imports/photo
 * Downloads the photo a seller picked from an imported product and stores it
 * the way a browser upload is stored: in R2 under ws/{workspaceId}/src/, with
 * the same type, magic byte, 25 MB and 80 megapixel checks. The answer has
 * the same key, sha256 and kind the upload flow hands to POST /api/jobs, so
 * the pack writes its source_media row exactly as it does for an upload.
 * The download goes through the SSRF safe fetch. Without db mode or R2 it
 * answers 503 { error: <notice>, reason: "uploads_not_configured" }, like
 * /api/uploads/sign. Members only, never client seats, rate limited by IP
 * and by workspace; a cross site Origin is refused and the caller is
 * resolved before the (capped) body is read.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isR2Configured } from "@/lib/env";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { putSourceObject } from "@/lib/r2";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { isDbMode } from "@/lib/services";
import { importPhoto, type PhotoImportResult } from "@/lib/url-import/image";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEMO_IMPORTS_NOTICE =
  "Photo imports are off on this demo server, which has no database or file storage. Add a photo from your device instead.";
const R2_IMPORTS_NOTICE =
  "Photo imports need Cloudflare R2. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET_PRIVATE to enable them.";

const PhotoRequest = z.object({
  url: z.string().trim().min(1).max(2048),
});

const FAILURE_STATUS: Record<Extract<PhotoImportResult, { ok: false }>["reason"], number> = {
  invalid_url: 400,
  blocked_host: 400,
  not_image: 422,
  too_large: 422,
  timeout: 504,
  unreachable: 502,
};

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "imports.photo");
  if (ipLimited) {
    return ipLimited;
  }

  const resolved = await resolveSignedIn("Sign in to import a photo.", { ensure: true });
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  if (workspace.role === "client") {
    return NextResponse.json(
      { error: "Client seats can review assets but cannot upload files.", reason: "forbidden" },
      { status: 403 },
    );
  }

  const workspaceLimited = await limitByUser("imports.photo", `ws:${workspace.id}`);
  if (workspaceLimited) {
    return workspaceLimited;
  }

  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = PhotoRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick a photo to import.", reason: "invalid_url" }, { status: 400 });
  }

  // A demo workspace is shared by every visitor, so nothing is stored for
  // it, even when R2 happens to be configured.
  if (!isDbMode() || !isR2Configured()) {
    return NextResponse.json(
      { error: isDbMode() ? R2_IMPORTS_NOTICE : DEMO_IMPORTS_NOTICE, reason: "uploads_not_configured" },
      { status: 503 },
    );
  }

  const result = await importPhoto(parsed.data.url);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: FAILURE_STATUS[result.reason] });
  }
  const { photo } = result;
  let key: string;
  try {
    key = await putSourceObject(workspace.id, photo.body, photo.contentType);
  } catch (err) {
    console.error("[imports/photo] storing the imported photo failed", err);
    return NextResponse.json(
      { error: "We could not save that photo. Try again in a moment.", reason: "storage" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
  return NextResponse.json({
    key,
    sha256: photo.sha256,
    kind: "image",
    contentType: photo.contentType,
    bytes: photo.body.length,
    ...(photo.width && photo.height ? { width: photo.width, height: photo.height } : {}),
  });
}
