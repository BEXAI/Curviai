/**
 * POST /api/jobs
 * Creates a generation job. Requires an Idempotency-Key header: a missing key
 * is a 400, a replay with the same body returns the original job, and a reuse
 * with a different body is a 409. Channels are validated against the spec
 * registry, productId is "new" or a uuid (Update.md 4.7), and every upload
 * key must sit in this workspace's source prefix (Update.md 4.6). Photo
 * roles, the SKU, box contents and comparison facts are validated against
 * the limits the planner prints with (@curvi/pipeline/seller-inputs). Rate
 * limited by IP and by user. Demo mode starts the in memory simulation; db
 * mode reserves credits through the reserve_credits SQL function.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { hasSpec } from "@curvi/specs";
import { InlineRunnerClosedError } from "@/lib/jobs/inline-runner";
import { isWorkspaceSourceKey } from "@/lib/r2";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { getServices } from "@/lib/services";
import { RESTARTING_MESSAGE } from "@/lib/services/errors";
import type { CreateJobResult } from "@/lib/services/types";
import { RETRY_AFTER_SECONDS, resolveWorkspace } from "@/lib/services/workspace-response";
import { productIdSchema } from "@/lib/validation/ids";
import { angleRoleSchema, sellerLinesSchema, skuSchema } from "@/lib/validation/seller-inputs";

export const dynamic = "force-dynamic";

const JobRequest = z.object({
  productId: productIdSchema,
  channels: z.array(z.string().min(1)).min(1).max(24),
  mode: z.enum(["listing", "concept"]),
  uploads: z
    .array(
      z.object({
        key: z.string().min(1).max(512),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        kind: z.enum(["image", "video"]),
        angle: angleRoleSchema.optional(),
      }),
    )
    .max(8)
    .optional(),
  newProductTitle: z.string().trim().min(1).max(120).optional(),
  userDescription: z.string().trim().max(2000).optional(),
  // Seller inputs saved on the product; the planner prints box contents and
  // comparison facts exactly as sent, so they are checked here first.
  sku: skuSchema.optional(),
  boxContents: sellerLinesSchema.optional(),
  comparisonFacts: sellerLinesSchema.optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ipLimited = await limitByIp(request, "jobs.create");
  if (ipLimited) {
    return ipLimited;
  }

  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "The Idempotency-Key header is required." },
      { status: 400 },
    );
  }
  if (idempotencyKey.length > 200) {
    return NextResponse.json(
      { error: "The Idempotency-Key header must be 200 characters or fewer." },
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
  // A signed in user whose workspace could not be set up gets a retryable
  // 503, never a "Sign in" 401 (Update.md 6.8).
  const resolved = await resolveWorkspace(services, "Sign in to create a pack.", { ensure: true });
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;

  const userLimited = await limitByUser("jobs.create", await userRateLimitSubject(workspace.id));
  if (userLimited) {
    return userLimited;
  }

  // Uploads must live under this workspace's own source prefix, the same
  // check the service applies, so a key is never dropped silently and turned
  // into a misleading "needs a real photo" rejection.
  const foreignKey = parsed.data.uploads?.find((u) => !isWorkspaceSourceKey(workspace.id, u.key));
  if (foreignKey) {
    return NextResponse.json({ error: "That upload does not belong to this workspace." }, { status: 403 });
  }

  let result: CreateJobResult;
  try {
    result = await services.createJob(workspace.id, {
      ...parsed.data,
      idempotencyKey,
    });
  } catch (err) {
    // createJob answers a draining instance itself; this covers any path
    // where the refusal still escapes, so it is a retryable 503, not a 500.
    if (err instanceof InlineRunnerClosedError) {
      return NextResponse.json(
        { error: RESTARTING_MESSAGE, reason: "unavailable" },
        { status: 503, headers: { "Retry-After": RETRY_AFTER_SECONDS } },
      );
    }
    throw err;
  }

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
    case "rejected": {
      const status = REJECTED_STATUS[result.reason];
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        status === 503 ? { status, headers: { "Retry-After": RETRY_AFTER_SECONDS } } : { status },
      );
    }
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
  mode_unavailable: 400,
} as const;
