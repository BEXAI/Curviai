/**
 * POST /api/jobs
 * Creates a generation job. Requires an Idempotency-Key header: a missing key
 * is a 400, a replay with the same body returns the original job, and a reuse
 * with a different body is a 409. Channels are validated against the spec
 * registry, productId is "new" or a uuid (Update.md 4.7), and every upload
 * key must sit in this workspace's source prefix (Update.md 4.6). Photo
 * roles, the SKU, box contents and comparison facts are validated against
 * the limits the planner prints with (@curvi/pipeline/seller-inputs). Rate
 * limited by IP and by user. The caller is resolved before the body is
 * read, the body is capped (413), and a cross site Origin is refused. Demo
 * mode starts the in memory simulation; db
 * mode reserves credits through the reserve_credits SQL function.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { OutputOptionsInput } from "@curvi/pipeline/output-options";
import { SellerAnswerPicks } from "@curvi/pipeline/questions";
import { hasSpec } from "@curvi/specs";
import { InlineRunnerClosedError } from "@/lib/jobs/inline-runner";
import { isWorkspaceSourceKey } from "@/lib/r2";
import { JOB_BODY_MAX_BYTES, readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { RESTARTING_MESSAGE } from "@/lib/services/errors";
import type { CreateJobResult } from "@/lib/services/types";
import { RETRY_AFTER_SECONDS } from "@/lib/services/workspace-response";
import { productIdSchema } from "@/lib/validation/ids";
import { angleRoleSchema, sellerLinesSchema, skuSchema, targetBoxSchema } from "@/lib/validation/seller-inputs";

export const dynamic = "force-dynamic";

const JobRequest = z.object({
  productId: productIdSchema,
  channels: z.array(z.string().min(1).max(64)).min(1).max(24),
  mode: z.enum(["listing", "concept"]),
  uploads: z
    .array(
      z.object({
        key: z.string().min(1).max(512),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        kind: z.enum(["image", "video"]),
        angle: angleRoleSchema.optional(),
        // The product the seller tapped in the chooser at upload.
        targetBox: targetBoxSchema.optional(),
        // Background per photo (PHASE_15 P1): pack follows the pack's
        // switch; remove or keep overrides it for this photo only.
        background: z.enum(["pack", "remove", "keep"]).optional(),
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
  // The seller's output options (PHASE_15), strict: an unknown key, a bad
  // hex, a brand index out of range or a value only a later release honors
  // is a 400. The service resolves them against the brand kit, the plan and
  // the flags.
  outputOptions: OutputOptionsInput.optional(),
  // The question step's taps (PHASE_16 workstream 4): ids and values only.
  // The service resolves them against the questions stored for that upload,
  // so no label the client sends ever reaches the pack.
  sellerAnswers: z
    .object({
      key: z.string().min(1).max(512),
      picks: SellerAnswerPicks,
    })
    .optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
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

  // The caller is resolved before the body is read, so a signed out request
  // never gets as far as buffering one. A signed in user whose workspace
  // could not be set up gets a retryable 503, never a "Sign in" 401
  // (Update.md 6.8).
  const resolved = await resolveSignedIn("Sign in to create a pack.", { ensure: true });
  if ("response" in resolved) {
    return resolved.response;
  }
  const { services, workspace } = resolved;

  const userLimited = await limitByUser("jobs.create", await userRateLimitSubject(workspace.id));
  if (userLimited) {
    return userLimited;
  }

  const body = await readJsonCapped(request, JOB_BODY_MAX_BYTES);
  if (!body.ok) {
    return body.response;
  }
  const parsed = JobRequest.safeParse(body.data);
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
  invalid_upload: 422,
  invalid_options: 400,
} as const;
