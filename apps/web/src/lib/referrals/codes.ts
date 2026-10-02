/**
 * Invite codes (docs/phases/PHASE_18.md P18-24): the seeded number of lower
 * case base32 characters, which fits the ref landing parameter format
 * (lib/attribution.ts: 4 to 32 lower case letters and digits) and the
 * referral_codes check. Server side (node:crypto).
 */

import { randomBytes } from "node:crypto";
import { referralCodePolicy } from "@curvi/pipeline/seed";
import { cleanLandingValue } from "@/lib/attribution";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A fresh code. 256 is a multiple of 32, so each character is uniform. */
export function generateReferralCode(
  length: number = referralCodePolicy.length,
  random: (size: number) => Uint8Array = randomBytes,
): string {
  const bytes = random(length);
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += BASE32[bytes[i] & 31];
  }
  return code;
}

/** The code in a /r/<code> path or a ref parameter, cleaned, or null. */
export function cleanReferralCode(raw: unknown): string | null {
  return cleanLandingValue("ref", raw);
}

/** The shareable invite link for a code. */
export function referralLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/r/${code}`;
}

/** Where /r/<code> sends a visitor: the home page carrying the code, tagged
 * as referral traffic, so P18-01 carries ref onto the signup link. */
export function referralLandingPath(code: string): string {
  const params = new URLSearchParams({ ref: code, utm_source: "referral", utm_medium: "referral" });
  return `/?${params.toString()}`;
}
