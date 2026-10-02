/**
 * The server side funnel's pack_done step (docs/phases/PHASE_18.md P18-02):
 * the runner store writes funnel.pack_done every time a pack reaches done,
 * and funnel.first_pack_done once per workspace. A state write that does
 * not apply (a settled job) and any other state write no funnel row.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { events, generationJobs, products, workspaces } from "@curvi/db/schema";
import { DbJobStore } from "./db-store";

let client: PGlite;
let db: TestDb;
let ws: string;
let productId: string;

async function newJob(status: "generating" | "failed" = "generating"): Promise<string> {
  const [j] = await db
    .insert(generationJobs)
    .values({ workspaceId: ws, productId, status, creditsCharged: 8 })
    .returning();
  return j.id;
}

async function funnelRows(): Promise<Array<{ name: string; props: Record<string, unknown> | null }>> {
  const rows = await db.select().from(events);
  return rows
    .filter((row) => row.name.startsWith("funnel."))
    .map((row) => ({ name: row.name, props: row.props ?? null }));
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Funnel" }).returning();
  ws = w.id;
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Candle", mode: "listing" }).returning();
  productId = p.id;
});

afterAll(async () => {
  await client.close();
});

describe("DbJobStore funnel steps", () => {
  it("writes pack_done with its counts, and the first row once", async () => {
    const store = new DbJobStore(db as unknown as Db);
    const first = await newJob();
    expect(await store.setJobState(first, "done", { passed: 6, needsReview: 1, costMicros: 2_000 })).toBe(true);
    const second = await newJob();
    expect(await store.setJobState(second, "done", { passed: 4, needsReview: 0 })).toBe(true);

    const rows = await funnelRows();
    expect(rows.filter((row) => row.name === "funnel.pack_done").map((row) => row.props)).toEqual([
      { job_id: first, passed: 6, needs_review: 1, credits: 8 },
      { job_id: second, passed: 4, needs_review: 0, credits: 8 },
    ]);
    expect(rows.filter((row) => row.name === "funnel.first_pack_done")).toHaveLength(1);
  });

  it("writes nothing for other states or a job that was already settled", async () => {
    const store = new DbJobStore(db as unknown as Db);
    const before = (await funnelRows()).length;
    const live = await newJob();
    await store.setJobState(live, "packaging");
    const settled = await newJob("failed");
    expect(await store.setJobState(settled, "done", { passed: 1 })).toBe(false);
    expect((await funnelRows()).length).toBe(before);
  });
});
