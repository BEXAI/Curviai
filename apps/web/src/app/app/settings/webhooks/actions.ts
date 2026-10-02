"use server";
import { checkRateLimit, rateLimitMessage } from "@/lib/rate-limit";
import { revalidatePath } from "next/cache";
import { changeWebhook, createWebhook, replayWebhook, verifyAndEnableWebhook, type WebhookActionResult } from "@/lib/webhooks/db-store";
import { webhookSession } from "@/lib/webhooks/session";
import { deliverWebhook } from "@/lib/webhooks/transport";
export async function webhookAction(input: { action: string; id?: string; name?: string; url?: string }): Promise<WebhookActionResult> {
  if (!input || typeof input !== "object" || typeof input.action !== "string") return { ok: false, notice: "Choose a webhook action." };
  const session = await webhookSession();
  if (!session.ok) return { ok: false, notice: session.notice };
  if (!["disable", "delete"].includes(input.action) && !session.keys?.length) return { ok: false, notice: "Webhook signing is not configured. Endpoints remain disabled." };
  if (["create", "verify", "rotate", "replay"].includes(input.action)) {
    const userLimit = await checkRateLimit("webhooks.manage", "user", `webhooks:user:${session.actor.userId}`);
    if (!userLimit.allowed) return { ok: false, notice: rateLimitMessage(userLimit.retryAfterSeconds) };
    const workspaceLimit = await checkRateLimit("webhooks.manage", "workspace", `webhooks:workspace:${session.actor.workspaceId}`);
    if (!workspaceLimit.allowed) return { ok: false, notice: rateLimitMessage(workspaceLimit.retryAfterSeconds) };
  }
  let result: WebhookActionResult;
  const id = typeof input.id === "string" ? input.id : "";
  try {
  switch (input.action) {
    case "create": result = await createWebhook(session.db, session.actor, { name: typeof input.name === "string" ? input.name : "", url: typeof input.url === "string" ? input.url : "" }, session.keys!); break;
    case "verify": result = await verifyAndEnableWebhook(session.db, session.actor, id, session.keys!, deliverWebhook); break;
    case "disable": case "delete": case "rotate": result = await changeWebhook(session.db, session.actor, id, input.action, session.keys ?? []); break;
    case "replay": result = await replayWebhook(session.db, session.actor, id); break;
    default: return { ok: false, notice: "Choose a webhook action." };
  }
  } catch {
    // Database errors can include encrypted key material or receiver paths.
    // Keep provider/SQL exception text out of client errors and telemetry.
    return { ok: false, notice: "The webhook request could not finish. Reload and try again." };
  }
  revalidatePath("/app/settings/webhooks");
  return result;
}
