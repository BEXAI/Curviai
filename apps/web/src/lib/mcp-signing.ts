/**
 * HMAC signing shared by the two PHASE_19 signed values: the lasting preview
 * and download link tokens (P19-17, lib/mcp-links.ts on p19/files) and the
 * estimate quotes (P19-16, on p19/tools). Both use the MCP_LINK_KEYS ring,
 * each under its own purpose, so a link token can never pass as a quote or
 * the other way round. Wave 0 (P19-02) puts the ring here so both lanes
 * parse it the same way; each lane reads MCP_LINK_KEYS and documents it.
 *
 * MCP_LINK_KEYS is a comma separated list of kid:secret pairs. The first
 * pair is the newest and signs; every pair verifies. To rotate, put the new
 * pair first and keep the old one for 24 hours (the link lifetime).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SigningKey {
  kid: string;
  secret: string;
}

export type SigningPurpose = "link" | "quote";

/** Shortest secret accepted: 32 characters (at least 128 bits of entropy
 * when generated as hex or base64). */
export const MIN_SIGNING_SECRET_CHARS = 32;

const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class SigningKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningKeyConfigError";
  }
}

/**
 * The key ring from an MCP_LINK_KEYS value, newest first, or null when the
 * value is unset or blank. Throws SigningKeyConfigError (never echoing a
 * secret) on a malformed pair, a short secret or a repeated kid.
 */
export function parseSigningKeys(raw: string | undefined): SigningKey[] | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const keys: SigningKey[] = [];
  for (const [index, part] of raw.split(",").entries()) {
    const pair = part.trim();
    const colon = pair.indexOf(":");
    const kid = colon > 0 ? pair.slice(0, colon) : "";
    const secret = colon > 0 ? pair.slice(colon + 1) : "";
    if (!KID_PATTERN.test(kid)) {
      throw new SigningKeyConfigError(`MCP_LINK_KEYS pair ${index + 1} needs a kid of letters, digits, _ or -, then a colon.`);
    }
    if (secret.length < MIN_SIGNING_SECRET_CHARS) {
      throw new SigningKeyConfigError(
        `MCP_LINK_KEYS key ${kid} needs a secret of at least ${MIN_SIGNING_SECRET_CHARS} characters.`,
      );
    }
    if (keys.some((key) => key.kid === kid)) {
      throw new SigningKeyConfigError(`MCP_LINK_KEYS names key ${kid} twice.`);
    }
    keys.push({ kid, secret });
  }
  return keys;
}

function mac(purpose: SigningPurpose, secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(`curvi:${purpose}:`).update(payload).digest();
}

/** Signs a payload with the newest key: the kid that signed and the
 * base64url HMAC-SHA256 over the purpose and the payload. */
export function signPayload(
  keys: readonly SigningKey[],
  purpose: SigningPurpose,
  payload: string,
): { kid: string; signature: string } {
  const key = keys[0];
  if (!key) {
    throw new SigningKeyConfigError("MCP_LINK_KEYS has no key to sign with.");
  }
  return { kid: key.kid, signature: mac(purpose, key.secret, payload).toString("base64url") };
}

/** True when the signature was made by the named key for this purpose and
 * payload. Compared in constant time; an unknown kid is false. */
export function verifyPayload(
  keys: readonly SigningKey[],
  purpose: SigningPurpose,
  kid: string,
  payload: string,
  signature: string,
): boolean {
  const key = keys.find((candidate) => candidate.kid === kid);
  if (!key) {
    return false;
  }
  const expected = mac(purpose, key.secret, payload);
  const given = Buffer.from(signature, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
