/**
 * Turns one beacon from the site (components/visit-beacon.tsx) into a stored
 * page view: filters bots and prefetches, checks and cleans the payload,
 * hashes the client IP and user agent with the day's salt, and hands the row
 * to the store. The IP and the user agent never leave this function.
 */

import { z } from "zod";
import { clientIp } from "@/lib/rate-limit";
import { visitSkipReason, type VisitSkipReason } from "./bots";
import { utcDay, visitorHash } from "./hash";
import { cleanUtm, deviceClass, normalizePath, referrerHost } from "./normalize";
import type { VisitStore } from "./store";

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
  | { stored: false; reason: VisitSkipReason | "invalid" | "capped" | "no_store" };

export interface RecordVisitInput {
  headers: Headers;
  /** The beacon's raw body text. */
  body: string;
  /** The configured site host (siteUrl()), part of the hash. */
  siteHost: string;
  now: Date;
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
  if (!store) {
    return { stored: false, reason: "no_store" };
  }
  const userAgent = input.headers.get("user-agent")?.trim() ?? "";
  const requestHost = input.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? input.headers.get("host") ?? "";
  const day = utcDay(input.now);
  const salt = await store.saltFor(day);
  const stored = await store.record({
    day,
    visitorHash: visitorHash({ salt, host: input.siteHost, ip: clientIp(input.headers), userAgent }),
    path,
    referrerHost: referrerHost(parsed.data.referrer, [input.siteHost, requestHost]),
    utmSource: cleanUtm(parsed.data.utm_source),
    utmMedium: cleanUtm(parsed.data.utm_medium),
    utmCampaign: cleanUtm(parsed.data.utm_campaign),
    device: deviceClass(userAgent, input.headers.get("sec-ch-ua-mobile")),
  });
  return stored ? { stored: true } : { stored: false, reason: "capped" };
}
