/**
 * POST /api/uploads/sign
 * Validates the upload request (kind, content type, size caps) and returns a
 * presigned R2 PUT URL. Without R2 env it answers 503 with a setup notice so
 * the demo flow can fall back to the bundled demo photo. Client seats cannot
 * mint uploads (plan 4.3), and signing is rate limited by IP and by user
 * because every URL lets the caller write to storage.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isR2Configured } from "@/lib/env";
import { presignSourceUpload } from "@/lib/r2";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { getServices } from "@/lib/services";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { validateUploadRequest } from "@/lib/upload-validation";

export const dynamic = "force-dynamic";

const SignRequest = z.object({
  kind: z.enum(["image", "video"]),
  contentType: z.string().min(1),
  bytes: z.number().int().positive(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ipLimited = await limitByIp(request, "uploads.sign");
  if (ipLimited) {
    return ipLimited;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = SignRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  const validation = validateUploadRequest(parsed.data);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }

  if (!isR2Configured()) {
    return NextResponse.json(
      {
        error: "uploads_not_configured",
        notice:
          "Uploads need Cloudflare R2. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET_PRIVATE to enable them.",
      },
      { status: 503 },
    );
  }

  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to upload.", { ensure: true });
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  if (workspace.role === "client") {
    return NextResponse.json(
      { error: "Client seats can review assets but cannot upload files." },
      { status: 403 },
    );
  }

  const userLimited = await limitByUser("uploads.sign", await userRateLimitSubject(workspace.id));
  if (userLimited) {
    return userLimited;
  }

  const presigned = await presignSourceUpload(workspace.id, parsed.data.contentType, parsed.data.bytes);
  return NextResponse.json({
    url: presigned.url,
    key: presigned.key,
    expiresInSeconds: presigned.expiresInSeconds,
  });
}
