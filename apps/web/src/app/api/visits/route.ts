/**
 * POST /api/visits
 * One page view from the site's own beacon (components/visit-beacon.tsx),
 * for the cookieless visitor count (lib/visits). No cookies are read or set
 * and no sign in is needed. Only requests from this site are counted; bots,
 * prefetches and requests with no user agent are ignored. The answer is
 * always an empty 204, quickly, whatever happened: the visitor never waits
 * on it and never sees an error from it.
 *
 * Bounds, so a script cannot flood the count or the database: at most
 * MAX_WRITES_IN_FLIGHT beacons per process are worked on at once (the rest
 * are answered at once and not counted), each IP gets 300 counted page views
 * and 30 new visitor codes an hour (lib/rate-limit.ts, visits.record and
 * visits.newVisitor), and the store caps each code and each day
 * (lib/visits/store.ts).
 */

import { siteUrl } from "@/lib/env";
import { readBodyLimited } from "@/lib/http/read-body";
import { isSameOrigin } from "@/lib/http/same-origin";
import { checkRateLimit, limitByIp } from "@/lib/rate-limit";
import { visitsHashKey } from "@/lib/visits/key";
import { recordVisit, VISIT_BODY_MAX_BYTES } from "@/lib/visits/record";
import { getVisitStore } from "@/lib/visits/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The longest the route waits on the database before answering anyway. */
const STORE_TIMEOUT_MS = 2500;

/**
 * Most beacons this process works on at once. The app's database pool has
 * 10 connections for every request and the health check (lib/services/db.ts)
 * and each beacon uses at most one at a time, so the count can never hold
 * more than 3 of them. A slot is freed when the work ends, not when the
 * route stops waiting on it, so a slow query keeps its slot.
 */
const MAX_WRITES_IN_FLIGHT = 3;
let writesInFlight = 0;

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

/** May this IP make another new visitor code this hour? */
async function allowNewVisitor(ip: string): Promise<boolean> {
  if (ip === "unknown") {
    // As in limitByIp: one shared bucket would let one caller lock out everyone.
    return true;
  }
  return (await checkRateLimit("visits.newVisitor", "ip", `ip:${ip}`)).allowed;
}

async function countVisit(request: Request, body: string): Promise<void> {
  if (await limitByIp(request, "visits.record")) {
    return;
  }
  await recordVisit(getVisitStore(), {
    headers: request.headers,
    body,
    siteHost: hostOf(siteUrl()),
    now: new Date(),
    hashKey: visitsHashKey(),
    allowNewVisitor,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!fromThisSite(request)) {
      return noContent();
    }
    const read = await readBodyLimited(request, VISIT_BODY_MAX_BYTES);
    if (!read.ok || writesInFlight >= MAX_WRITES_IN_FLIGHT) {
      return noContent();
    }
    writesInFlight += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = countVisit(request, read.text)
      .catch((error: unknown) => {
        console.error(JSON.stringify({ msg: "visits: page view not stored", error: String(error) }));
      })
      .finally(() => {
        writesInFlight -= 1;
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
