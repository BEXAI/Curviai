/**
 * The signed in member as an API key manager, for /app/settings/api and its
 * server actions: the session's workspace and role, the member's user id
 * (recorded as the key's creator, which is who the key acts as) and the
 * backend the keys live in.
 */

import { getServices, isDbMode } from "@/lib/services";
import { getSessionUser } from "@/lib/supabase/server";
import { DEMO_OWNER_ID, getApiKeyBackend } from "./backend";
import type { ApiKeyManager } from "./manage";
import type { ApiKeyStore } from "./store";

export type SessionManager =
  | { ok: true; manager: ApiKeyManager; store: ApiKeyStore; workspaceName: string; demo: boolean }
  | { ok: false; notice: string };

export async function sessionApiKeyManager(): Promise<SessionManager> {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return { ok: false, notice: "Sign in to manage API keys." };
  }
  const demo = !isDbMode();
  const userId = demo ? DEMO_OWNER_ID : ((await getSessionUser())?.id ?? null);
  if (!userId) {
    return { ok: false, notice: "Sign in to manage API keys." };
  }
  return {
    ok: true,
    manager: { workspaceId: workspace.id, plan: workspace.plan, role: workspace.role, userId },
    store: getApiKeyBackend().store,
    workspaceName: workspace.name,
    demo,
  };
}
