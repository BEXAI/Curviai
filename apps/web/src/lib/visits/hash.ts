/**
 * The daily visitor code of the cookieless count, in the way Plausible
 * documents it: sha256 over a random salt that changes every UTC day, the
 * site host, the client IP and the user agent, cut to its first 16 bytes.
 * One browser gets the same code all day, so it counts once a day however
 * many pages it opens, and nothing is stored on the device. The IP and the
 * user agent go into the hash and nowhere else. Once a day's salt is deleted
 * (lib/visits/store.ts keeps today's and yesterday's) nobody can recompute a
 * code of that day or link it to the same person on another day.
 */

import { createHash, randomBytes } from "node:crypto";

/** Longest user agent that goes into the hash; real ones are far shorter. */
export const MAX_USER_AGENT_LENGTH = 512;

/** The UTC day of an instant, as YYYY-MM-DD. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The UTC day a number of days before day (YYYY-MM-DD). */
export function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return utcDay(date);
}

/** 32 random bytes as 64 hex characters. */
export function newSalt(): string {
  return randomBytes(32).toString("hex");
}

export interface VisitorHashInput {
  salt: string;
  host: string;
  ip: string;
  userAgent: string;
}

/**
 * First 16 bytes, as 32 hex characters, of sha256(salt, host, IP, user
 * agent). The parts are joined with a newline, which no header value can
 * hold, so two different inputs can never run together into the same text.
 */
export function visitorHash(input: VisitorHashInput): string {
  return createHash("sha256")
    .update([input.salt, input.host.toLowerCase(), input.ip, input.userAgent.slice(0, MAX_USER_AGENT_LENGTH)].join("\n"))
    .digest("hex")
    .slice(0, 32);
}
