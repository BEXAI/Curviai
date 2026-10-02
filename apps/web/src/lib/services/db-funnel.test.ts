/**
 * DbService.createJob's funnel step (docs/phases/PHASE_18.md P18-02)
 * against the real migrations: every started pack writes funnel.pack_started
 * and the workspace's first once, with where it came from; a replay or a
 * refused pack writes nothing.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { creditLedger, events, members, products, signupGrants, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { DbService } from "./db";

vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: vi.fn(async () => "inline") }));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f018";
let ws: string;
let productId: string;

function service(): DbService {
  return new DbService({ db: db as unknown as Db, getUserId: async () => OWNER, getSupabase: async () => null });
}

async function funnelRows() {
  return (await db.select().from(events)).filter((row) => row.name.startsWith("funnel.") && row.workspaceId === ws);
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await db.insert(signupGrants).values({ userId: OWNER, credits: 0 });
  const [w] = await db.insert(workspaces).values({ name: "funnel ws", plan: "starter" }).returning();
  ws = w.id;
  await db.insert(members).values({ workspaceId: ws, userId: OWNER, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Candle", mode: "listing" }).returning();
  productId = p.id;
  await db.insert(sourceMedia).values({
    workspaceId: ws,
    productId,
    r2Key: `ws/${ws}/src/candle.jpg`,
    kind: "image",
    sha256: "b".repeat(64),
  });
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 200, reason: "grant", source: "system" });
});

afterAll(async () => {
  await client.close();
});

describe("createJob funnel step", () => {
  it("records each started pack and the first once, and nothing for a replay or a refusal", async () => {
    const first = { productId, channels: ["amazon.main"], mode: "listing" as const, idempotencyKey: "funnel-1" };
    expect((await service().createJob(ws, first)).outcome).toBe("created");
    expect((await service().createJob(ws, first)).outcome).toBe("replayed");
    expect((await service().createJob(ws, { ...first, idempotencyKey: "funnel-2", origin: "api" })).outcome).toBe("created");
    const refused = await service().createJob(ws, { ...first, idempotencyKey: "funnel-3", productId: "00000000-0000-4000-8000-000000000000" });
    expect(refused.outcome).toBe("rejected");

    const rows = await funnelRows();
    const started = rows.filter((row) => row.name === "funnel.pack_started");
    expect(started.map((row) => row.props)).toEqual([
      { channels: 1, bundle: expect.any(String), mode: "listing", from: "upload" },
      { channels: 1, bundle: expect.any(String), mode: "listing", from: "api" },
    ]);
    expect(rows.filter((row) => row.name === "funnel.first_pack_started")).toHaveLength(1);
  });
});
