/**
 * Shared secret check for scheduled routes under /api/cron. The scheduler
 * (a Render cron job, or any cron service that can send a header) sends
 * CRON_SECRET as "Authorization: Bearer <secret>" or as "x-cron-secret".
 * Without CRON_SECRET the routes refuse every call (fail closed), so an
 * unconfigured deploy never exposes them. The comparison is constant time
 * over fixed length digests, so neither the value nor its length leaks.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { optionalEnv } from "@/lib/env";

export type CronAuth = "ok" | "unconfigured" | "denied";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The secret the request presented, or null. */
export function presentedCronSecret(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) {
      return match[1].trim();
    }
  }
  const header = headers.get("x-cron-secret");
  return header ? header.trim() : null;
}

export function checkCronAuth(headers: Headers, secret: string | undefined = optionalEnv("CRON_SECRET")): CronAuth {
  if (!secret) {
    return "unconfigured";
  }
  const presented = presentedCronSecret(headers);
  if (!presented) {
    return "denied";
  }
  return timingSafeEqual(digest(presented), digest(secret)) ? "ok" : "denied";
}
