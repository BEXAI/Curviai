/**
 * POST /api/preview/[id]/full   body { email, website }
 * The full size file of a free preview (docs/phases/PHASE_18.md P18-12,
 * founder decision 6): the email is stored as a lead with source
 * free-preview, the preview row keeps only its sha256, and the answer is a
 * signed download link that lasts freePreview.fullSizeLinkSeconds. No sign
 * in. Same origin only, rate limited by IP like the other email gates, with
 * the honeypot: a filled one gets an ordinary answer and nothing is stored.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { recordFunnelEvent } from "@curvi/db";
import { FREE_PREVIEW_COPY } from "@/lib/free-preview/copy";
import { freePreviewDepsOrNull } from "@/lib/free-preview/deps";
import { unlockFullSize } from "@/lib/free-preview/service";
import { readBodyLimited } from "@/lib/http/read-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { LEAD_HONEYPOT_FIELD } from "@/lib/lead-sources";
import { limitByIp } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation/ids";
import { EMAIL_MAX_LENGTH } from "@/lib/validation/lead";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2048;

const Body = z.object({
  email: z.string().trim().toLowerCase().max(EMAIL_MAX_LENGTH).pipe(z.email()),
  marketingConsent: z.boolean().optional(),
  [LEAD_HONEYPOT_FIELD]: z.string().max(500).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "leads.create");
  if (ipLimited) {
    return ipLimited;
  }
  const deps = freePreviewDepsOrNull();
  if (!deps) {
    return NextResponse.json({ error: FREE_PREVIEW_COPY.closed }, { status: 503 });
  }
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: FREE_PREVIEW_COPY.expired }, { status: 404 });
  }
  const read = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ error: FREE_PREVIEW_COPY.emailInvalid }, { status: read.reason === "too_large" ? 413 : 400 });
  }
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(JSON.parse(read.text));
  } catch {
    return NextResponse.json({ error: FREE_PREVIEW_COPY.emailInvalid }, { status: 400 });
  }
  if (parsed[LEAD_HONEYPOT_FIELD]?.trim()) {
    return NextResponse.json({ ok: true });
  }
  let result;
  try {
    result = await unlockFullSize(deps, { previewId: id, email: parsed.email, marketingConsent: parsed.marketingConsent === true });
  } catch (err) {
    // The email itself is never logged.
    console.error("[free-preview] full size failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: FREE_PREVIEW_COPY.unavailable }, { status: 503 });
  }
  if (result.kind === "not_found") {
    return NextResponse.json({ error: FREE_PREVIEW_COPY.expired }, { status: 404 });
  }
  await recordFunnelEvent(deps.db, { workspaceId: null, name: "lead_captured", props: { source: "free-preview" } });
  return NextResponse.json({ ok: true, url: result.url });
}
