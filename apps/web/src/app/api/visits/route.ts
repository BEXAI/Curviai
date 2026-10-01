/**
 * POST /api/visits
 * One page view from the site's own beacon (components/visit-beacon.tsx),
 * for the cookieless visitor count (lib/visits). No cookies are read or set
 * and no sign in is needed. Only requests from this site are counted; bots,
 * prefetches and requests with no user agent are ignored. The answer is
 * always an empty 204, quickly, whatever happened: the visitor never waits
 * on it and never sees an error from it.
 */

import { siteUrl } from "@/lib/env";
import { readBodyLimited } from "@/lib/http/read-body";
import { isSameOrigin } from "@/lib/http/same-origin";
import { recordVisit, VISIT_BODY_MAX_BYTES } from "@/lib/visits/record";
import { getVisitStore } from "@/lib/visits/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The longest the route waits on the database before answering anyway. */
const STORE_TIMEOUT_MS = 2500;

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/** A browser marks a request from another site; page script cannot change it. */
function fromThisSite(request: Request): boolean {
  if (!isSameOrigin(request)) {
    return false;
  }
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!fromThisSite(request)) {
      return noContent();
    }
    const read = await readBodyLimited(request, VISIT_BODY_MAX_BYTES);
    if (!read.ok) {
      return noContent();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = recordVisit(getVisitStore(), {
      headers: request.headers,
      body: read.text,
      siteHost: hostOf(siteUrl()),
      now: new Date(),
    }).catch((error: unknown) => {
      console.error(JSON.stringify({ msg: "visits: page view not stored", error: String(error) }));
    });
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STORE_TIMEOUT_MS);
    });
    await Promise.race([work, timeout]);
    clearTimeout(timer);
  } catch (error) {
    console.error(JSON.stringify({ msg: "visits: beacon failed", error: String(error) }));
  }
  return noContent();
}
