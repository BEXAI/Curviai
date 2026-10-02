import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { galleryItems, generationJobs, opsAlerts, packFeedback, products, shareLinks, signupGrants, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { economics, opsAlertPolicy } from "@curvi/pipeline/seed";
import { evaluateOpsAlerts, type OpsAlertNotification } from "./alerts";

const NOW = new Date("2026-10-15T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let workspaceId: string;
let productId: string;
const asDb = () => db as unknown as Db;
const sent: OpsAlertNotification[] = [];
const notify = vi.fn(async (item: OpsAlertNotification) => { sent.push(item); return true; });

beforeEach(async () => {
  ({ client, db } = await createTestDb());
  const [ws] = await db.insert(workspaces).values({ name: "Alerts", createdAt: ago(120) }).returning();
  workspaceId = ws.id;
  const [p] = await db.insert(products).values({ workspaceId, title: "Mug", mode: "listing" }).returning();
  productId = p.id;
  sent.length = 0; notify.mockClear();
});
afterEach(async () => { await client.close(); });

async function job(status: "done" | "failed" | "queued" | "generating", ageMinutes = 1, heartbeatAt: Date | null = null) {
  const [row] = await db.insert(generationJobs).values({ workspaceId, productId, status, createdAt: ago(ageMinutes), updatedAt: ago(ageMinutes), heartbeatAt }).returning();
  return row.id;
}

describe("operator alerts", () => {
  it("opens a failed pack once, deduplicates, resolves once and keeps history on recurrence", async () => {
    const id = await job("failed");
    expect(await evaluateOpsAlerts(asDb(), { now: NOW, notify })).toMatchObject({ opened: 1, notified: 1 });
    expect(await evaluateOpsAlerts(asDb(), { now: NOW, notify })).toMatchObject({ opened: 0, notified: 0 });
    await db.update(generationJobs).set({ status: "done" }).where(eq(generationJobs.id, id));
    expect(await evaluateOpsAlerts(asDb(), { now: NOW, notify })).toMatchObject({ resolved: 1, notified: 1 });
    expect(sent.map((item) => item.status)).toEqual(["open", "resolved"]);
    await evaluateOpsAlerts(asDb(), { now: NOW, notify });
    expect(sent).toHaveLength(2);
    await db.update(generationJobs).set({ status: "failed" }).where(eq(generationJobs.id, id));
    await evaluateOpsAlerts(asDb(), { now: NOW, notify });
    expect(await db.select().from(opsAlerts)).toHaveLength(2);
  });

  it("uses the seeded volume and failure-rate boundaries", async () => {
    for (let i = 0; i < opsAlertPolicy.minimumFinishedPacks - 1; i++) await job("done");
    await job("failed");
    await evaluateOpsAlerts(asDb(), { now: NOW, notify });
    expect(sent.map((item) => item.rule)).toEqual(["failure_rate"]);
  });

  it("finds stale heartbeats and queue waits without treating a fresh heartbeat as stale", async () => {
    const stale = await job("generating", opsAlertPolicy.staleHeartbeatMinutes + 1);
    const fresh = await job("generating", 40, NOW);
    const queued = await job("queued", opsAlertPolicy.queueWaitMinutes + 1, NOW);
    await evaluateOpsAlerts(asDb(), { now: NOW, notify });
    expect(sent.map((item) => [item.rule, item.subject])).toEqual(expect.arrayContaining([["stale_job", stale], ["queue_wait", queued]]));
    expect(sent.some((item) => item.subject === fresh)).toBe(false);
    expect(sent.some((item) => item.rule === "stale_job" && item.subject === queued)).toBe(false);
  });

  it("requires consecutive memory ticks and evaluates health, reconcile, caps and margin signals", async () => {
    for (let i = 1; i < opsAlertPolicy.memoryHighTicks; i++) {
      await evaluateOpsAlerts(asDb(), { now: NOW, notify, healthWarnings: ["memory_high"] });
      expect(sent).toHaveLength(0);
    }
    await evaluateOpsAlerts(asDb(), { now: NOW, notify, healthWarnings: ["memory_high", "db_size_high", "cron_overdue:backup", "restore_drill_overdue"], reconciledJobs: 1,
      workspaceCaps: [{ workspaceId, usedMicros: 100, limitMicros: 100 }], shotMargins: [{ shotType: "lifestyle", grossMargin: economics.minGrossMargin - 0.01 }] });
    expect(sent.map((item) => item.rule)).toEqual(expect.arrayContaining(["memory_high", "health_warning", "reconciled_jobs", "workspace_day_cap", "shot_margin"]));
    const before = (await db.select().from(opsAlerts).where(eq(opsAlerts.status, "open"))).length;
    await evaluateOpsAlerts(asDb(), { now: NOW, notify });
    expect((await db.select().from(opsAlerts).where(eq(opsAlerts.status, "open"))).length).toBe(before);
    await evaluateOpsAlerts(asDb(), { now: NOW, notify, healthWarnings: [], reconciledJobs: 0, workspaceCaps: [], shotMargins: [] });
    expect(await db.select().from(opsAlerts).where(eq(opsAlerts.status, "open"))).toEqual([]);
  });

  it("detects signup and withheld-grant bursts, a gallery submission and Not yet feedback", async () => {
    for (let i = 0; i < opsAlertPolicy.signupsPerHour; i++) await db.insert(workspaces).values({ name: "Signup fixture", createdAt: NOW });
    for (let i = 0; i < opsAlertPolicy.withheldGrantsPerDay; i++) await db.insert(signupGrants).values({ userId: `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`, workspaceId, withheldReason: "disposable_email", grantedAt: NOW });
    const jobId = await job("done");
    await db.insert(shareLinks).values({ slug: "gallery-alert-fixture", workspaceId, jobId, isPublic: true });
    await db.insert(galleryItems).values({ workspaceId, shareSlug: "gallery-alert-fixture", published: true, consentAt: NOW });
    await db.insert(packFeedback).values({ workspaceId, jobId, userId: "00000000-0000-4000-8000-000000000099", usable: "not_yet", createdAt: NOW });
    await evaluateOpsAlerts(asDb(), { now: NOW, notify });
    expect(sent.map((item) => item.rule)).toEqual(expect.arrayContaining(["signups_high", "withheld_grants_high", "gallery_submission", "pack_not_yet"]));
  });

  it("retries failed open and resolved deliveries with stable idempotency keys", async () => {
    const id = await job("failed");
    const attempts: OpsAlertNotification[] = [];
    const failing = async (item: OpsAlertNotification) => { attempts.push(item); return false; };
    expect(await evaluateOpsAlerts(asDb(), { now: NOW, notify: failing })).toMatchObject({ failedNotifications: 1 });
    await evaluateOpsAlerts(asDb(), { now: NOW, notify });
    expect(sent[0].idempotencyKey).toBe(attempts[0].idempotencyKey);
    await db.update(generationJobs).set({ status: "done" }).where(eq(generationJobs.id, id));
    await evaluateOpsAlerts(asDb(), { now: NOW, notify: failing });
    await evaluateOpsAlerts(asDb(), { now: NOW, notify });
    expect(sent[1].status).toBe("resolved");
    expect(sent[1].idempotencyKey).toBe(attempts[1].idempotencyKey);
  });
});
