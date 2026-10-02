/**
 * The free white main image before signup (docs/phases/PHASE_18.md P18-12).
 *
 * GET /api/preview   { available: boolean }, for the home page box.
 * POST /api/preview  multipart: photo (one image, at most freePreview.maxBytes)
 *                    and the honeypot field. No sign in.
 *
 * Checks in the plan's order before any work: set up (the env flag and its
 * services), the ops:free_preview_enabled switch, acquisition open (closed while
 * packs are paused), then one of this instance's preview places, the per
 * IP day cap (rate limiter, shared through Upstash) and the honeypot; the
 * service takes a site wide day slot, ingests the photo and runs the
 * preview. The place is taken before the body is read and held until the
 * answer, so at most maxConcurrentPerInstance anonymous uploads are ever
 * buffered at once, whatever the per IP cap lets through. Off unless the
 * deploy sets NEXT_PUBLIC_FREE_PREVIEW=1 with everything it needs.
 */

import { NextResponse } from "next/server";
import { freePreview } from "@curvi/pipeline/seed";
import { anonymousSpendCheck, anonymousSpendLimits } from "@/lib/anonymous-spend";
import { FREE_PREVIEW_COPY, PREVIEW_CHECK_LABELS, previewTooLargeLine } from "@/lib/free-preview/copy";
import { freePreviewDepsOrNull } from "@/lib/free-preview/deps";
import { enterPreviewRun, leavePreviewRun, previewGate, type PreviewClosedReason } from "@/lib/free-preview/gate";
import { createFreePreview } from "@/lib/free-preview/service";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { LEAD_HONEYPOT_FIELD } from "@/lib/lead-sources";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { turnstileMode } from "@/lib/turnstile";

export const dynamic = "force-dynamic";

/** Room for the multipart framing around the photo. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** The request body as bytes, or "too_large" once it passes maxBytes. */
async function readBytesLimited(request: Request, maxBytes: number): Promise<Buffer | "too_large"> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return "too_large";
  }
  if (!request.body) {
    return Buffer.alloc(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Every preview place of this instance is taken (seed maxConcurrentPerInstance). */
function busy(): NextResponse {
  return NextResponse.json(
    { status: "unavailable", error: FREE_PREVIEW_COPY.unavailable },
    { status: 503, headers: { "Retry-After": "30" } },
  );
}

function closed(reason: PreviewClosedReason): NextResponse {
  return NextResponse.json(
    { status: "closed", reason, error: reason === "daily_limit" ? FREE_PREVIEW_COPY.dailyLimit : FREE_PREVIEW_COPY.closed },
    { status: 503, headers: { "Retry-After": "600" } },
  );
}

export async function GET(): Promise<NextResponse> {
  const deps = freePreviewDepsOrNull();
  const gate = deps ? await previewGate(deps).catch(() => ({ open: false as const })) : { open: false as const };
  return NextResponse.json(
    { available: gate.open && turnstileMode() !== "misconfigured" },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  if (turnstileMode() === "misconfigured") return closed("not_set_up");
  const deps = freePreviewDepsOrNull();
  if (!deps) {
    return closed("not_set_up");
  }
  const gate = await previewGate(deps, { checkDay: false });
  if (!gate.open) {
    return closed(gate.reason);
  }

  // One of this instance's places, taken before the body is read and given
  // back on every answer. A busy instance answers before the per IP count,
  // so it does not use up a visitor's day.
  if (!enterPreviewRun()) {
    return busy();
  }
  try {
    return await previewInPlace(request, deps);
  } finally {
    leavePreviewRun();
  }
}

/** The rest of POST, run while holding one of this instance's places. */
async function previewInPlace(
  request: Request,
  deps: NonNullable<ReturnType<typeof freePreviewDepsOrNull>>,
): Promise<NextResponse> {
  // Per IP per UTC day (decision 6). Without an address there is no cap to
  // hold, so nothing runs.
  const ip = clientIp(request.headers);
  if (ip === "unknown") {
    return NextResponse.json({ status: "limited", error: FREE_PREVIEW_COPY.limitReached }, { status: 429 });
  }
  const decision = await checkRateLimit("preview.create", "ip", `ip:${ip}`);
  if (!decision.allowed || decision.limit - decision.remaining > anonymousSpendLimits().previewPerIpPerDay) {
    return NextResponse.json(
      { status: "limited", error: FREE_PREVIEW_COPY.limitReached },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
    );
  }

  // The body is read with a byte cap before it is parsed, so a chunked
  // upload with no or a false Content-Length cannot fill memory.
  const body = await readBytesLimited(request, freePreview.maxBytes + MULTIPART_OVERHEAD_BYTES);
  if (body === "too_large") {
    return NextResponse.json({ status: "refused", error: previewTooLargeLine() }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await new Response(new Blob([new Uint8Array(body)]), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return NextResponse.json({ status: "refused", error: FREE_PREVIEW_COPY.badRequest }, { status: 400 });
  }
  const photo = form.get("photo");
  if (!(photo instanceof Blob) || photo.size === 0) {
    return NextResponse.json({ status: "refused", error: FREE_PREVIEW_COPY.badRequest }, { status: 400 });
  }
  if (photo.size > freePreview.maxBytes) {
    return NextResponse.json({ status: "refused", error: previewTooLargeLine() }, { status: 413 });
  }
  const honeypot = form.get(LEAD_HONEYPOT_FIELD);
  if (typeof honeypot === "string" && honeypot.trim()) {
    // A bot gets an ordinary refusal and nothing runs or is counted.
    return NextResponse.json({ status: "blocked", error: FREE_PREVIEW_COPY.blocked }, { status: 422 });
  }

  const challenge = await anonymousSpendCheck(request, form.get("captchaToken"), "preview");
  if (challenge) return challenge;

  let result;
  try {
    result = await createFreePreview(deps, { bytes: Buffer.from(await photo.arrayBuffer()), ip });
  } catch (err) {
    console.error("[free-preview] preview failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ status: "unavailable", error: FREE_PREVIEW_COPY.unavailable }, { status: 503 });
  }
  switch (result.kind) {
    case "daily_limit":
      return closed("daily_limit");
    case "refused":
      return NextResponse.json({ status: "refused", error: result.message }, { status: 422 });
    case "done":
      return NextResponse.json({
        status: "done",
        previewId: result.previewId,
        preview: result.preview,
        checks: result.checks.map((check) => ({ ...check, label: PREVIEW_CHECK_LABELS[check.name] ?? check.name })),
        checksPass: result.checksPass,
        fillPct: result.fillPct,
        fidelity: result.fidelity,
      });
    default:
      return NextResponse.json(
        { status: result.kind, previewId: result.previewId, error: result.message },
        { status: result.kind === "unavailable" ? 503 : 422 },
      );
  }
}
