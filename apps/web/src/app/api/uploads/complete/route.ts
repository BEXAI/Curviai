/**
 * POST /api/uploads/complete
 * Records an uploaded source file against a product after the presigned PUT
 * succeeds, closing the loop the sign route opens. Without this row the
 * worker has no images and Listing Mode refuses to start. The product id must
 * be a uuid (Update.md 4.7), the key must sit in this workspace's source
 * prefix, client seats cannot register uploads, and the route is rate limited
 * by IP and by user.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isWorkspaceSourceKey } from "@/lib/r2";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { getServices } from "@/lib/services";
import { uuidSchema } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

const CompleteRequest = z.object({
  productId: uuidSchema,
  key: z.string().min(1).max(512),
  kind: z.enum(["image", "video"]),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ipLimited = await limitByIp(request, "uploads.complete");
  if (ipLimited) {
    return ipLimited;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = CompleteRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const services = getServices();
  const workspace = await services.getCurrentWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to upload." }, { status: 401 });
  }
  if (workspace.role === "client") {
    return NextResponse.json({ error: "Client seats cannot upload product photos." }, { status: 403 });
  }
  if (!isWorkspaceSourceKey(workspace.id, parsed.data.key)) {
    return NextResponse.json({ error: "That upload does not belong to this workspace." }, { status: 403 });
  }

  const userLimited = await limitByUser("uploads.complete", await userRateLimitSubject(workspace.id));
  if (userLimited) {
    return userLimited;
  }

  const result = await services.registerSourceMedia(workspace.id, {
    productId: parsed.data.productId,
    r2Key: parsed.data.key,
    kind: parsed.data.kind,
    bytes: parsed.data.bytes,
    sha256: parsed.data.sha256,
    width: parsed.data.width,
    height: parsed.data.height,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.notice }, { status: 400 });
  }
  return NextResponse.json({ ok: true, notice: result.notice });
}
