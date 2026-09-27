/**
 * POST /api/uploads/sign
 * Validates the upload request (kind, content type, size caps) and returns a
 * presigned R2 PUT URL. Without R2 env it answers 503 with a setup notice so
 * the demo flow can fall back to the bundled demo photo.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isR2Configured } from "@/lib/env";
import { presignSourceUpload } from "@/lib/r2";
import { getServices } from "@/lib/services";
import { validateUploadRequest } from "@/lib/upload-validation";

export const dynamic = "force-dynamic";

const SignRequest = z.object({
  kind: z.enum(["image", "video"]),
  contentType: z.string().min(1),
  bytes: z.number().int().positive(),
});

export async function POST(request: Request): Promise<NextResponse> {
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
  const workspace = await services.getCurrentWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to upload." }, { status: 401 });
  }

  const presigned = await presignSourceUpload(workspace.id, parsed.data.contentType, parsed.data.bytes);
  return NextResponse.json({
    url: presigned.url,
    key: presigned.key,
    expiresInSeconds: presigned.expiresInSeconds,
  });
}
