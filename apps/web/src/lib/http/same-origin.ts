/**
 * CSRF defense in depth for the signed in routes that change state. The
 * session cookie's SameSite setting already keeps it off most cross site
 * posts; this also refuses any request whose Origin header names another
 * site. A browser always sends Origin on a cross site POST, PUT or
 * DELETE, and page script cannot forge it.
 *
 * Allowed: the site origin (siteUrl()), and the host the request itself was
 * addressed to, so a preview host or a local port still works. A request
 * with no Origin at all (server to server, curl) is allowed, since the
 * session cookie is what a forged browser request would ride on and every
 * browser that sends it also sends Origin on these methods.
 *
 * Never apply this to webhooks, csp-report or cron: those are called by
 * other servers on purpose. POST /api/leads uses it too (P18-06 review):
 * only curvi.ai pages post there, and it records marketing consent.
 */

import { NextResponse } from "next/server";
import { siteUrl } from "@/lib/env";

export const CROSS_SITE_MESSAGE = "This request came from another site, so it was refused.";

function originOf(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** True when the request carries no Origin or one that belongs to this site. */
export function isSameOrigin(request: Request): boolean {
  const header = request.headers.get("origin");
  if (header === null) {
    return true;
  }
  const origin = originOf(header);
  if (!origin || (origin.protocol !== "https:" && origin.protocol !== "http:")) {
    // "null" (a sandboxed frame or a file) or anything unparseable.
    return false;
  }
  const site = originOf(siteUrl());
  if (site && site.origin === origin.origin) {
    return true;
  }
  const host = request.headers.get("host")?.toLowerCase();
  return host !== undefined && host === origin.host.toLowerCase();
}

/** A 403 when the Origin header names another site, else null. */
export function sameOriginOrRefuse(request: Request): NextResponse | null {
  if (isSameOrigin(request)) {
    return null;
  }
  return NextResponse.json({ error: CROSS_SITE_MESSAGE, reason: "cross_site" }, { status: 403 });
}
