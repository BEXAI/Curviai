/**
 * POST /api/uploads/complete
 * Records an uploaded source file against a product after the presigned PUT
 * succeeds, closing the loop the sign route opens. Without this row the
 * worker has no images and Listing Mode refuses to start.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const CompleteRequest = z.object({
  productId: z.string().min(1),
  key: z.string().min(1).max(512),
  kind: z.enum(["image", "video"]),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
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
    // Typed reasons get their real status (Update.md 6.8).
    const status =
      result.reason === "forbidden" || result.reason === "foreign_key"
        ? 403
        : result.reason === "unknown_product"
          ? 404
          : result.reason === "conflict"
            ? 409
            : 400;
    return NextResponse.json({ error: result.notice }, { status });
  }
  return NextResponse.json({ ok: true, notice: result.notice });
}
