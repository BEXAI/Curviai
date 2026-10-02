/**
 * POST /api/leads
 * Stores an email left on a free tool, which unlocks the tool's full
 * results, and whether the visitor ticked the marketing consent box
 * (PHASE_18 P18-06; unticked by default). No sign in. A post from another
 * site's page is refused (sameOriginOrRefuse; every form that posts here is
 * on curvi.ai), so no other site can enroll a visitor's address. Rate
 * limited by IP before anything else runs, and guarded by a honeypot field:
 * a filled honeypot gets the same success answer a person gets, so a bot
 * learns nothing, but nothing is stored.
 */

import { readBodyLimited } from "@/lib/http/read-body";
import { NextResponse } from "next/server";
import { recordFunnel } from "@/lib/funnel";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { getLeadStore } from "@/lib/leads";
import { limitByIp } from "@/lib/rate-limit";
import { isHoneypotTripped, LEAD_INVALID_EMAIL_MESSAGE, leadRequestSchema } from "@/lib/validation/lead";

export const dynamic = "force-dynamic";

/** Bodies larger than this are refused before parsing. */
const MAX_BODY_BYTES = 2048;

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "leads.create");
  if (ipLimited) {
    return ipLimited;
  }

  const read = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!read.ok && read.reason === "too_large") {
    return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(read.ok ? read.text : "");
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = leadRequestSchema.safeParse(body);
  if (!parsed.success) {
    const emailIssue = parsed.error.issues.some((issue) => issue.path[0] === "email");
    return NextResponse.json(
      { error: emailIssue ? LEAD_INVALID_EMAIL_MESSAGE : "Invalid request.", reason: "invalid" },
      { status: 400 },
    );
  }

  if (isHoneypotTripped(parsed.data)) {
    return NextResponse.json({ ok: true });
  }

  try {
    await getLeadStore().save(parsed.data.email, parsed.data.source, { marketingConsent: parsed.data.marketingConsent === true });
  } catch (err) {
    // The email itself is never logged.
    console.error("[leads] could not store a lead", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "We could not save that just now. Try again in a minute.", reason: "unavailable" },
      { status: 503 },
    );
  }
  // The server side funnel (P18-02): no workspace, never the email.
  await recordFunnel({ workspaceId: null, name: "lead_captured", props: { source: parsed.data.source } });
  return NextResponse.json({ ok: true });
}
