/**
 * The prospect claim's runtime wiring for the auth callback and the share
 * page (docs/phases/PHASE_18.md P18-04). Db mode only; every entry point
 * here never throws and reads as "no prospect" on any failure, so a signup
 * or a share page never breaks because of a claim. Server only.
 */

import { isR2Configured } from "@/lib/env";
import { getObjectBytes, putGeneratedObject } from "@/lib/r2";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { redeemProspectClaimSafely, type ClaimStorage } from "./claim";
import { prospectViewForSlug, type ProspectShareView } from "./store";
import { cleanClaimToken } from "./token";

export function r2ClaimStorage(): ClaimStorage {
  return {
    get: (key) => getObjectBytes(key),
    put: (key, body, contentType) => putGeneratedObject(key, body, contentType),
  };
}

/**
 * The claim the auth callback redeems for a fresh signup whose signup link
 * carried a claim token (P18-04): null when there is none, without db mode
 * or storage, or when the claim is refused or fails.
 */
export async function claimSignupProspect(
  token: string | null | undefined,
  userId: string | null,
): Promise<{ productId: string } | null> {
  if (!token || !userId || !isDbMode() || !isR2Configured()) {
    return null;
  }
  try {
    return await redeemProspectClaimSafely(
      { db: getDb(), storage: r2ClaimStorage(), now: () => new Date() },
      { token, userId },
    );
  } catch (err) {
    console.error("[prospects] could not start the claim", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The prospect side of a public share page, or null (not a prospect pack,
 * demo mode, or a read failure). */
export async function loadProspectShareView(slug: string, rawToken: unknown): Promise<ProspectShareView | null> {
  if (!isDbMode()) {
    return null;
  }
  try {
    return await prospectViewForSlug(getDb(), {
      slug,
      token: cleanClaimToken(Array.isArray(rawToken) ? rawToken[0] : rawToken),
      now: new Date(),
    });
  } catch (err) {
    console.error("[prospects] could not read a share page's claim", err instanceof Error ? err.message : err);
    return null;
  }
}
