/**
 * POST /api/jobs
 * Creates a generation job. Requires an Idempotency-Key header: a missing key
 * is a 400, a replay with the same body returns the original job, and a reuse
 * with a different body is a 409. Channels are validated against the spec
 * registry. Demo mode starts the in memory simulation; db mode reserves
 * credits through the reserve_credits SQL function.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { hasSpec } from "@curvi/specs";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const JobRequest = z.object({
  productId: z.string().min(1),
  channels: z.array(z.string().min(1)).min(1).max(24),
  mode: z.enum(["listing", "concept"]),
  uploads: z
    .array(
      z.object({
        key: z.string().min(1).max(512),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        kind: z.enum(["image", "video"]),
      }),
    )
    .max(8)
    .optional(),
  newProductTitle: z.string().trim().min(1).max(120).optional(),
  userDescription: z.string().trim().max(2000).optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "The Idempotency-Key header is required." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = JobRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  const unknownChannels = parsed.data.channels.filter((c) => !hasSpec(c));
  if (unknownChannels.length > 0) {
    return NextResponse.json(
      { error: `Unknown channels: ${unknownChannels.join(", ")}.` },
      { status: 400 },
    );
  }

  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to create a pack." }, { status: 401 });
  }

  // Uploads must live under this workspace's own R2 prefix.
  const foreignKey = parsed.data.uploads?.find((u) => !u.key.startsWith(`ws/${workspace.id}/`));
  if (foreignKey) {
    return NextResponse.json({ error: "Upload key does not belong to this workspace." }, { status: 403 });
  }

  const result = await services.createJob(workspace.id, {
    ...parsed.data,
    idempotencyKey,
  });

  switch (result.outcome) {
    case "created":
      return NextResponse.json({ job: result.job }, { status: 201 });
    case "replayed":
      return NextResponse.json({ job: result.job, replayed: true }, { status: 200 });
    case "conflict":
      return NextResponse.json(
        {
          error: "This Idempotency-Key was already used with a different request.",
          existingJobId: result.existingJobId,
        },
        { status: 409 },
      );
    case "rejected":
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: REJECTED_STATUS[result.reason] },
      );
  }
}

const REJECTED_STATUS = {
  unknown_product: 404,
  role_forbidden: 403,
  needs_photo: 400,
  no_media: 400,
  insufficient_credits: 402,
  upgrade_required: 402,
  feature_unavailable: 422,
  unavailable: 503,
} as const;
