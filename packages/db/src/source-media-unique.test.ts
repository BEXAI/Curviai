import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./test-helpers";
import { products, shareLinks, sourceMedia, workspaces } from "./schema";

// Migration 0013 (Update.md 6.3): one source_media row per uploaded object.
// The dedupe step must keep the earliest row of each group, keep its links,
// and leave other workspaces and distinct keys untouched.

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "0013_source_media_unique.sql",
);

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let productA: string;
let productA2: string;
let productB: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  wsB = b.id;
  const [pa] = await db.insert(products).values({ workspaceId: wsA, title: "Mug", mode: "listing" }).returning();
  const [pa2] = await db.insert(products).values({ workspaceId: wsA, title: "Tray", mode: "listing" }).returning();
  const [pb] = await db.insert(products).values({ workspaceId: wsB, title: "Lamp", mode: "listing" }).returning();
  productA = pa.id;
  productA2 = pa2.id;
  productB = pb.id;
});

afterAll(async () => {
  await client.close();
});

function key(ws: string, name: string): string {
  return `ws/${ws}/src/${name}`;
}

describe("source_media unique (workspace_id, r2_key)", () => {
  it("rejects a second row for the same object and lets ON CONFLICT DO NOTHING skip it", async () => {
    const r2Key = key(wsA, "unique-1");
    await db.insert(sourceMedia).values({ workspaceId: wsA, productId: productA, r2Key, kind: "image", sha256: "a" });
    await expect(
      db.insert(sourceMedia).values({ workspaceId: wsA, productId: productA, r2Key, kind: "image", sha256: "a" }),
    ).rejects.toThrow();

    const skipped = await db
      .insert(sourceMedia)
      .values({ workspaceId: wsA, productId: productA, r2Key, kind: "image", sha256: "a" })
      .onConflictDoNothing({ target: [sourceMedia.workspaceId, sourceMedia.r2Key] })
      .returning();
    expect(skipped).toHaveLength(0);
    const rows = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, r2Key));
    expect(rows).toHaveLength(1);
  });

  it("allows the same object name in two workspaces", async () => {
    // Since 0011 every key carries its own workspace prefix, so the same
    // object name uploaded to two workspaces is two distinct keys.
    await db.insert(sourceMedia).values({ workspaceId: wsA, productId: productA, r2Key: key(wsA, "same"), sha256: "a" });
    await db.insert(sourceMedia).values({ workspaceId: wsB, productId: productB, r2Key: key(wsB, "same"), sha256: "b" });
    const rows = await db.select().from(sourceMedia).where(eq(sourceMedia.sha256, "a"));
    expect(rows.some((row) => row.r2Key === key(wsA, "same"))).toBe(true);
    const other = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, key(wsB, "same")));
    expect(other).toHaveLength(1);
  });
});

describe("0013 dedupe of rows that already exist", () => {
  it("keeps the earliest row per object, repoints share links and deletes only duplicates", async () => {
    // Recreate the pre 0013 state: drop the index, then insert duplicates.
    // Production rows written before 0011 were never checked against its
    // NOT VALID prefix constraint, so the fixture drops it while inserting
    // legacy rows and adds it back NOT VALID, exactly as production has it.
    await client.exec(`drop index "source_media_workspace_r2_key_uq"`);
    await client.exec(`alter table source_media drop constraint source_media_r2_key_workspace_prefix`);

    const dupKey = key(wsA, "dup-photo");
    const [kept] = await db
      .insert(sourceMedia)
      .values({
        workspaceId: wsA,
        productId: productA,
        r2Key: dupKey,
        kind: "image",
        sha256: "x",
        createdAt: new Date("2026-09-01T00:00:00Z"),
      })
      .returning();
    const [second] = await db
      .insert(sourceMedia)
      .values({
        workspaceId: wsA,
        productId: productA,
        r2Key: dupKey,
        kind: "image",
        sha256: "x",
        width: 2000,
        height: 1500,
        createdAt: new Date("2026-09-02T00:00:00Z"),
      })
      .returning();
    const [third] = await db
      .insert(sourceMedia)
      .values({
        workspaceId: wsA,
        productId: productA2,
        r2Key: dupKey,
        kind: "image",
        sha256: "x",
        createdAt: new Date("2026-09-03T00:00:00Z"),
      })
      .returning();
    // A distinct object and a same named object in another workspace stay.
    const [distinct] = await db
      .insert(sourceMedia)
      .values({ workspaceId: wsA, productId: productA, r2Key: key(wsA, "other"), sha256: "y" })
      .returning();
    const [otherWs] = await db
      .insert(sourceMedia)
      .values({ workspaceId: wsB, productId: productB, r2Key: dupKey, sha256: "x" })
      .returning();

    // A legacy cross tenant duplicate pair: its kept row cannot be updated
    // under the prefix check, yet the group must still collapse.
    const legacyKey = key(wsA, "legacy-cross");
    const [legacyKept] = await db
      .insert(sourceMedia)
      .values({
        workspaceId: wsB,
        productId: productB,
        r2Key: legacyKey,
        sha256: "z",
        createdAt: new Date("2026-09-01T00:00:00Z"),
      })
      .returning();
    const [legacyDupe] = await db
      .insert(sourceMedia)
      .values({
        workspaceId: wsB,
        productId: productB,
        r2Key: legacyKey,
        sha256: "z",
        width: 800,
        createdAt: new Date("2026-09-02T00:00:00Z"),
      })
      .returning();
    await client.exec(
      `alter table source_media add constraint source_media_r2_key_workspace_prefix check (starts_with(r2_key, 'ws/' || workspace_id::text || '/')) not valid`,
    );

    await db.insert(shareLinks).values([
      { slug: "before-second", workspaceId: wsA, beforeMediaId: second.id },
      { slug: "before-third", workspaceId: wsA, beforeMediaId: third.id },
      { slug: "before-kept", workspaceId: wsA, beforeMediaId: kept.id },
    ]);

    await client.exec(readFileSync(MIGRATION, "utf8"));

    const group = await db
      .select()
      .from(sourceMedia)
      .where(and(eq(sourceMedia.workspaceId, wsA), eq(sourceMedia.r2Key, dupKey)));
    expect(group).toHaveLength(1);
    expect(group[0].id).toBe(kept.id);
    expect(group[0].productId).toBe(productA);
    // Measurements the kept row lacked are carried over from a duplicate.
    expect(group[0].width).toBe(2000);
    expect(group[0].height).toBe(1500);

    const links = await db.select().from(shareLinks).where(eq(shareLinks.workspaceId, wsA));
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link.beforeMediaId).toBe(kept.id);
    }

    const survivors = await db.select().from(sourceMedia);
    const ids = new Set(survivors.map((row) => row.id));
    expect(ids.has(distinct.id)).toBe(true);
    expect(ids.has(otherWs.id)).toBe(true);
    expect(ids.has(second.id)).toBe(false);
    expect(ids.has(third.id)).toBe(false);
    expect(ids.has(legacyKept.id)).toBe(true);
    expect(ids.has(legacyDupe.id)).toBe(false);

    // The index is back and enforces uniqueness again.
    await expect(
      db.insert(sourceMedia).values({ workspaceId: wsA, productId: productA, r2Key: dupKey, sha256: "x" }),
    ).rejects.toThrow();
  });

  it("is a no op on a table without duplicates", async () => {
    const before = await db.select().from(sourceMedia);
    await client.exec(`drop index "source_media_workspace_r2_key_uq"`);
    await client.exec(readFileSync(MIGRATION, "utf8"));
    const after = await db.select().from(sourceMedia);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  });
});
