/**
 * Workspace API key format (PHASE_16 workstream 5). A key reads
 * cv_live_<12 hex>_<43 base64url>: the first two parts are the prefix,
 * stored in the clear, globally unique (api_keys_prefix_uq) and shown in
 * the key list so a seller can tell keys apart; the last part is 32 random
 * bytes. Only the sha256 hex of the whole key is stored (api_keys.key_hash),
 * so the key is shown once, when it is made, and never again. A plain hash
 * is enough here: the secret has 256 bits of entropy, so there is nothing to
 * guess from a leaked hash, and a lookup stays one indexed read.
 *
 * The cv_demo_ tag marks the fixed key of the in memory demo server; the
 * database backend refuses it, so it can never open a real workspace.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const LIVE_KEY_TAG = "cv_live_";
export const DEMO_KEY_TAG = "cv_demo_";

const KEY_PATTERN = /^(cv_(?:live|demo)_[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

/** What a key may do. A key made in settings gets all of them. */
export const API_SCOPES = ["packs:read", "packs:write", "checks"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  "packs:read": "Read packs and their files",
  "packs:write": "Start packs, which holds credits",
  checks: "Run the free main image check",
};

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export interface NewKeyMaterial {
  /** The whole key, shown once. */
  key: string;
  prefix: string;
  keyHash: string;
}

/** sha256 hex of the whole key. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(tag: string = LIVE_KEY_TAG): NewKeyMaterial {
  const prefix = `${tag}${randomBytes(6).toString("hex")}`;
  const key = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, keyHash: hashApiKey(key) };
}

/** The prefix of a well formed key, or null. */
export function prefixOf(key: string): string | null {
  const match = KEY_PATTERN.exec(key);
  return match ? (match[1] ?? null) : null;
}

/** Constant time comparison of the presented key against a stored hash. */
export function keyMatchesHash(key: string, keyHash: string): boolean {
  const presented = Buffer.from(hashApiKey(key), "hex");
  const stored = Buffer.from(keyHash, "hex");
  return presented.length === stored.length && presented.length > 0 && timingSafeEqual(presented, stored);
}

/** The key from an Authorization: Bearer header, or null. */
export function bearerKeyOf(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? (match[1] ?? null) : null;
}
