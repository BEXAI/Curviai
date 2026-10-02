/**
 * Claim tokens (docs/phases/PHASE_18.md P18-04): hex, carried as ?claim= on
 * the share page and the signup link (lib/attribution.ts accepts 16 to 64
 * lower case letters and digits), and stored only as their sha256
 * (pack_claims.token_hash). Server only.
 *
 * With CURVI_LINK_SECRET set (at least 32 characters, the same secret as
 * the feedback and unsubscribe links), a claim link's token is an HMAC of
 * the claim's id and its expiry under that secret, bound to the
 * "prospect-claim" purpose. The server can then rebuild the link it already
 * sent for the operator's outreach kit without storing the token and
 * without replacing it, while a database read alone still reveals no live
 * token. Without the secret the token is random and the kit can only show a
 * link at the moment it is made.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { prospectClaims } from "@curvi/pipeline/seed";
import { cleanLandingValue } from "@/lib/attribution";
import { optionalEnv } from "@/lib/env";

/** A shorter secret is treated as unset (as for the feedback links). */
const MIN_SECRET_LENGTH = 32;
const PURPOSE = "prospect-claim:v1";

function claimSecret(secret?: string | null): string | null {
  const value = secret === undefined ? optionalEnv("CURVI_LINK_SECRET") : secret;
  return value && value.length >= MIN_SECRET_LENGTH ? value : null;
}

/** The token a claim link with this id and expiry carries, or null without
 * a usable secret. Same inputs, same token. */
export function derivedClaimToken(claimId: string, expiresAt: Date, secret?: string | null): string | null {
  const key = claimSecret(secret);
  if (!key) {
    return null;
  }
  return createHmac("sha256", key)
    .update(`${PURPOSE}:${claimId.toLowerCase()}:${expiresAt.toISOString()}`)
    .digest("hex")
    .slice(0, prospectClaims.tokenBytes * 2);
}

/** A fresh claim token: prospectClaims.tokenBytes random bytes as hex. */
export function newClaimToken(): string {
  return randomBytes(prospectClaims.tokenBytes).toString("hex");
}

/** The token as links carry it, or null when it cannot be a claim token. */
export function cleanClaimToken(raw: unknown): string | null {
  return cleanLandingValue("claim", raw);
}

/** The stored form of a token: sha256 hex of the cleaned token. */
export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token.trim().toLowerCase()).digest("hex");
}
