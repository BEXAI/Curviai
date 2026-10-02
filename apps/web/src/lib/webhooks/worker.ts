import { randomUUID } from "node:crypto";
import { sql, type Db } from "@curvi/db";
import { webhookPolicy } from "@curvi/pipeline/seed";
import type { SigningKey } from "@/lib/mcp-signing";
import { completionBody, type CompletionEvent } from "./contract";
import { openWebhookSecret, rewrapWebhookSecret, signWebhook, webhookKeys } from "./crypto";
import { rowsOf, type EndpointRow } from "./db-store";
import { deliverWebhook, WebhookTransportError, type DeliveryError, type WebhookTransport } from "./transport";

type ClaimedDelivery = { id: string; workspace_id: string; endpoint_id: string; endpoint_revision: number; event_id: string; attempts: number; lease_token: string; expires_at: Date; lease_expires_at: Date };
/** Claim one row, briefly; a crashed process's claim is recoverable. Attempts
 * increment at claim, so a crash cannot create unbounded retries. */
export async function claimWebhook(db: Db, now: Date): Promise<ClaimedDelivery | null> {
  return db.transaction(async tx => {
  await tx.execute(sql`select set_config('lock_timeout',${String(webhookPolicy.lockTimeoutMs)},true),set_config('statement_timeout',${String(webhookPolicy.databaseTimeoutMs)},true)`);
  const token = randomUUID();
  const [row] = rowsOf<ClaimedDelivery>(await tx.execute(sql`with candidate as (
    select d.id from webhook_deliveries d join webhook_endpoints e on e.id=d.endpoint_id and e.workspace_id=d.workspace_id
    where ((d.status='pending' and d.next_attempt_at<=${now.toISOString()}::timestamptz) or (d.status='leased' and d.lease_expires_at<=${now.toISOString()}::timestamptz))
      and d.expires_at>${now.toISOString()}::timestamptz and d.attempts<${webhookPolicy.maxAttempts}
      and e.enabled and e.verified_at is not null and e.revoked_at is null and e.revision=d.endpoint_revision
    order by d.next_attempt_at,d.id for update of d skip locked limit 1
  ) update webhook_deliveries d set status='leased',attempts=attempts+1,lease_token=${token}::uuid,
    lease_expires_at=${new Date(now.getTime() + webhookPolicy.leaseSeconds * 1000).toISOString()}::timestamptz,updated_at=${now.toISOString()}::timestamptz
    from candidate c where d.id=c.id returning d.*`));
  return row ?? null;
  });
}
/** Lock the endpoint while sending, then recheck the claim. Disable, rotation
 * and deletion wait for an in-flight bounded request and prevent all later
 * attempts. The endpoint lock always precedes the delivery lock here and in
 * management; it is never held by the short claim query. */
export async function sendClaimedWebhook(db: Db, claim: ClaimedDelivery, opts: { keys: readonly SigningKey[]; transport: WebhookTransport; clock?: () => Date; deadline?: Date }): Promise<"succeeded" | "failed" | "canceled"> {
  const clock = opts.clock ?? (() => new Date());
  const deadline = opts.deadline?.getTime() ?? clock().getTime() + webhookPolicy.totalTimeoutMs + 3 * webhookPolicy.databaseTimeoutMs;
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('lock_timeout',${String(webhookPolicy.lockTimeoutMs)},true),set_config('statement_timeout',${String(webhookPolicy.databaseTimeoutMs)},true)`);
    const [endpoint] = rowsOf<EndpointRow>(await tx.execute(sql`select * from webhook_endpoints where id=${claim.endpoint_id}::uuid and workspace_id=${claim.workspace_id}::uuid for no key update`));
    const [delivery] = rowsOf<ClaimedDelivery>(await tx.execute(sql`select * from webhook_deliveries where id=${claim.id}::uuid and workspace_id=${claim.workspace_id}::uuid and status='leased' and lease_token=${claim.lease_token}::uuid for update`));
    const now = clock();
    if (!delivery) return "canceled";
    if (new Date(delivery.lease_expires_at).getTime() <= now.getTime() || now.getTime() + webhookPolicy.totalTimeoutMs + webhookPolicy.databaseTimeoutMs >= deadline) return "canceled";
    if (!endpoint?.enabled || endpoint.revision !== delivery.endpoint_revision || !endpoint.verified_at || endpoint.revoked_at || new Date(delivery.expires_at).getTime() <= now.getTime()) {
      await tx.execute(sql`update webhook_deliveries set status='canceled',last_error='disabled',lease_token=null,lease_expires_at=null,updated_at=${now.toISOString()}::timestamptz where id=${claim.id}::uuid and lease_token=${claim.lease_token}::uuid`);
      return "canceled";
    }
    const [event] = rowsOf<{ id: string; workspace_id: string; job_id: string; logical_run_id: string; outcome: CompletionEvent["outcome"]; pack_status: CompletionEvent["packStatus"]; occurred_at: Date }>(await tx.execute(sql`select * from pack_completion_events where id=${delivery.event_id}::uuid and workspace_id=${claim.workspace_id}::uuid`));
    if (!event) return "canceled";
    const body = completionBody({ id: event.id, workspaceId: event.workspace_id, jobId: event.job_id, logicalRunId: event.logical_run_id, outcome: event.outcome, packStatus: event.pack_status, occurredAt: new Date(event.occurred_at) });
    const secret = openWebhookSecret(opts.keys, endpoint.workspace_id, endpoint.id, endpoint.encrypted_secret);
    let code: number | null = null; let error: DeliveryError | null = null;
    if (clock().getTime() + webhookPolicy.totalTimeoutMs + webhookPolicy.databaseTimeoutMs >= deadline) return "canceled";
    if (!secret) error = "key_unavailable";
    else {
      const rewrapped = rewrapWebhookSecret(opts.keys, endpoint.workspace_id, endpoint.id, endpoint.encrypted_secret);
      if (rewrapped && rewrapped !== endpoint.encrypted_secret) await tx.execute(sql`update webhook_endpoints set encrypted_secret=${rewrapped} where id=${endpoint.id}::uuid and revision=${endpoint.revision}`);
      const sendAt = clock();
      if (sendAt.getTime() + webhookPolicy.totalTimeoutMs + webhookPolicy.databaseTimeoutMs >= deadline || sendAt.getTime() >= new Date(delivery.lease_expires_at).getTime()) return "canceled";
      try {
        const result = await opts.transport(endpoint.url, body, { ...signWebhook(secret, endpoint.key_id, body, sendAt), "curvi-webhook-event-id": event.id });
        code = result.statusCode;
        if (code < 200 || code >= 300) error = "http_error";
      } catch (caught) { error = caught instanceof WebhookTransportError ? caught.code : "network_failed"; }
    }
    const finished = (opts.clock ?? (() => new Date()))();
    const status = !error ? "succeeded" : delivery.attempts >= webhookPolicy.maxAttempts ? "exhausted" : "pending";
    const delay = webhookPolicy.retryMinutes[Math.min(delivery.attempts - 1, webhookPolicy.retryMinutes.length - 1)];
    await tx.execute(sql`update webhook_deliveries set status=${status},last_status_code=${code},last_error=${error},next_attempt_at=${new Date(finished.getTime() + delay * 60_000).toISOString()}::timestamptz,
      lease_token=null,lease_expires_at=null,updated_at=${finished.toISOString()}::timestamptz where id=${claim.id}::uuid and lease_token=${claim.lease_token}::uuid`);
    return error ? "failed" : "succeeded";
  });
}
export async function runWebhookBatch(db: Db, opts: { deadline: Date; keys?: readonly SigningKey[] | null; transport?: WebhookTransport; clock?: () => Date }): Promise<{ attempted: number; succeeded: number; failed: number; configured: boolean }> {
  const keys = opts.keys === undefined ? webhookKeys() : opts.keys;
  const report = { attempted: 0, succeeded: 0, failed: 0, configured: !!keys?.length };
  const clock = opts.clock ?? (() => new Date());
  const start = clock(); const deadline = Math.min(opts.deadline.getTime(), start.getTime() + webhookPolicy.batchBudgetMs);
  if (start.getTime() + 2 * webhookPolicy.databaseTimeoutMs >= deadline) return report;
  // Expired or repeatedly crashed attempts terminate visibly, in bounded work.
  await db.transaction(async tx => {
  await tx.execute(sql`select set_config('lock_timeout',${String(webhookPolicy.lockTimeoutMs)},true),set_config('statement_timeout',${String(webhookPolicy.databaseTimeoutMs)},true)`);
  await tx.execute(sql`with disabled as (select d.id from webhook_deliveries d where d.status in ('pending','leased') and exists(select 1 from webhook_endpoints e where e.id=d.endpoint_id and (not e.enabled or e.verified_at is null or e.revoked_at is not null or e.revision<>d.endpoint_revision)) limit 100) update webhook_deliveries d set status='canceled',last_error='disabled',lease_token=null,lease_expires_at=null,updated_at=${start.toISOString()}::timestamptz from disabled x where d.id=x.id`);
  await tx.execute(sql`with expired as (select id from webhook_deliveries where status in ('pending','leased') and (expires_at<=${start.toISOString()}::timestamptz or (attempts>=${webhookPolicy.maxAttempts} and (status='pending' or lease_expires_at<=${start.toISOString()}::timestamptz))) order by expires_at limit 100)
    update webhook_deliveries d set status='exhausted',last_error='expired',lease_token=null,lease_expires_at=null,updated_at=${start.toISOString()}::timestamptz from expired e where d.id=e.id`);
  });
  if (!keys?.length) return report;
  for (let index = 0; index < webhookPolicy.batchSize; index += 1) {
    // Reserve the whole transport deadline before claiming; critical cron jobs
    // ran first and this bounded optional tail never starts without room.
    if (clock().getTime() + webhookPolicy.totalTimeoutMs + 3 * webhookPolicy.databaseTimeoutMs >= deadline) break;
    const claim = await claimWebhook(db, clock()); if (!claim) break;
    if (clock().getTime() + webhookPolicy.totalTimeoutMs + 2 * webhookPolicy.databaseTimeoutMs >= deadline) break;
    const result = await sendClaimedWebhook(db, claim, { keys, transport: opts.transport ?? deliverWebhook, clock, deadline: new Date(deadline) });
    report.attempted += 1;
    if (result === "succeeded") report.succeeded += 1;
    if (result === "failed") report.failed += 1;
  }
  return report;
}
