import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "./test-helpers";
import { events } from "./schema";

let client: PGlite;
let db: TestDb;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

describe("migration 0003 webhook dedupe index", () => {
  it("claims a billing event name atomically: the duplicate loses on conflict", async () => {
    const name = "billing:stripe:evt_123";
    const first = await db.insert(events).values({ name }).onConflictDoNothing().returning({ id: events.id });
    expect(first).toHaveLength(1);
    const second = await db.insert(events).values({ name }).onConflictDoNothing().returning({ id: events.id });
    expect(second).toHaveLength(0);
  });

  it("rejects a direct duplicate billing insert", async () => {
    const name = "billing:shopify:evt_456";
    await db.insert(events).values({ name });
    await expect(db.insert(events).values({ name })).rejects.toThrow();
  });

  it("leaves ordinary analytics event names unconstrained", async () => {
    await db.insert(events).values({ name: "signed_up" });
    await db.insert(events).values({ name: "signed_up" });
    const rows = await db.select().from(events);
    expect(rows.filter((r) => r.name === "signed_up")).toHaveLength(2);
  });
});
