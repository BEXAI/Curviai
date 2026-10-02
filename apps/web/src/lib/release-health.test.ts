import { createTestDb, type TestDb } from "@curvi/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readReleaseHealthDetail } from "./service-health";

describe("fresh release health", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: TestDb;
  const now = () => new Date("2026-10-02T12:00:00Z");

  beforeAll(async () => {
    ({ client, db } = await createTestDb());
    await client.exec(`
      create schema drizzle;
      create table drizzle.__drizzle_migrations (created_at bigint);
      create temporary table generation_jobs (status text, runner_id text, started_at timestamptz);
      insert into drizzle.__drizzle_migrations values (1000);
      insert into generation_jobs values
        ('generating', 'instance-a', now()),
        ('qc', 'instance-b', now()),
        ('generating', null, null),
        ('generating', 'instance-a', null),
        ('queued', 'instance-b', now()),
        ('done', 'instance-a', now()),
        ('failed', null, null),
        ('canceled', 'instance-a', now());
    `);
  });
  afterAll(async () => client.close());

  it("counts started packs across instances and legacy active packs, excluding waiting followups and terminal rows", async () => {
    expect(await readReleaseHealthDetail(db, 2000, now)).toEqual({
      appliedWhen: 1000, runningPacks: 3, checkedAt: now().toISOString(),
    });
  });

  it("re-reads migrations and drain state on every call", async () => {
    await client.exec("insert into drizzle.__drizzle_migrations values (2000); update generation_jobs set status = 'done'");
    expect(await readReleaseHealthDetail(db, 2000, now)).toEqual({
      appliedWhen: 2000, runningPacks: 0, checkedAt: now().toISOString(),
    });
  });

  it("fails closed without leaking query errors or reporting a successful drain", async () => {
    const broken = { execute: async () => { throw new Error("private database detail"); } };
    expect(await readReleaseHealthDetail(broken, 20, now)).toEqual({
      appliedWhen: null, runningPacks: null, checkedAt: now().toISOString(),
    });
  });

  it("bounds slow queries and refuses malformed counts", async () => {
    expect((await readReleaseHealthDetail({ execute: () => new Promise(() => undefined) }, 5, now)).runningPacks).toBeNull();
    expect((await readReleaseHealthDetail({ execute: async () => [{ running: "NaN" }] }, 5, now)).runningPacks).toBeNull();
  });
});
