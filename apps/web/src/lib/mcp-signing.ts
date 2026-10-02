/**
 * Signing shared by the two PHASE_19 signed values: the lasting preview and
 * download link tokens (P19-17, lib/mcp-links.ts), sealed with AES-256-GCM so
 * their claims cannot be read, and the estimate quotes (P19-16), under an
 * HMAC. Both use the MCP_LINK_KEYS ring, each under its own purpose, so a
 * link token can never pass as a quote or the other way round. Wave 0
 * (P19-02) put the ring here so both parse it the same way.
 *
 * MCP_LINK_KEYS is a comma separated list of kid:secret pairs. The first
 * pair is the newest and signs; every pair verifies. To rotate, put the new
 * pair first. Keep old keys for at least 24 hours (the link lifetime) AND
 * until all persistent webhook secrets have been rewrapped under the newest
 * key. Webhook delivery/verification rewraps on read; inactive endpoints must
 * be verified, rotated or removed before their wrapping key can be retired.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export interface SigningKey {
  kid: string;
  secret: string;
}

export type SigningPurpose = "link" | "quote" | "webhook-secret";

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

// Sealing: AES-256-GCM under a key derived from the ring's secret, for a
// value whose contents must stay unreadable (the link tokens, whose claims
// hold internal ids and an expiry; OpenAI O6 and R12 keep those out of the
// chat). The kid stays in the clear for rotation and is bound by the
// associated data, so a sealed value cannot be moved to another key.

const SEAL_IV_BYTES = 12;
const SEAL_TAG_BYTES = 16;
const sealKeys = new Map<string, Buffer>();

function sealKey(purpose: SigningPurpose, secret: string): Buffer {
  const cacheKey = `${purpose}\u0000${secret}`;
  let key = sealKeys.get(cacheKey);
  if (key === undefined) {
    key = Buffer.from(hkdfSync("sha256", secret, "curvi:seal", `curvi:${purpose}:aes-256-gcm`, 32));
    if (sealKeys.size > 32) {
      sealKeys.clear();
    }
    sealKeys.set(cacheKey, key);
  }
  return key;
}

function sealAad(purpose: SigningPurpose, kid: string): Buffer {
  return Buffer.from(`curvi:${purpose}:${kid}`);
}

/** Seals a payload with the newest key: the kid, the base64url IV and the
 * base64url ciphertext with its 16 byte tag. Nothing of the payload can be
 * read without the secret, and any change fails to open. */
export function sealPayload(
  keys: readonly SigningKey[],
  purpose: SigningPurpose,
  payload: string,
): { kid: string; iv: string; sealed: string } {
  const key = keys[0];
  if (!key) {
    throw new SigningKeyConfigError("MCP_LINK_KEYS has no key to sign with.");
  }
  const iv = randomBytes(SEAL_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sealKey(purpose, key.secret), iv, { authTagLength: SEAL_TAG_BYTES });
  cipher.setAAD(sealAad(purpose, key.kid));
  const body = Buffer.concat([cipher.update(payload, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { kid: key.kid, iv: iv.toString("base64url"), sealed: body.toString("base64url") };
}

/** The payload a sealPayload call made with the named key for this purpose,
 * or null when the kid is unknown or anything was changed (the tag check). */
export function openPayload(
  keys: readonly SigningKey[],
  purpose: SigningPurpose,
  kid: string,
  iv: string,
  sealed: string,
): string | null {
  const key = keys.find((candidate) => candidate.kid === kid);
  if (!key) {
    return null;
  }
  const ivBytes = Buffer.from(iv, "base64url");
  const body = Buffer.from(sealed, "base64url");
  if (ivBytes.length !== SEAL_IV_BYTES || body.length <= SEAL_TAG_BYTES) {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(purpose, key.secret), ivBytes, {
      authTagLength: SEAL_TAG_BYTES,
    });
    decipher.setAAD(sealAad(purpose, kid));
    decipher.setAuthTag(body.subarray(body.length - SEAL_TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - SEAL_TAG_BYTES)), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
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
