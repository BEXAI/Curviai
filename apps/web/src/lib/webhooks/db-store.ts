import { randomUUID } from "node:crypto";
import { sql, type Db } from "@curvi/db";
import { webhookPolicy } from "@curvi/pipeline/seed";
import type { SigningKey } from "@/lib/mcp-signing";
import { acceptsVerification, newWebhookKey, openWebhookSecret, rewrapWebhookSecret, sealWebhookSecret, signWebhook } from "./crypto";
import { webhookUrl, WebhookTransportError, type WebhookTransport } from "./transport";

export const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[];
export type WebhookActor = { workspaceId: string; userId: string; role: string };
export type WebhookActionResult = { ok: boolean; notice: string; secret?: string; keyId?: string };
export type EndpointRow = {
  id: string; workspace_id: string; name: string; url: string; enabled: boolean; verified_at: Date | null;
  revoked_at: Date | null; key_id: string; encrypted_secret: string; revision: number; verification_attempted_at: Date | null;
};
export type EndpointView = { id: string; name: string; url: string; enabled: boolean; verified: boolean; keyId: string };
export type DeliveryView = { id: string; endpointName: string; eventId: string; jobId: string; status: string; attempts: number; lastError: string | null; nextAttemptAt: string; expiresAt: string };
export const canManageWebhooks = (actor: WebhookActor) => actor.role === "owner" || actor.role === "admin";
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export async function currentManager(db: Db | Tx, actor: WebhookActor): Promise<boolean> {
  if (!canManageWebhooks(actor)) return false;
  return rowsOf(await db.execute(sql`select 1 from members where workspace_id=${actor.workspaceId}::uuid and user_id=${actor.userId}::uuid and role in ('owner','admin')`)).length === 1;
}
export async function listWebhooks(db: Db, actor: WebhookActor): Promise<{ endpoints: EndpointView[]; deliveries: DeliveryView[] }> {
  if (!await currentManager(db, actor)) return { endpoints: [], deliveries: [] };
  const endpoints = rowsOf<EndpointRow>(await db.execute(sql`select id, name,url,enabled,verified_at,key_id from webhook_endpoints where workspace_id=${actor.workspaceId}::uuid and revoked_at is null order by created_at`));
  const deliveries = rowsOf<{ id: string; name: string; event_id: string; job_id: string; status: string; attempts: number; last_error: string | null; next_attempt_at: Date; expires_at: Date }>(await db.execute(sql`
    select d.id,e.name,d.event_id,v.job_id,d.status,d.attempts,d.last_error,d.next_attempt_at,d.expires_at
    from webhook_deliveries d join webhook_endpoints e on e.id=d.endpoint_id and e.workspace_id=d.workspace_id
    join pack_completion_events v on v.id=d.event_id and v.workspace_id=d.workspace_id
    where d.workspace_id=${actor.workspaceId}::uuid order by d.created_at desc limit 30`));
  return { endpoints: endpoints.map(row => ({ id: row.id, name: row.name, url: row.url, enabled: row.enabled, verified: !!row.verified_at, keyId: row.key_id })),
    deliveries: deliveries.map(row => ({ id: row.id, endpointName: row.name, eventId: row.event_id, jobId: row.job_id, status: row.status, attempts: row.attempts, lastError: row.last_error, nextAttemptAt: new Date(row.next_attempt_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() })) };
}
export async function createWebhook(db: Db, actor: WebhookActor, input: { name: string; url: string }, keys: readonly SigningKey[]): Promise<WebhookActionResult> {
  if (!canManageWebhooks(actor)) return { ok: false, notice: "Only workspace owners and admins can manage webhooks." };
  const name = input.name.trim();
  if (!name || name.length > webhookPolicy.maxNameChars) return { ok: false, notice: "Enter a name of up to 80 characters." };
  let url: string;
  try { url = webhookUrl(input.url.trim()).toString(); } catch { return { ok: false, notice: "Use a public HTTPS hostname on port 443 with no credentials, query or fragment." }; }
  return db.transaction(async tx => {
    await tx.execute(sql`select 1 from workspaces where id=${actor.workspaceId}::uuid for update`);
    if (!await currentManager(tx, actor)) return { ok: false, notice: "Your workspace permission changed. Reload this page." };
    const count = rowsOf<{ count: number }>(await tx.execute(sql`select count(*)::int as count from webhook_endpoints where workspace_id=${actor.workspaceId}::uuid and revoked_at is null`))[0]?.count ?? 0;
    if (count >= webhookPolicy.maxEndpoints) return { ok: false, notice: "This workspace has reached its webhook endpoint limit." };
    const id = randomUUID(); const key = newWebhookKey();
    const encrypted = sealWebhookSecret(keys, actor.workspaceId, id, key.secret);
    await tx.execute(sql`insert into webhook_endpoints(id,workspace_id,created_by,name,url,key_id,encrypted_secret) values(${id}::uuid,${actor.workspaceId}::uuid,${actor.userId}::uuid,${name},${url},${key.keyId},${encrypted})`);
    return { ok: true, notice: "Endpoint saved and disabled. Save this signing secret now, configure your receiver, then verify and activate.", ...key };
  });
}
export async function changeWebhook(db: Db, actor: WebhookActor, id: string, action: "disable" | "delete" | "rotate", keys: readonly SigningKey[]): Promise<WebhookActionResult> {
  if (!validId(id) || !canManageWebhooks(actor)) return { ok: false, notice: "That endpoint is unavailable." };
  return db.transaction(async tx => {
    if (!await currentManager(tx, actor)) return { ok: false, notice: "Only workspace owners and admins can manage webhooks." };
    const [endpoint] = rowsOf<EndpointRow>(await tx.execute(sql`select * from webhook_endpoints where id=${id}::uuid and workspace_id=${actor.workspaceId}::uuid and revoked_at is null ${action === "delete" ? sql`for update` : sql`for no key update`}`));
    if (!endpoint) return { ok: false, notice: "That endpoint is unavailable." };
    await tx.execute(sql`update webhook_deliveries set status='canceled',last_error='disabled',lease_token=null,lease_expires_at=null,updated_at=now() where endpoint_id=${id}::uuid and workspace_id=${actor.workspaceId}::uuid and status in ('pending','leased')`);
    if (action === "delete") {
      await tx.execute(sql`delete from webhook_endpoints where id=${id}::uuid and workspace_id=${actor.workspaceId}::uuid`);
      return { ok: true, notice: "Endpoint and its delivery records deleted." };
    }
    if (action === "rotate") {
      const key = newWebhookKey(); const encrypted = sealWebhookSecret(keys, actor.workspaceId, id, key.secret);
      await tx.execute(sql`update webhook_endpoints set enabled=false,verified_at=null,key_id=${key.keyId},encrypted_secret=${encrypted},updated_at=now() where id=${id}::uuid and workspace_id=${actor.workspaceId}::uuid`);
      return { ok: true, notice: "Signing key replaced. Save the new secret and verify your receiver again before activation.", ...key };
    }
    await tx.execute(sql`update webhook_endpoints set enabled=false,updated_at=now() where id=${id}::uuid and workspace_id=${actor.workspaceId}::uuid`);
    return { ok: true, notice: "Endpoint disabled. Pending deliveries were canceled." };
  });
}
/** This explicit owner/admin action authorizes one signed verification request
 * and activation only after the receiver proves knowledge of the shown secret. */
export async function verifyAndEnableWebhook(db: Db, actor: WebhookActor, id: string, keys: readonly SigningKey[], transport: WebhookTransport, now = new Date()): Promise<WebhookActionResult> {
  if (!validId(id) || !canManageWebhooks(actor)) return { ok: false, notice: "That endpoint is unavailable." };
  return db.transaction(async tx => {
    if (!await currentManager(tx, actor)) return { ok: false, notice: "Only workspace owners and admins can manage webhooks." };
    const [endpoint] = rowsOf<EndpointRow>(await tx.execute(sql`select * from webhook_endpoints where id=${id}::uuid and workspace_id=${actor.workspaceId}::uuid and revoked_at is null for no key update`));
    if (!endpoint) return { ok: false, notice: "That endpoint is unavailable." };
    if (endpoint.enabled) return { ok: false, notice: "This receiver is already active. Disable it before verifying again." };
    if (endpoint.verification_attempted_at && now.getTime() - new Date(endpoint.verification_attempted_at).getTime() < webhookPolicy.verificationCooldownSeconds * 1000) return { ok: false, notice: "Wait one minute before trying receiver verification again." };
    await tx.execute(sql`update webhook_endpoints set verification_attempted_at=${now.toISOString()}::timestamptz where id=${id}::uuid`);
    const secret = openWebhookSecret(keys, actor.workspaceId, id, endpoint.encrypted_secret);
    if (!secret) return { ok: false, notice: "The signing key is unavailable. Delivery remains disabled." };
    const rewrapped = rewrapWebhookSecret(keys, actor.workspaceId, id, endpoint.encrypted_secret);
    if (rewrapped && rewrapped !== endpoint.encrypted_secret) await tx.execute(sql`update webhook_endpoints set encrypted_secret=${rewrapped} where id=${id}::uuid and revision=${endpoint.revision}`);
    const challenge = randomUUID();
    const body = JSON.stringify({ type: "webhook.verify", version: 1, challenge });
    try {
      const response = await transport(endpoint.url, body, signWebhook(secret, endpoint.key_id, body, now));
      if (response.statusCode < 200 || response.statusCode >= 300 || !acceptsVerification(secret, challenge, response.verification)) return { ok: false, notice: "Receiver verification failed. Return the documented signed challenge response." };
    } catch (error) { return { ok: false, notice: error instanceof WebhookTransportError && error.code === "unsafe_destination" ? "This destination is not a public HTTPS receiver." : "Receiver verification failed. Check its response and try again." }; }
    await tx.execute(sql`update webhook_endpoints set enabled=true,verified_at=${now.toISOString()}::timestamptz,updated_at=${now.toISOString()}::timestamptz where id=${id}::uuid`);
    return { ok: true, notice: "Receiver verified and activated for future pack runs." };
  });
}
export async function replayWebhook(db: Db, actor: WebhookActor, deliveryId: string, now = new Date()): Promise<WebhookActionResult> {
  if (!validId(deliveryId) || !canManageWebhooks(actor)) return { ok: false, notice: "That delivery is unavailable." };
  return db.transaction(async tx => {
    if (!await currentManager(tx, actor)) return { ok: false, notice: "That delivery is unavailable." };
    const [delivery] = rowsOf<{ endpoint_id: string }>(await tx.execute(sql`select endpoint_id from webhook_deliveries where id=${deliveryId}::uuid and workspace_id=${actor.workspaceId}::uuid`));
    if (!delivery) return { ok: false, notice: "That delivery is unavailable." };
    const [endpoint] = rowsOf<EndpointRow>(await tx.execute(sql`select * from webhook_endpoints where id=${delivery.endpoint_id}::uuid and workspace_id=${actor.workspaceId}::uuid for no key update`));
    if (!endpoint?.enabled || !endpoint.verified_at || endpoint.revoked_at) return { ok: false, notice: "Activate the receiver before replaying an event." };
    const updated = rowsOf(await tx.execute(sql`update webhook_deliveries set status='pending',attempts=0,replay_count=replay_count+1,endpoint_revision=${endpoint.revision},next_attempt_at=${now.toISOString()}::timestamptz,last_error=null,lease_token=null,lease_expires_at=null,updated_at=${now.toISOString()}::timestamptz
      where id=${deliveryId}::uuid and workspace_id=${actor.workspaceId}::uuid and status in ('succeeded','exhausted','canceled') and replay_count<${webhookPolicy.maxReplays} and expires_at>${now.toISOString()}::timestamptz returning id`));
    return updated.length ? { ok: true, notice: "Replay queued with the original event ID." } : { ok: false, notice: "Replay needs an unexpired event and an unused replay allowance." };
  });
}
