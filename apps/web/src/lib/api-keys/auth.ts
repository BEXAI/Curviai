/**
 * Authenticates a public API or MCP call by its workspace API key
 * (Authorization: Bearer cv_live_...). A key works while it is not revoked,
 * its workspace's plan includes API access (the seeded apiAccess feature),
 * the member who made it still belongs to the workspace, and it carries the
 * scope the call needs. Every refusal is the same plain 401 for a key that
 * does not exist or does not match, so a caller learns nothing about other
 * workspaces' keys. The answer is transport neutral: the v1 routes turn it
 * into JSON, the MCP route into a JSON-RPC error.
 */

import type { Services } from "@/lib/services/types";
import { DEMO_MODE_REFUSED_MESSAGE, DemoModeRefusedError } from "@/lib/services/demo-mode";
import { getApiKeyBackend, type ApiKeyBackend, type ApiPrincipal } from "./backend";
import { bearerKeyOf, keyMatchesHash, prefixOf, type ApiScope } from "./format";
import { checkApiAccess } from "./manage";

/** Seconds between last_used_at writes for one key, so a busy key does not
 * write a row on every call. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export interface ApiCaller {
  keyId: string;
  prefix: string;
  scopes: readonly string[];
  principal: ApiPrincipal;
  services: Services;
  /** The per user rate limit subject, shared with the web form, so a key
   * and its maker's browser draw on one allowance. */
  rateSubject: string;
}

export type ApiAuthReason =
  | "missing_key"
  | "invalid_key"
  | "revoked_key"
  | "upgrade_required"
  | "insufficient_scope"
  | "unavailable";

export interface ApiAuthError {
  status: 401 | 403 | 503;
  reason: ApiAuthReason;
  message: string;
}

export type ApiAuthResult = { ok: true; caller: ApiCaller } | { ok: false; error: ApiAuthError };

export const API_AUTH_COPY = {
  missing_key: "Send your Curvi API key as Authorization: Bearer <key>. Make one in Settings, API keys.",
  invalid_key: "That API key is not valid. Check it, or make a new one in Settings, API keys.",
  revoked_key: "That API key was revoked. Make a new one in Settings, API keys.",
  insufficient_scope: "That API key is not allowed to do this. Make a key with the right access in Settings, API keys.",
  unavailable: "We could not check that API key right now. Try again in a minute.",
} as const;

function refuse(status: ApiAuthError["status"], reason: ApiAuthReason, message: string): ApiAuthResult {
  return { ok: false, error: { status, reason, message } };
}

export interface AuthenticateOptions {
  backend?: ApiKeyBackend;
  now?: Date;
}

export async function authenticateApiKey(
  headers: Headers,
  scope: ApiScope | null,
  options: AuthenticateOptions = {},
): Promise<ApiAuthResult> {
  const key = bearerKeyOf(headers);
  if (!key) {
    return refuse(401, "missing_key", API_AUTH_COPY.missing_key);
  }
  const prefix = prefixOf(key);
  if (!prefix) {
    return refuse(401, "invalid_key", API_AUTH_COPY.invalid_key);
  }
  let backend: ApiKeyBackend;
  try {
    backend = options.backend ?? getApiKeyBackend();
  } catch (err) {
    if (err instanceof DemoModeRefusedError) {
      return refuse(503, "unavailable", DEMO_MODE_REFUSED_MESSAGE);
    }
    throw err;
  }
  if (!backend.acceptsPrefix(prefix)) {
    return refuse(401, "invalid_key", API_AUTH_COPY.invalid_key);
  }

  let principal: ApiPrincipal | null;
  let record;
  try {
    record = await backend.store.findByPrefix(prefix);
    if (!record || !keyMatchesHash(key, record.keyHash)) {
      return refuse(401, "invalid_key", API_AUTH_COPY.invalid_key);
    }
    if (record.revokedAt) {
      return refuse(401, "revoked_key", API_AUTH_COPY.revoked_key);
    }
    principal = await backend.principal(record);
  } catch (err) {
    console.error("[api-keys] key lookup failed", err);
    return refuse(503, "unavailable", API_AUTH_COPY.unavailable);
  }
  if (!principal) {
    // The member who made the key left the workspace (or the workspace is
    // gone): the key acts as that member, so it reaches nothing.
    return refuse(401, "invalid_key", API_AUTH_COPY.invalid_key);
  }
  const access = checkApiAccess(principal.plan);
  if (!access.ok) {
    return refuse(403, "upgrade_required", access.message);
  }
  if (scope && !record.scopes.includes(scope)) {
    return refuse(403, "insufficient_scope", API_AUTH_COPY.insufficient_scope);
  }

  const now = options.now ?? new Date();
  if (!record.lastUsedAt || now.getTime() - record.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
    const id = record.id;
    void backend.store.touch(id, now).catch((err: unknown) => {
      console.warn(`[api-keys] could not record the use of key ${id}`, err);
    });
  }

  return {
    ok: true,
    caller: {
      keyId: record.id,
      prefix: record.prefix,
      scopes: [...record.scopes],
      principal,
      services: backend.servicesFor(principal),
      rateSubject: `user:${principal.userId}`,
    },
  };
}
