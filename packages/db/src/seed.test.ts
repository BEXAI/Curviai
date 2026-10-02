import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { loadRegistry } from "@curvi/specs";
import { createTestDb, type TestDb } from "./test-helpers";
import { loadChannelSpecs, loadDisposableEmailDomains, loadRecipes } from "./seed";
import type { Db } from "./client";
import { channelSpecs, disposableEmailDomains, recipes } from "./schema";

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

describe("loadChannelSpecs", () => {
  it("writes every registry spec", async () => {
    const written = await loadChannelSpecs(db as unknown as Db);
    expect(written).toBe(loadRegistry().specs.length);
    const rows = await db.select().from(channelSpecs);
    expect(rows).toHaveLength(loadRegistry().specs.length);
    const ids = rows.map((r) => r.id).sort();
    const registryIds = loadRegistry()
      .specs.map((s) => s.id)
      .sort();
    expect(ids).toEqual(registryIds);
  });

  it("is idempotent on a second run", async () => {
    const written = await loadChannelSpecs(db as unknown as Db);
    expect(written).toBe(loadRegistry().specs.length);
    const rows = await db.select().from(channelSpecs);
    expect(rows).toHaveLength(loadRegistry().specs.length);
    const [main] = await db
      .select()
      .from(channelSpecs)
      .where(eq(channelSpecs.id, "amazon.main"));
    expect(main.version).toBe(loadRegistry().version);
    expect((main.spec as { id?: string }).id).toBe("amazon.main");
  });
});

describe("loadRecipes", () => {
  const seedRows = [
    {
      key: "intake_normalizer",
      version: 1,
      stage: "intake",
      model: "model-a",
      body: { system: "normalize the intake" },
      active: true,
    },
    {
      key: "shot_planner",
      version: 1,
      stage: "planning",
      model: "model-b",
      body: { system: "plan the shots" },
      active: false,
    },
  ];

  it("inserts recipe seed rows", async () => {
    const written = await loadRecipes(db as unknown as Db, seedRows);
    expect(written).toBe(2);
    const rows = await db.select().from(recipes);
    expect(rows).toHaveLength(2);
    const intake = rows.find((r) => r.key === "intake_normalizer");
    expect(intake?.model).toBe("model-a");
    expect(intake?.trafficPct).toBe(100);
    expect(intake?.active).toBe(true);
  });

  it("upserts on key and version without duplicating", async () => {
    await loadRecipes(db as unknown as Db, [
      { ...seedRows[0], model: "model-a2", active: false },
    ]);
    const rows = await db.select().from(recipes);
    expect(rows).toHaveLength(2);
    const intake = rows.find((r) => r.key === "intake_normalizer");
    expect(intake?.model).toBe("model-a2");
    expect(intake?.active).toBe(false);
  });

  it("returns zero for an empty seed list", async () => {
    expect(await loadRecipes(db as unknown as Db, [])).toBe(0);
  });
});

describe("loadDisposableEmailDomains", () => {
  it("loads once, preserves existing timestamps and removes corrected domains", async () => {
    const initial = ["first.example", "removed.example", "second.example"];
    expect(await loadDisposableEmailDomains(db as unknown as Db, initial, { batchSize: 2 })).toBe(3);
    const before = await db.select().from(disposableEmailDomains).where(eq(disposableEmailDomains.domain, "first.example"));
    expect(await loadDisposableEmailDomains(db as unknown as Db, ["first.example", "second.example", "third.example"], { batchSize: 2 })).toBe(3);
    const after = await db.select().from(disposableEmailDomains).where(eq(disposableEmailDomains.domain, "first.example"));
    expect(after).toEqual(before);
    expect((await db.select().from(disposableEmailDomains)).map((row) => row.domain).sort()).toEqual(["first.example", "second.example", "third.example"]);
  });

  it("rejects empty and invalid snapshots without changing the old list", async () => {
    const before = await db.select().from(disposableEmailDomains);
    for (const list of [[], ["UPPER.example"], ["bad..example"], ["https://bad.example"]]) {
      await expect(loadDisposableEmailDomains(db as unknown as Db, list, { batchSize: 2 })).rejects.toThrow(/Disposable domain seed/);
    }
    expect(await db.select().from(disposableEmailDomains)).toEqual(before);
  });

  it("rolls back earlier chunks if a later chunk fails", async () => {
    const before = await db.select().from(disposableEmailDomains);
    await client.exec(`create function reject_domain_seed_fixture() returns trigger language plpgsql as $$ begin
      if new.domain = 'rollback.example' then raise exception 'fixture failure'; end if;
      return new; end $$;
      create trigger reject_domain_seed_fixture before insert on disposable_email_domains for each row execute function reject_domain_seed_fixture();`);
    try {
      await expect(loadDisposableEmailDomains(db as unknown as Db, ["new.example", "rollback.example"], { batchSize: 1 })).rejects.toThrow();
      expect(await db.select().from(disposableEmailDomains)).toEqual(before);
    } finally {
      await client.exec("drop trigger reject_domain_seed_fixture on disposable_email_domains; drop function reject_domain_seed_fixture()");
    }
  });
});
