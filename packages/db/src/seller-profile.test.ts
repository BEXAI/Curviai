import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsServiceRole,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  type TestDb,
} from "./test-helpers";
import { workspaces } from "./schema";

// Migration seller_profile (docs/phases/PHASE_18.md P18-20): the first run
// answers on workspaces.seller_profile. No new table, so the existing
// workspace policies cover it: members read their own workspace's profile,
// nobody else does, and no client connection writes it, not even the owner
// (the protected columns trigger). The owner can still rename the
// workspace. Only the server (owner connection or service role) writes it,
// and only a small JSON object fits.

const OWNER_A = "00000000-0000-4000-8000-0000000018a1";
const ADMIN_A = "00000000-0000-4000-8000-0000000018a2";
const CLIENT_A = "00000000-0000-4000-8000-0000000018a3";
const OWNER_B = "00000000-0000-4000-8000-0000000018b1";

const PROFILE = { category: "candles", channels: ["amazon", "shopify"], answeredAt: "2026-10-01T12:00:00.000Z" };

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;

async function profileOf(id: string): Promise<unknown> {
  const result = await client.query<{ seller_profile: unknown }>("select seller_profile from workspaces where id = $1", [id]);
  return result.rows[0]?.seller_profile;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B", sellerProfile: { category: "pet" } }).returning();
  wsA = a.id;
  wsB = b.id;
  await client.query(
    `insert into members (workspace_id, user_id, role) values
       ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'client'), ($5, $6, 'owner')`,
    [wsA, OWNER_A, ADMIN_A, CLIENT_A, wsB, OWNER_B],
  );
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("workspaces.seller_profile (seller_profile)", () => {
  it("is empty until the server writes the answers", async () => {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, wsA));
    expect(row.sellerProfile).toBeNull();
    await db.update(workspaces).set({ sellerProfile: PROFILE }).where(eq(workspaces.id, wsA));
    const [after] = await db.select().from(workspaces).where(eq(workspaces.id, wsA));
    expect(after.sellerProfile).toEqual(PROFILE);
  });

  it("takes only a small JSON object", async () => {
    for (const bad of ['["amazon"]', '"candles"', "42", "null", JSON.stringify({ note: "x".repeat(1100) })]) {
      await expect(
        client.query("update workspaces set seller_profile = $1::jsonb where id = $2", [bad, wsB]),
        bad.slice(0, 20),
      ).rejects.toThrow(/workspaces_seller_profile_object/);
    }
    expect(await profileOf(wsB)).toEqual({ category: "pet" });
  });

  it("is read by every member of the workspace and by nobody else", async () => {
    for (const member of [OWNER_A, ADMIN_A, CLIENT_A]) {
      await actAs(client, member);
      const own = await client.query<{ seller_profile: unknown }>("select seller_profile from workspaces where id = $1", [wsA]);
      expect(own.rows, member).toEqual([{ seller_profile: PROFILE }]);
      const other = await client.query("select seller_profile from workspaces where id = $1", [wsB]);
      expect(other.rows, member).toEqual([]);
      await actAsSuperuser(client);
    }
    await actAsAnon(client);
    const anon = await client
      .query("select seller_profile from workspaces")
      .then((r) => r.rows.length)
      .catch(() => 0);
    expect(anon).toBe(0);
  });

  it("cannot be written by a client connection, even the owner's; the owner can still rename", async () => {
    for (const [name, become] of [
      ["owner (app user)", () => actAs(client, OWNER_A)],
      ["admin (app user)", () => actAs(client, ADMIN_A)],
      ["owner (authenticated)", () => actAsAuthenticated(client, OWNER_A)],
    ] as const) {
      await become();
      await expect(
        client.query("update workspaces set seller_profile = $1::jsonb where id = $2", ['{"category":"jewelry"}', wsA]),
        name,
      ).rejects.toThrow(/can only be changed by the service role/);
      await actAsSuperuser(client);
    }
    // The client seat has no update policy at all: the row is not touched.
    await actAs(client, CLIENT_A);
    const clientUpdate = await client
      .query("update workspaces set seller_profile = $1::jsonb where id = $2", ['{"category":"jewelry"}', wsA])
      .then((r) => r.affectedRows ?? 0)
      .catch(() => 0);
    expect(clientUpdate).toBe(0);
    // Another workspace's owner cannot reach it either.
    await actAs(client, OWNER_B);
    const crossUpdate = await client
      .query("update workspaces set seller_profile = null where id = $1", [wsA])
      .then((r) => r.affectedRows ?? 0)
      .catch(() => 0);
    expect(crossUpdate).toBe(0);
    await actAsSuperuser(client);
    expect(await profileOf(wsA)).toEqual(PROFILE);

    await actAs(client, OWNER_A);
    await client.query("update workspaces set name = 'Candle shop' where id = $1", [wsA]);
    await actAsSuperuser(client);
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, wsA));
    expect(row.name).toBe("Candle shop");
    expect(row.sellerProfile).toEqual(PROFILE);
  });

  it("can be written by the service role", async () => {
    await actAsServiceRole(client);
    await client.query("update workspaces set seller_profile = $1::jsonb where id = $2", ['{"category":"food"}', wsB]);
    await actAsSuperuser(client);
    expect(await profileOf(wsB)).toEqual({ category: "food" });
  });
});
