/**
 * Signed feedback links (docs/phases/PHASE_18.md P18-05): the day 2 email
 * (P18-07, Lane 3) links to /feedback/{token}, where the person answers for
 * one pack without signing in. The token names the pack, the person and an
 * expiry, and carries an HMAC SHA 256 over them under CURVI_LINK_SECRET,
 * bound to the "feedback" purpose so the same secret can sign other links
 * safely. Without the secret (or with one shorter than
 * MIN_LINK_SECRET_LENGTH) no link is issued and every token is refused, so
 * the email simply leaves the link out. Server only.
 *
 * Format: base64url("<job uuid>.<user uuid>.<expiry unix seconds>") + "." +
 * base64url(hmac). Nothing secret is inside; the server still checks that
 * the person is a member of the pack's workspace when the link is used.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { packFeedback } from "@curvi/pipeline/seed";
import { optionalEnv } from "@/lib/env";
import { isUuid } from "@/lib/validation/ids";

export const LINK_SECRET_ENV = "CURVI_LINK_SECRET";
/** A shorter secret is treated as unset. */
export const MIN_LINK_SECRET_LENGTH = 32;
const PURPOSE = "feedback";
const MAX_TOKEN_LENGTH = 256;

function linkSecret(secret?: string): string | null {
  const value = secret ?? optionalEnv(LINK_SECRET_ENV);
  return value && value.length >= MIN_LINK_SECRET_LENGTH ? value : null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${PURPOSE}:${payload}`).digest();
}

/** True when signed feedback links can be issued. */
export function feedbackLinksEnabled(secret?: string): boolean {
  return linkSecret(secret) !== null;
}

/** A token for one pack and person, valid for packFeedback.linkDays, or null
 * without a usable secret. */
export function feedbackLinkToken(
  input: { jobId: string; userId: string },
  options: { now?: Date; secret?: string } = {},
): string | null {
  const secret = linkSecret(options.secret);
  if (!secret || !isUuid(input.jobId) || !isUuid(input.userId)) {
    return null;
  }
  const now = options.now ?? new Date();
  const expires = Math.floor(now.getTime() / 1000) + packFeedback.linkDays * 24 * 60 * 60;
  const payload = `${input.jobId.toLowerCase()}.${input.userId.toLowerCase()}.${expires}`;
  return `${base64url(payload)}.${base64url(sign(payload, secret))}`;
}

/** The pack and person a token names, or null when it is malformed, forged
 * or expired, or links are off. Never throws. */
export function verifyFeedbackToken(
  token: string | null | undefined,
  options: { now?: Date; secret?: string } = {},
): { jobId: string; userId: string } | null {
  const secret = linkSecret(options.secret);
  if (!secret || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return null;
  }
  let payload: string;
  let mac: Buffer;
  try {
    payload = Buffer.from(parts[0], "base64url").toString("utf8");
    mac = Buffer.from(parts[1], "base64url");
  } catch {
    return null;
  }
  const expected = sign(payload, secret);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return null;
  }
  const [jobId, userId, expiresRaw, ...rest] = payload.split(".");
  const expires = Number(expiresRaw);
  if (rest.length > 0 || !isUuid(jobId) || !isUuid(userId) || !Number.isInteger(expires)) {
    return null;
  }
  const now = options.now ?? new Date();
  if (expires * 1000 <= now.getTime()) {
    return null;
  }
  return { jobId, userId };
}

/** The same origin path of a feedback link, or null when links are off. */
export function feedbackLinkPath(
  input: { jobId: string; userId: string },
  options: { now?: Date; secret?: string } = {},
): string | null {
  const token = feedbackLinkToken(input, options);
  return token ? `/feedback/${token}` : null;
}
