/**
 * VISITS_HASH_KEY, the server only secret the visitor code is keyed with
 * (lib/visits/hash.ts). It is never stored in the database, so database
 * contents alone cannot recompute a code. Without a usable key the count is
 * off: the beacon route stores nothing and /app/ops/visitors says why.
 */

import { optionalEnv } from "@/lib/env";

/** Shortest key accepted, in characters; openssl rand -hex 32 gives 64. */
export const MIN_VISITS_HASH_KEY_LENGTH = 32;

let warned = false;

/** The key, trimmed, or null when it is unset or too short to be a secret. */
export function visitsHashKey(): string | null {
  const key = optionalEnv("VISITS_HASH_KEY")?.trim() ?? "";
  if (key.length === 0) {
    return null;
  }
  if (key.length < MIN_VISITS_HASH_KEY_LENGTH) {
    if (!warned) {
      warned = true;
      console.warn(
        JSON.stringify({
          msg: "visits: VISITS_HASH_KEY is shorter than 32 characters, so the count is off",
          length: key.length,
        }),
      );
    }
    return null;
  }
  return key;
}
