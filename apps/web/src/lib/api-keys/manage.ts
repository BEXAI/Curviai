/**
 * API key management behind /app/settings/api (PHASE_16 workstream 5,
 * founder decision 5). The plan must include the seeded apiAccess feature
 * (Growth and up) and only owners and admins may list, make or revoke keys,
 * matching the api_keys RLS policies. A new key's secret is returned once,
 * from createApiKey, and is never readable again.
 */

import { canUse, lowestTierWith } from "@curvi/pipeline/seed";
import { tierKeyOf, tierName } from "@/lib/entitlements";
import type { WorkspaceRole } from "@/lib/services/types";
import { isUuid } from "@/lib/validation/ids";
import { API_SCOPES, generateApiKey, isApiScope, type ApiScope } from "./format";
import { apiKeyViewOf, type ApiKeyStore, type ApiKeyView } from "./store";

/** Active keys one workspace may hold at once. A guard, not a plan limit. */
export const MAX_ACTIVE_API_KEYS = 20;
export const API_KEY_NAME_MAX = 60;

export interface ApiKeyManager {
  workspaceId: string;
  plan: string;
  role: WorkspaceRole;
  /** The signed in member, recorded as the key's creator. */
  userId: string | null;
}

export type ApiAccessCheck = { ok: true } | { ok: false; reason: "upgrade_required"; message: string };

/** Whether the plan includes API access, with plain upgrade copy if not. */
export function checkApiAccess(plan: string | null | undefined): ApiAccessCheck {
  if (canUse(tierKeyOf(plan), "apiAccess")) {
    return { ok: true };
  }
  const tier = lowestTierWith("apiAccess");
  return {
    ok: false,
    reason: "upgrade_required",
    message: tier
      ? `API keys, the Curvi API and the MCP server come with the ${tierName(tier.key)} plan and above. Upgrade to use them.`
      : "API keys are not part of your plan.",
  };
}

export function canManageApiKeys(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export const API_KEY_COPY = {
  forbidden: "Only workspace owners and admins can manage API keys.",
  signedOut: "Sign in to manage API keys.",
  nameRequired: "Give the key a name, such as the tool that will use it.",
  tooMany: `A workspace can hold ${MAX_ACTIVE_API_KEYS} active keys. Revoke one you no longer use first.`,
  notFound: "That key does not exist in this workspace.",
  created: "Key created. Copy it now: it will not be shown again.",
  revoked: "Key revoked. Calls made with it now fail.",
  unavailable: "We could not save that right now. Try again in a minute.",
} as const;

export type ApiKeyListResult =
  | { ok: true; keys: ApiKeyView[] }
  | { ok: false; reason: "forbidden" | "upgrade_required"; notice: string };

export type CreateApiKeyResult =
  | { ok: true; key: string; view: ApiKeyView; notice: string }
  | { ok: false; reason: "forbidden" | "upgrade_required" | "invalid" | "too_many" | "unavailable"; notice: string };

export type RevokeApiKeyResult =
  | { ok: true; notice: string }
  | { ok: false; reason: "forbidden" | "not_found" | "unavailable"; notice: string };

function refusal(manager: ApiKeyManager): { reason: "forbidden" | "upgrade_required"; notice: string } | null {
  if (!canManageApiKeys(manager.role)) {
    return { reason: "forbidden", notice: API_KEY_COPY.forbidden };
  }
  const access = checkApiAccess(manager.plan);
  return access.ok ? null : { reason: access.reason, notice: access.message };
}

export async function listApiKeys(store: ApiKeyStore, manager: ApiKeyManager): Promise<ApiKeyListResult> {
  const refused = refusal(manager);
  if (refused) {
    return { ok: false, ...refused };
  }
  return { ok: true, keys: (await store.list(manager.workspaceId)).map(apiKeyViewOf) };
}

export async function createApiKey(
  store: ApiKeyStore,
  manager: ApiKeyManager,
  input: { name: string; scopes?: readonly string[] },
): Promise<CreateApiKeyResult> {
  const refused = refusal(manager);
  if (refused) {
    return { ok: false, ...refused };
  }
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, API_KEY_NAME_MAX);
  if (!name) {
    return { ok: false, reason: "invalid", notice: API_KEY_COPY.nameRequired };
  }
  const scopes: ApiScope[] = input.scopes
    ? [...new Set(input.scopes.filter(isApiScope))]
    : [...API_SCOPES];
  if (scopes.length === 0) {
    return { ok: false, reason: "invalid", notice: "Pick at least one thing the key may do." };
  }
  try {
    if ((await store.countActive(manager.workspaceId)) >= MAX_ACTIVE_API_KEYS) {
      return { ok: false, reason: "too_many", notice: API_KEY_COPY.tooMany };
    }
    const material = generateApiKey();
    const record = await store.create({
      workspaceId: manager.workspaceId,
      name,
      prefix: material.prefix,
      keyHash: material.keyHash,
      scopes,
      createdBy: manager.userId,
    });
    return { ok: true, key: material.key, view: apiKeyViewOf(record), notice: API_KEY_COPY.created };
  } catch (err) {
    console.error(`[api-keys] could not create a key in workspace ${manager.workspaceId}`, err);
    return { ok: false, reason: "unavailable", notice: API_KEY_COPY.unavailable };
  }
}

/** Revoking is allowed on any plan, so a workspace that moved down a plan
 * can still switch its old keys off. */
export async function revokeApiKey(
  store: ApiKeyStore,
  manager: ApiKeyManager,
  keyId: string,
  now: Date = new Date(),
): Promise<RevokeApiKeyResult> {
  if (!canManageApiKeys(manager.role)) {
    return { ok: false, reason: "forbidden", notice: API_KEY_COPY.forbidden };
  }
  if (!isUuid(keyId)) {
    return { ok: false, reason: "not_found", notice: API_KEY_COPY.notFound };
  }
  try {
    const found = await store.revoke(manager.workspaceId, keyId, now);
    return found
      ? { ok: true, notice: API_KEY_COPY.revoked }
      : { ok: false, reason: "not_found", notice: API_KEY_COPY.notFound };
  } catch (err) {
    console.error(`[api-keys] could not revoke key ${keyId} in workspace ${manager.workspaceId}`, err);
    return { ok: false, reason: "unavailable", notice: API_KEY_COPY.unavailable };
  }
}
