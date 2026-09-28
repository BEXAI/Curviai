/**
 * POST /api/uploads/sign
 * Validates the upload request (kind, content type, size caps) and returns a
 * presigned R2 PUT URL. Uploads need db mode and R2: without either it
 * answers 503 with reason uploads_not_configured and a plain notice as the
 * error, so the demo flow can fall back to the bundled demo photo. Client
 * seats cannot mint uploads (plan 4.3). A cross site Origin is refused, the
 * caller is resolved before the (capped) body is read, and signing is rate
 * limited by IP and by user because every URL lets the caller write to
 * storage. Every refusal is { error: <copy>, reason: <code> }.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isR2Configured } from "@/lib/env";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { presignSourceUpload } from "@/lib/r2";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { isDbMode } from "@/lib/services";
import { validateUploadRequest } from "@/lib/upload-validation";

export const dynamic = "force-dynamic";

const SignRequest = z.object({
  kind: z.enum(["image", "video"]),
  contentType: z.string().min(1).max(100),
  bytes: z.number().int().positive(),
});

const UPLOADS_NOT_CONFIGURED = "uploads_not_configured";

const DEMO_UPLOADS_NOTICE =
  "Uploads are off on this demo server, which has no database or file storage. The pack uses the demo photo instead.";
const R2_UPLOADS_NOTICE =
  "Uploads need Cloudflare R2. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET_PRIVATE to enable them.";

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "uploads.sign");
  if (ipLimited) {
    return ipLimited;
  }

  const resolved = await resolveSignedIn("Sign in to upload.", { ensure: true });
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

  const userLimited = await limitByUser("uploads.sign", await userRateLimitSubject(workspace.id));
  if (userLimited) {
    return userLimited;
  }

  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = SignRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", reason: "invalid_request", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  const validation = validateUploadRequest(parsed.data);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason, reason: "invalid_upload" }, { status: 400 });
  }

  // A demo workspace is shared by every visitor, so it never gets a real
  // storage key, even when R2 happens to be configured.
  if (!isDbMode() || !isR2Configured()) {
    return NextResponse.json(
      { error: isDbMode() ? R2_UPLOADS_NOTICE : DEMO_UPLOADS_NOTICE, reason: UPLOADS_NOT_CONFIGURED },
      { status: 503 },
    );
  }

  const presigned = await presignSourceUpload(workspace.id, parsed.data.contentType, parsed.data.bytes);
  return NextResponse.json({
    url: presigned.url,
    key: presigned.key,
    expiresInSeconds: presigned.expiresInSeconds,
  });
}
