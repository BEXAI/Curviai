/**
 * Shared secret check for cron routes. The scheduler (a Render cron job, or
 * any external scheduler) sends CRON_SECRET as `Authorization: Bearer
 * <secret>` or as an `x-cron-secret` header. With CRON_SECRET unset the
 * routes answer 503 and do nothing, so a missing setting never leaves them
 * open. The compare is constant time.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { optionalEnv } from "@/lib/env";

export type CronAuth = "ok" | "not_configured" | "forbidden";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function presentedCronSecret(headers: Headers): string | null {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || headers.get("x-cron-secret")?.trim() || null;
}

export function checkCronSecret(headers: Headers, secret = optionalEnv("CRON_SECRET")): CronAuth {
  if (!secret) {
    return "not_configured";
  }
  const presented = presentedCronSecret(headers);
  if (!presented) {
    return "forbidden";
  }
  // Hashing first gives equal length buffers, so timingSafeEqual never
  // throws and the compare leaks nothing about the secret's length.
  return timingSafeEqual(digest(presented), digest(secret)) ? "ok" : "forbidden";
}
