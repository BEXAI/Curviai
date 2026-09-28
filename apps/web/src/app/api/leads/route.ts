/**
 * POST /api/leads
 * Stores an email left on a free tool, which unlocks the tool's full
 * results. No sign in. Rate limited by IP before anything else runs, and
 * guarded by a honeypot field: a filled honeypot gets the same success
 * answer a person gets, so a bot learns nothing, but nothing is stored.
 */

import { NextResponse } from "next/server";
import { getLeadStore } from "@/lib/leads";
import { limitByIp } from "@/lib/rate-limit";
import { isHoneypotTripped, LEAD_INVALID_EMAIL_MESSAGE, leadRequestSchema } from "@/lib/validation/lead";

export const dynamic = "force-dynamic";

/** Bodies larger than this are refused before parsing. */
const MAX_BODY_BYTES = 2048;

export async function POST(request: Request): Promise<NextResponse> {
  const ipLimited = await limitByIp(request, "leads.create");
  if (ipLimited) {
    return ipLimited;
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    body = JSON.parse(text);
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
    await getLeadStore().save(parsed.data.email, parsed.data.source);
  } catch (err) {
    // The email itself is never logged.
    console.error("[leads] could not store a lead", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "We could not save that just now. Try again in a minute.", reason: "unavailable" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
