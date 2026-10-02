/**
 * Signed links (docs/phases/PHASE_18.md P18-06): an HMAC SHA-256 over a
 * purpose and a subject with CURVI_LINK_SECRET, no expiry. The unsubscribe
 * link signs the recipient key (never the address); P18-05's feedback links
 * and P18-12's download links can sign their own purpose with the same
 * secret, and a token for one purpose never verifies for another.
 *
 * Token: <purpose>.<subject>.<signature>, the signature base64url without
 * padding, so the whole token is safe in a URL query. Verification is
 * constant time.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { isRecipientKey } from "./keys";

const PURPOSE = /^[a-z][a-z0-9_]{0,31}$/;
const SUBJECT = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

/** Prefixed to every signed message, so a signature made for anything else
 * with the same secret never passes as a link. */
const DOMAIN = "curvi-link:v1";

/** The purpose of the unsubscribe link. */
export const UNSUBSCRIBE_PURPOSE = "unsub";

function signature(secret: string, purpose: string, subject: string): string {
  return createHmac("sha256", secret).update(`${DOMAIN}:${purpose}:${subject}`, "utf8").digest("base64url");
}

/** A token for one purpose and subject. Throws on an empty secret or a bad purpose or subject. */
export function signLink(secret: string, purpose: string, subject: string): string {
  if (!secret) {
    throw new Error("A link secret is required to sign a link.");
  }
  if (!PURPOSE.test(purpose) || !SUBJECT.test(subject)) {
    throw new Error("A link purpose or subject has characters a link cannot carry.");
  }
  return `${purpose}.${subject}.${signature(secret, purpose, subject)}`;
}

/** The subject of a token signed for this purpose with this secret, or null. */
export function verifyLink(secret: string | null | undefined, purpose: string, token: unknown): string | null {
  if (!secret || typeof token !== "string" || token.length > 220) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [tokenPurpose, subject, given] = parts;
  if (tokenPurpose !== purpose || !SUBJECT.test(subject) || !SIGNATURE.test(given)) {
    return null;
  }
  const expected = Buffer.from(signature(secret, purpose, subject), "base64url");
  const presented = Buffer.from(given, "base64url");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return null;
  }
  return subject;
}

/** The unsubscribe token for a recipient key. */
export function unsubscribeToken(secret: string, recipientKey: string): string {
  if (!isRecipientKey(recipientKey)) {
    throw new Error("An unsubscribe link signs a recipient key, never an address.");
  }
  return signLink(secret, UNSUBSCRIBE_PURPOSE, recipientKey);
}

/** The recipient key a valid unsubscribe token names, or null for a forged or broken one. */
export function verifyUnsubscribeToken(secret: string | null | undefined, token: unknown): string | null {
  const subject = verifyLink(secret, UNSUBSCRIBE_PURPOSE, token);
  return subject !== null && isRecipientKey(subject) ? subject : null;
}
