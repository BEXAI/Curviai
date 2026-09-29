"use server";

import { revalidatePath } from "next/cache";
import { createApiKey, revokeApiKey, type CreateApiKeyResult, type RevokeApiKeyResult } from "@/lib/api-keys/manage";
import { sessionApiKeyManager } from "@/lib/api-keys/session";

/** Makes a key for the signed in owner or admin. The whole key is in the
 * answer once and is never stored or shown again. */
export async function createApiKeyAction(name: string, scopes?: string[]): Promise<CreateApiKeyResult> {
  const session = await sessionApiKeyManager();
  if (!session.ok) {
    return { ok: false, reason: "forbidden", notice: session.notice };
  }
  const result = await createApiKey(session.store, session.manager, {
    name: typeof name === "string" ? name : "",
    ...(Array.isArray(scopes) ? { scopes: scopes.filter((s): s is string => typeof s === "string") } : {}),
  });
  if (result.ok) {
    revalidatePath("/app/settings/api");
  }
  return result;
}

export async function revokeApiKeyAction(keyId: string): Promise<RevokeApiKeyResult> {
  const session = await sessionApiKeyManager();
  if (!session.ok) {
    return { ok: false, reason: "forbidden", notice: session.notice };
  }
  const result = await revokeApiKey(session.store, session.manager, typeof keyId === "string" ? keyId : "");
  if (result.ok) {
    revalidatePath("/app/settings/api");
  }
  return result;
}
