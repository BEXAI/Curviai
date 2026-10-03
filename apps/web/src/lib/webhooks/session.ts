import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";
import { webhookKeys } from "./crypto";
import { canManageWebhooks, type WebhookActor } from "./db-store";
export async function webhookSession() {
  const workspace = await getServices().ensureWorkspace();
  if (!workspace) return { ok: false as const, notice: "Sign in to manage webhooks." };
  if (!isDbMode()) return { ok: false as const, notice: "Webhook setup requires a connected workspace. This demo sends no requests." };
  const user = await getSessionUser();
  if (!user) return { ok: false as const, notice: "Sign in to manage webhooks." };
  const actor: WebhookActor = { workspaceId: workspace.id, userId: user.id, role: workspace.role };
  if (!canManageWebhooks(actor)) return { ok: false as const, notice: "Only workspace owners and admins can manage webhooks." };
  return { ok: true as const, actor, db: getDb(), keys: webhookKeys(), workspaceName: workspace.name };
}
