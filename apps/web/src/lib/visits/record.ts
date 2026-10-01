/**
 * Turns one beacon from the site (components/visit-beacon.tsx) into a stored
 * page view: filters bots and prefetches, checks and cleans the payload,
 * leaves out the operator pages, hashes the client IP and user agent with
 * the day's salt under VISITS_HASH_KEY, and hands the row to the store. The
 * IP and the user agent never leave this function, except that the IP is
 * the key of a short lived rate limit counter (lib/rate-limit.ts), the same
 * as on every other public route.
 */

import { z } from "zod";
import { clientIp } from "@/lib/rate-limit";
import { visitSkipReason, type VisitSkipReason } from "./bots";
import { utcDay, visitorHash } from "./hash";
import { cleanUtm, deviceClass, isExcludedPath, normalizePath, referrerHost } from "./normalize";
import type { RecordResult, VisitStore } from "./store";

/** Beacon bodies larger than this are dropped unread. */
export const VISIT_BODY_MAX_BYTES = 4096;

const beaconSchema = z.object({
  path: z.string().max(2048),
  referrer: z.string().max(2048).optional(),
  utm_source: z.string().max(500).optional(),
  utm_medium: z.string().max(500).optional(),
  utm_campaign: z.string().max(500).optional(),
});

export type RecordVisitOutcome =
  | { stored: true }
  | {
      stored: false;
      reason: VisitSkipReason | "invalid" | "excluded" | "no_store" | "no_key" | "new_visitor_limit" | Exclude<RecordResult, "stored">;
    };

export interface RecordVisitInput {
  headers: Headers;
  /** The beacon's raw body text. */
  body: string;
  /** The configured site host (siteUrl()), part of the hash. */
  siteHost: string;
  now: Date;
  /** VISITS_HASH_KEY (lib/visits/key.ts). Null means the count is off and nothing is stored. */
  hashKey: string | null;
  /**
   * Asked before the first page view of a visitor code this process has not
   * seen today, with the client IP. False drops the page view, so a script
   * that sends a new user agent on every request cannot make a new visitor
   * each time. Unset allows every new visitor.
   */
  allowNewVisitor?: (ip: string) => Promise<boolean>;
}

export async function recordVisit(store: VisitStore | null, input: RecordVisitInput): Promise<RecordVisitOutcome> {
  const skip = visitSkipReason(input.headers);
  if (skip) {
    return { stored: false, reason: skip };
  }
  let json: unknown;
  try {
    json = JSON.parse(input.body);
  } catch {
    return { stored: false, reason: "invalid" };
  }
  const parsed = beaconSchema.safeParse(json);
  if (!parsed.success) {
    return { stored: false, reason: "invalid" };
  }
  const path = normalizePath(parsed.data.path);
  if (!path) {
    return { stored: false, reason: "invalid" };
  }
  if (isExcludedPath(path)) {
    return { stored: false, reason: "excluded" };
  }
  if (!store) {
    return { stored: false, reason: "no_store" };
  }
  if (!input.hashKey) {
    return { stored: false, reason: "no_key" };
  }
  const userAgent = input.headers.get("user-agent")?.trim() ?? "";
  const requestHost = input.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? input.headers.get("host") ?? "";
  const ip = clientIp(input.headers);
  const day = utcDay(input.now);
  const salt = await store.saltFor(day);
  const hash = visitorHash({ key: input.hashKey, salt, host: input.siteHost, ip, userAgent });
  if (input.allowNewVisitor && !store.knows(day, hash) && !(await input.allowNewVisitor(ip))) {
    return { stored: false, reason: "new_visitor_limit" };
  }
  const result = await store.record({
    day,
    visitorHash: hash,
    path,
    referrerHost: referrerHost(parsed.data.referrer, [input.siteHost, requestHost]),
    utmSource: cleanUtm(parsed.data.utm_source),
    utmMedium: cleanUtm(parsed.data.utm_medium),
    utmCampaign: cleanUtm(parsed.data.utm_campaign),
    device: deviceClass(userAgent, input.headers.get("sec-ch-ua-mobile")),
  });
  return result === "stored" ? { stored: true } : { stored: false, reason: result };
}
