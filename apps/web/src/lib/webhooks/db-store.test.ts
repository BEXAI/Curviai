import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Db } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { generationJobs, members, products, workspaces } from "@curvi/db/schema";
import { webhookPolicy } from "@curvi/pipeline/seed";
import { openWebhookSecret, verificationResponse, verifyWebhook } from "./crypto";
import { changeWebhook, createWebhook, listWebhooks, replayWebhook, rowsOf, verifyAndEnableWebhook, type WebhookActor } from "./db-store";
import { claimWebhook, runWebhookBatch, sendClaimedWebhook } from "./worker";
import type { WebhookTransport } from "./transport";
let database: TestDb; let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: Db; let actor: WebhookActor;
const keys = [{ kid: "test", secret: "fixture-master-key-never-used-outside-tests" }];
const instant = new Date("2026-10-02T12:00:00Z");
let now: Date;
async function endpoint() {
  const created = await createWebhook(db, actor, { name: "Fixture receiver", url: "https://receiver.example/curvi" }, keys);
  expect(created.ok).toBe(true);
  const id = (await listWebhooks(db, actor)).endpoints.at(-1)!.id;
  return { id, secret: created.secret!, keyId: created.keyId! };
}
async function enabledEndpoint() {
  const saved = await endpoint();
  const result = await verifyAndEnableWebhook(db, actor, saved.id, keys, async (_url, body, headers) => {
    expect(verifyWebhook(saved.secret, saved.keyId, body, headers, now)).toBe(true);
    return { statusCode: 200, verification: verificationResponse(saved.secret, JSON.parse(body).challenge) };
  }, now);
  expect(result.ok).toBe(true);
  return saved;
}
async function terminalJob() {
  const [product] = await database.insert(products).values({ workspaceId: actor.workspaceId, title: "Fixture product", mode: "listing" }).returning();
  const [job] = await database.insert(generationJobs).values({ workspaceId: actor.workspaceId, productId: product.id }).returning();
  await db.execute(sql`update generation_jobs set status='done',finished_at=${now.toISOString()}::timestamptz where id=${job.id}::uuid`);
  // DB transaction clock is independent of this deterministic worker clock.
  await db.execute(sql`update webhook_deliveries set next_attempt_at=${now.toISOString()}::timestamptz,expires_at=${new Date(now.getTime()+webhookPolicy.deliveryHours*3_600_000).toISOString()}::timestamptz where workspace_id=${actor.workspaceId}::uuid`);
  return job;
}
async function deliveryRows() {
  return rowsOf<{ id: string; status: string; attempts: number; replay_count: number; event_id: string; lease_token: string | null; last_error: string | null }>(await db.execute(sql`select * from webhook_deliveries where workspace_id=${actor.workspaceId}::uuid order by created_at`));
}
beforeAll(async () => { ({ db: database, client } = await createTestDb()); db = database as unknown as Db; }, 30_000);
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  await database.delete(workspaces);
  now = new Date(instant);
  const userId = randomUUID();
  const [workspace] = await database.insert(workspaces).values({ name: "Webhook test" }).returning();
  await database.insert(members).values({ workspaceId: workspace.id, userId, role: "owner" });
  actor = { workspaceId: workspace.id, userId, role: "owner" };
});
describe("webhook management and durable delivery", () => {
  it("starts disabled, never exposes encrypted secrets in reads, enforces current owner/admin role and endpoint quota", async () => {
    const saved = await endpoint();
    const listed = await listWebhooks(db, actor);
    expect(listed.endpoints[0]).toMatchObject({ enabled: false, verified: false });
    expect(JSON.stringify(listed)).not.toContain(saved.secret);
    expect(JSON.stringify(listed)).not.toContain("encrypted");
    const transport = vi.fn<WebhookTransport>();
    const foreign = { ...actor, workspaceId: randomUUID() };
    expect((await verifyAndEnableWebhook(db, foreign, saved.id, keys, transport, now)).ok).toBe(false);
    expect((await changeWebhook(db, { ...actor, role: "editor" }, saved.id, "delete", keys)).ok).toBe(false);
    await endpoint(); await endpoint();
    expect((await createWebhook(db, actor, { name: "Fourth", url: "https://receiver.example/fourth" }, keys)).ok).toBe(false);
    await db.execute(sql`update members set role='editor' where workspace_id=${actor.workspaceId}::uuid`);
    expect((await changeWebhook(db, actor, saved.id, "delete", keys)).ok).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires proof of secret possession, caps verification retries and creates no delivery before activation", async () => {
    const saved = await endpoint();
    await terminalJob(); expect(await deliveryRows()).toEqual([]);
    const wrong = await verifyAndEnableWebhook(db, actor, saved.id, keys, async () => ({ statusCode: 200, verification: "0".repeat(64) }), now);
    expect(wrong.ok).toBe(false);
    expect((await listWebhooks(db, actor)).endpoints[0].enabled).toBe(false);
    const transport = vi.fn<WebhookTransport>();
    expect((await verifyAndEnableWebhook(db, actor, saved.id, keys, transport, now)).notice).toContain("Wait one minute");
    expect(transport).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 61_000);
    expect((await verifyAndEnableWebhook(db, actor, saved.id, keys, async (_url, body) => ({ statusCode: 204, verification: verificationResponse(saved.secret, JSON.parse(body).challenge) }), now)).ok).toBe(true);
    await terminalJob(); expect(await deliveryRows()).toHaveLength(1);
  });
  it("atomically persists events, gives concurrent claims one winner, and repeats a crashed delivery with a stable event ID", async () => {
    const saved = await enabledEndpoint(); await terminalJob();
    const claims = await Promise.all([claimWebhook(db, now), claimWebhook(db, now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    // Simulate a process crash after the receiver accepted but before DB acknowledgement.
    const firstBody: string[] = [];
    const transport: WebhookTransport = async (_url, body, headers) => {
      expect(verifyWebhook(saved.secret, saved.keyId, body, headers, now)).toBe(true);
      firstBody.push(body); return { statusCode: 204 };
    };
    // A lost response retries. The event was committed before either request.
    await sendClaimedWebhook(db, first, { keys, clock: () => now, transport: async (url, body, headers) => { await transport(url, body, headers); throw new Error("fixture response lost"); } });
    now = new Date(now.getTime() + 11 * 60_000);
    const second = await claimWebhook(db, now); expect(second).not.toBeNull();
    await sendClaimedWebhook(db, second!, { keys, clock: () => now, transport });
    expect(firstBody).toHaveLength(2); expect(firstBody[0]).toBe(firstBody[1]);
    expect((await deliveryRows())[0]).toMatchObject({ status: "succeeded", attempts: 2, lease_token: null });
  });
  it("stops disabled, deleted, rotated and expired claims before any transmission", async () => {
    const saved = await enabledEndpoint(); await terminalJob();
    const claim = (await claimWebhook(db, now))!;
    await changeWebhook(db, actor, saved.id, "disable", keys);
    const transport = vi.fn<WebhookTransport>();
    expect(await sendClaimedWebhook(db, claim, { keys, clock: () => now, transport })).toBe("canceled");
    expect((await deliveryRows())[0].status).toBe("canceled");
    now = new Date(now.getTime() + 61_000);
    await verifyAndEnableWebhook(db, actor, saved.id, keys, async (_url, body) => ({ statusCode: 200, verification: verificationResponse(saved.secret, JSON.parse(body).challenge) }), now);
    expect((await replayWebhook(db, actor, claim.id, now)).ok).toBe(true);
    const fresh = (await claimWebhook(db, now))!;
    const rotated = await changeWebhook(db, actor, saved.id, "rotate", keys);
    expect(rotated.secret).not.toBe(saved.secret);
    expect(await sendClaimedWebhook(db, fresh, { keys, clock: () => now, transport })).toBe("canceled");
    await changeWebhook(db, actor, saved.id, "delete", []);
    expect(await sendClaimedWebhook(db, fresh, { keys, clock: () => now, transport })).toBe("canceled");
    expect(transport).not.toHaveBeenCalled();
  });
  it("expires stale leases without signing configuration and stops starting work near the cron deadline", async () => {
    await enabledEndpoint(); await terminalJob();
    const claim = (await claimWebhook(db, now))!;
    const transport = vi.fn<WebhookTransport>();
    now = new Date(now.getTime() + 31_000);
    expect(await sendClaimedWebhook(db, claim, { keys, clock: () => now, transport })).toBe("canceled");
    await runWebhookBatch(db, { keys, transport, clock: () => now, deadline: new Date(now.getTime()+1000) });
    expect(transport).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 73 * 3_600_000);
    expect((await runWebhookBatch(db, { keys: null, transport, clock: () => now, deadline: new Date(now.getTime()+60_000) })).configured).toBe(false);
    expect((await deliveryRows())[0]).toMatchObject({ status: "exhausted", last_error: "expired" });
  });
  it("rechecks the clock after locks and cancels stale endpoint generations after reactivation", async () => {
    const saved = await enabledEndpoint(); await terminalJob();
    const claim = (await claimWebhook(db, now))!;
    const transport = vi.fn<WebhookTransport>();
    const delayed = new Date(now.getTime() + 31_000);
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValue(delayed);
    expect(await sendClaimedWebhook(db, claim, { keys, clock, transport })).toBe("canceled");
    expect(transport).not.toHaveBeenCalled();
    await changeWebhook(db, actor, saved.id, "disable", keys);
    now = new Date(now.getTime() + 61_000);
    await verifyAndEnableWebhook(db, actor, saved.id, keys, async (_url, body) => ({ statusCode: 204, verification: verificationResponse(saved.secret, JSON.parse(body).challenge) }), now);
    // Simulate a terminal snapshot that inserted just after a concurrent disable
    // canceled its then-visible deliveries. Its captured revision is still old.
    await db.execute(sql`update webhook_deliveries set status='pending',lease_token=null,lease_expires_at=null where id=${claim.id}::uuid`);
    expect(await claimWebhook(db, now)).toBeNull();
    await runWebhookBatch(db, { keys, clock: () => now, transport, deadline: new Date(now.getTime()+60_000) });
    expect((await deliveryRows())[0]).toMatchObject({ status: "canceled", last_error: "disabled" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("exhausts retry attempts visibly and allows only bounded explicit replay before expiry", async () => {
    await enabledEndpoint(); await terminalJob();
    const transport = vi.fn<WebhookTransport>(async () => ({ statusCode: 503 }));
    for (let attempt = 0; attempt < webhookPolicy.maxAttempts; attempt += 1) {
      const claim = (await claimWebhook(db, now))!; expect(claim).not.toBeNull();
      await sendClaimedWebhook(db, claim, { keys, clock: () => now, transport });
      now = new Date(now.getTime() + webhookPolicy.retryMinutes[attempt] * 60_000 + 1000);
    }
    const [delivery] = await deliveryRows();
    expect(delivery).toMatchObject({ status: "exhausted", attempts: 6, last_error: "http_error" });
    for (let replay = 0; replay < webhookPolicy.maxReplays; replay += 1) {
      expect((await replayWebhook(db, actor, delivery.id, now)).ok).toBe(true);
      const claim = (await claimWebhook(db, now))!;
      await sendClaimedWebhook(db, claim, { keys, clock: () => now, transport: async () => ({ statusCode: 204 }) });
      expect((await deliveryRows())[0].event_id).toBe(delivery.event_id);
    }
    expect((await replayWebhook(db, actor, delivery.id, now)).ok).toBe(false);
  });
  it("rewraps a retained old master during delivery, then accepts only the current receiver key after explicit rotation", async () => {
    const saved = await enabledEndpoint(); await terminalJob();
    const next = { kid: "next", secret: "fixture-next-master-not-a-live-credential" };
    const claim = (await claimWebhook(db, now))!;
    await sendClaimedWebhook(db, claim, { keys: [next,...keys], clock: () => now, transport: async () => ({ statusCode: 200 }) });
    const actual = rowsOf<{ encrypted_secret: string }>(await db.execute(sql`select encrypted_secret from webhook_endpoints where id=${saved.id}::uuid`))[0];
    expect(openWebhookSecret([next], actor.workspaceId, saved.id, actual.encrypted_secret)).toBe(saved.secret);
    const rotated = await changeWebhook(db, actor, saved.id, "rotate", [next]);
    now = new Date(now.getTime()+61_000);
    expect((await verifyAndEnableWebhook(db, actor, saved.id, [next], async (_url, body) => ({ statusCode: 200, verification: verificationResponse(saved.secret, JSON.parse(body).challenge) }), now)).ok).toBe(false);
    now = new Date(now.getTime()+61_000);
    expect((await verifyAndEnableWebhook(db, actor, saved.id, [next], async (_url, body) => ({ statusCode: 200, verification: verificationResponse(rotated.secret!, JSON.parse(body).challenge) }), now)).ok).toBe(true);
  });
});
