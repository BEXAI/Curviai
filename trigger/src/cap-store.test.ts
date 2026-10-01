import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpendCaps, SPEND_CAPS } from "@curvi/ai";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { PgCapStore } from "./cap-store";

let created: Awaited<ReturnType<typeof createTestDb>>;
let store: PgCapStore;

beforeAll(async () => {
  created = await createTestDb();
  store = new PgCapStore(created.db as unknown as Db);
});

afterAll(async () => {
  await created.client.close();
});

describe("PgCapStore", () => {
  it("starts at zero and accumulates atomically per key", async () => {
    expect(await store.get("caps:test:a")).toBe(0);
    expect(await store.add("caps:test:a", 1_000)).toBe(1_000);
    expect(await store.add("caps:test:a", 250)).toBe(1_250);
    expect(await store.add("caps:test:a", -250)).toBe(1_000);
    expect(await store.get("caps:test:a")).toBe(1_000);
    expect(await store.get("caps:test:b")).toBe(0);
  });

  it("keeps every concurrent add", async () => {
    await Promise.all(Array.from({ length: 20 }, () => store.add("caps:test:concurrent", 5)));
    expect(await store.get("caps:test:concurrent")).toBe(100);
  });

  it("shares cap totals across separately built runtimes (every task run builds its own)", async () => {
    // Two Trigger.dev runs of the same pack: fresh SpendCaps objects, one table.
    const runA = new SpendCaps(store);
    const runB = new SpendCaps(store);
    const firstShot = await runA.checkAndReservePack("job-shared", SPEND_CAPS.perPackMicros - 1_000_000);
    expect(firstShot.allowed).toBe(true);

    const secondShot = await runB.checkAndReservePack("job-shared", 2_000_000);
    expect(secondShot.allowed).toBe(false);
    expect(await store.get("caps:pack:job-shared")).toBe(SPEND_CAPS.perPackMicros - 1_000_000);
  });

  it("holds the global daily hard stop across runs", async () => {
    const day = () => new Date("2026-09-28T12:00:00Z");
    const runA = new SpendCaps(store, day, { globalDailyHardStopMicros: 100_000 });
    const runB = new SpendCaps(store, day, { globalDailyHardStopMicros: 100_000 });
    expect((await runA.checkAndReserveGlobalDay(80_000)).allowed).toBe(true);
    expect((await runB.checkAndReserveGlobalDay(30_000)).allowed).toBe(false);
    expect((await runB.checkAndReserveGlobalDay(20_000)).allowed).toBe(true);
  });

  it("lets exactly one caller claim a one time key, across concurrent workers", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim("alerts:spend_alert:2026-09-28")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.claim("alerts:spend_alert:2026-09-28")).toBe(false);
    expect(await store.claim("alerts:hard_stop:2026-09-28")).toBe(true);
    // A claim never moves a spend total.
    expect(await store.get("caps:global:2026-09-28")).toBe(100_000);
  });

  it("gives a released key back to the next caller", async () => {
    expect(await store.claim("alerts:llm_quota:openai:2026-12-01T09")).toBe(true);
    await store.release("alerts:llm_quota:openai:2026-12-01T09");
    expect(await store.claim("alerts:llm_quota:openai:2026-12-01T09")).toBe(true);
    expect(await store.claim("alerts:llm_quota:openai:2026-12-01T09")).toBe(false);
  });
});
