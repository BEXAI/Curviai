/**
 * /api/email/unsubscribe (docs/phases/PHASE_18.md P18-06)
 *
 * POST: unsubscribes one address from marketing email. It takes the signed
 * token (lib links, CURVI_LINK_SECRET) from `?t=` (the List-Unsubscribe
 * header's URI) or from the body (`token` as JSON, or `t` or `token` as a
 * form field, which the unsubscribe page sends). The RFC 8058 one click POST
 * a mail app sends, body `List-Unsubscribe=One-Click` as multipart/form-data
 * or application/x-www-form-urlencoded, is accepted as it comes: no cookie,
 * no sign in, no redirect. Writes a `marketing` suppression for the token's
 * recipient key; transactional email keeps going. The token is the only
 * credential, so there is no origin check: a mail provider posts from its
 * own servers. 200 { ok }, 400 for a forged or missing token, 503 when the
 * list cannot be written.
 *
 * GET: a mail app that opens the header's URI in a browser lands on the
 * confirm page (303 to /email/unsubscribe), never on an unsubscribe a link
 * scanner could trigger.
 */

import { NextResponse } from "next/server";
import { verifyUnsubscribeToken } from "@curvi/email";
import { linkSecret } from "@/lib/email/config";
import { getSuppressionStore } from "@/lib/email/preferences";
import { readBodyLimited } from "@/lib/http/read-body";
import { publicOrigin } from "@/lib/http/public-origin";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;
const NO_STORE = { "cache-control": "no-store" };

async function tokenFromBody(request: Request): Promise<string | null> {
  const read = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!read.ok || read.text.length === 0) {
    return null;
  }
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (type.includes("application/json")) {
      const body = JSON.parse(read.text) as { token?: unknown; t?: unknown };
      const token = body.token ?? body.t;
      return typeof token === "string" ? token : null;
    }
    if (type.includes("multipart/form-data")) {
      const form = await new Response(read.text, { headers: { "content-type": type } }).formData();
      const token = form.get("token") ?? form.get("t");
      return typeof token === "string" ? token : null;
    }
    const form = new URLSearchParams(read.text);
    return form.get("token") ?? form.get("t");
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const fromQuery = new URL(request.url).searchParams.get("t");
  const token = fromQuery ?? (await tokenFromBody(request));
  const recipientKey = verifyUnsubscribeToken(linkSecret(), token);
  if (!recipientKey) {
    return NextResponse.json({ error: "This unsubscribe link is not valid." }, { status: 400, headers: NO_STORE });
  }
  try {
    await getSuppressionStore().add(recipientKey, "marketing", "unsubscribed");
  } catch (err) {
    console.error("[email] could not save an unsubscribe", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "We could not save that just now. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

export async function GET(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get("t");
  const page = new URL("/email/unsubscribe", publicOrigin(request));
  if (token) {
    page.searchParams.set("t", token.slice(0, 300));
  }
  return NextResponse.redirect(page, { status: 303, headers: NO_STORE });
}
