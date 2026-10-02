import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { creditLedger, generationJobs, products, workspaces, sql, type Db } from "@curvi/db";
import { creditHistoryCsv, historyCursor, listCreditHistory } from "./history";
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
beforeAll(async () => { ({ db, client } = await createTestDb()); });
afterAll(async () => { await client.close(); });
describe("credit history", () => {
  it("groups holds, charges, releases and follow ups once per pack and keeps workspaces separate", async () => {
    const [ws, other] = await db.insert(workspaces).values([{ name: "History" }, { name: "Other" }]).returning();
    const [product] = await db.insert(products).values({ workspaceId: ws.id, title: "Mug", mode: "listing" }).returning();
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws.id, productId: product.id, status: "done", idempotencyKey: "history-pack" }).returning();
    await db.insert(creditLedger).values([
      { workspaceId: ws.id, delta: -10, reason: "reserve", jobId: job.id },
      { workspaceId: ws.id, delta: 10, reason: "release", jobId: job.id },
      { workspaceId: ws.id, delta: -8, reason: "charge", jobId: job.id },
      { workspaceId: ws.id, delta: 100, reason: "topup", note: "Top up 100" },
      { workspaceId: ws.id, delta: -100, reason: "refund" },
      { workspaceId: other.id, delta: 1000, reason: "grant" },
    ]);
    const page = await listCreditHistory(db as unknown as Db, ws.id);
    expect(page.entries).toHaveLength(3);
    expect(page.entries.find((e) => e.jobId === job.id)).toMatchObject({ credits: -8, label: "Pack for Mug", held: false });
    expect(page.entries.reduce((sum, e) => sum + e.credits, 0)).toBe(-8);
  });
  it("paginates complete grouped entries without repeating or losing rows", async () => {
    const [ws] = await db.insert(workspaces).values({ name: "Pages" }).returning();
    await db.insert(creditLedger).values(Array.from({ length: 53 }, (_, i) => ({ workspaceId: ws.id, reason: "topup" as const, delta: i + 1 })));
    await db.execute(sql`update credit_ledger set created_at = '2026-10-02T12:00:00.123456Z'::timestamptz where workspace_id = ${ws.id}::uuid`);
    const first = await listCreditHistory(db as unknown as Db, ws.id);
    const second = await listCreditHistory(db as unknown as Db, ws.id, first.nextCursor);
    expect(first.entries).toHaveLength(50);
    expect(second.entries).toHaveLength(3);
    expect(new Set([...first.entries, ...second.entries].map((e) => e.id)).size).toBe(53);
    expect(second.nextCursor).toBeNull();
  });
  it("keeps signed amounts numeric and neutralizes formulas in labels", () => {
    const csv = creditHistoryCsv([{ id: "test", at: "2026-10-02", credits: -8, label: "=SUM(A1)", jobId: null, held: false }]);
    expect(csv).toContain("'=SUM(A1),-8,Complete");
    expect(creditHistoryCsv([{ id: "test", at: "2026-10-02", credits: 2, label: "  =1+1", jobId: null, held: false }])).toContain("'  =1+1,2,Complete");
    expect(() => historyCursor("no!" )).toThrow("Invalid credit history cursor");
  });
});
