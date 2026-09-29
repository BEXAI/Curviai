import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  type TestDb,
} from "./test-helpers";
import {
  apiKeys,
  assets,
  assetVariants,
  channelSpecs,
  favorites,
  generationJobs,
  products,
  workspaces,
} from "./schema";

// Migration 0024 (docs/phases/PHASE_16.md): generation_jobs.seller_answers
// and asset_variants.picked on existing tenant tables (RLS unchanged), and
// two new tenant tables, api_keys and favorites (CLAUDE.md rule 5). Owners
// and admins read api_keys, and since 0026 only the owner connection writes
// them; members read favorites and every seat but the
// client adds and removes them. Another workspace never sees or changes
// either.

const OWNER_A = "00000000-0000-4000-8000-0000000024a1";
const ADMIN_A = "00000000-0000-4000-8000-0000000024a2";
const EDITOR_A = "00000000-0000-4000-8000-0000000024a3";
const CLIENT_A = "00000000-0000-4000-8000-0000000024a4";
const OWNER_B = "00000000-0000-4000-8000-0000000024b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let jobA: string;
let assetA: string;
let assetA2: string;
let assetB: string;
let variantA: string;
let keyA: string;

const answers = { target: "blue_bottle", channels: ["amazon"], mood: "bright_outdoor" };

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  wsB = b.id;
  await client.query(
    `insert into members (workspace_id, user_id, role) values
       ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'editor'), ($1, $5, 'client'), ($6, $7, 'owner')`,
    [wsA, OWNER_A, ADMIN_A, EDITOR_A, CLIENT_A, wsB, OWNER_B],
  );
  await db.insert(channelSpecs).values({ id: "test.main_0024", version: 1, spec: {} });
  const [pA] = await db.insert(products).values({ workspaceId: wsA, title: "Bottle", mode: "listing" }).returning();
  const [pB] = await db.insert(products).values({ workspaceId: wsB, title: "Tray", mode: "listing" }).returning();
  const [jA] = await db
    .insert(generationJobs)
    .values({ workspaceId: wsA, productId: pA.id, sellerAnswers: answers })
    .returning();
  const [jB] = await db.insert(generationJobs).values({ workspaceId: wsB, productId: pB.id }).returning();
  jobA = jA.id;
  const [aA] = await db.insert(assets).values({ workspaceId: wsA, jobId: jobA, shotType: "lifestyle" }).returning();
  const [aA2] = await db.insert(assets).values({ workspaceId: wsA, jobId: jobA, shotType: "main" }).returning();
  const [aB] = await db.insert(assets).values({ workspaceId: wsB, jobId: jB.id, shotType: "main" }).returning();
  assetA = aA.id;
  assetA2 = aA2.id;
  assetB = aB.id;
  const [v] = await db
    .insert(assetVariants)
    .values({
      workspaceId: wsA,
      assetId: assetA,
      channelSpecId: "test.main_0024",
      r2Key: `ws/${wsA}/out/v1.jpg`,
      filename: "v1.jpg",
    })
    .returning();
  variantA = v.id;
  const [k] = await db
    .insert(apiKeys)
    .values({ workspaceId: wsA, name: "CI", prefix: "cv_live_aaaa", keyHash: "h".repeat(64), createdBy: OWNER_A })
    .returning();
  keyA = k.id;
  await db.insert(favorites).values({ workspaceId: wsA, assetId: assetA, createdBy: EDITOR_A });
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("0024 generation_jobs.seller_answers", () => {
  it("is a nullable jsonb column that stores the answers", async () => {
    const res = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'generation_jobs' and column_name = 'seller_answers'`,
    );
    expect(res.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES", column_default: null }]);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
    expect(job.sellerAnswers).toEqual(answers);
  });

  it("accepts an object or null and rejects any other JSON value", async () => {
    for (const bad of ["[]", '"blue"', "3", "true", "null"]) {
      await expect(
        client.query("update generation_jobs set seller_answers = $1::jsonb where id = $2", [bad, jobA]),
        bad,
      ).rejects.toThrow("generation_jobs_seller_answers_object");
    }
    await client.query("update generation_jobs set seller_answers = null where id = $1", [jobA]);
    await db.update(generationJobs).set({ sellerAnswers: answers }).where(eq(generationJobs.id, jobA));
  });

  it("is hidden from and unchangeable by another workspace", async () => {
    await actAs(client, OWNER_B);
    const res = await client.query("select seller_answers from generation_jobs where id = $1", [jobA]);
    expect(res.rows).toHaveLength(0);
    await client
      .query(`update generation_jobs set seller_answers = '{"x": 1}'::jsonb where id = $1`, [jobA])
      .catch(() => undefined);
    await actAsSuperuser(client);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
    expect(job.sellerAnswers).toEqual(answers);
  });
});

describe("0024 asset_variants.picked", () => {
  it("defaults to true, so every existing variant still ships", async () => {
    const [v] = await db.select().from(assetVariants).where(eq(assetVariants.id, variantA));
    expect(v.picked).toBe(true);
    await expect(client.query("update asset_variants set picked = null where id = $1", [variantA])).rejects.toThrow();
  });

  it("stores an unpicked variation", async () => {
    const [v] = await db
      .insert(assetVariants)
      .values({
        workspaceId: wsA,
        assetId: assetA,
        channelSpecId: "test.main_0024",
        r2Key: `ws/${wsA}/out/v2.jpg`,
        filename: "v2.jpg",
        picked: false,
      })
      .returning();
    expect(v.picked).toBe(false);
  });

  it("is hidden from and unchangeable by another workspace, and a member cannot flip it", async () => {
    await actAs(client, OWNER_B);
    expect((await client.query("select picked from asset_variants where id = $1", [variantA])).rows).toHaveLength(0);
    await client.query("update asset_variants set picked = false where id = $1", [variantA]).catch(() => undefined);
    await actAs(client, OWNER_A);
    await client.query("update asset_variants set picked = false where id = $1", [variantA]).catch(() => undefined);
    await actAsSuperuser(client);
    const [v] = await db.select().from(assetVariants).where(eq(assetVariants.id, variantA));
    expect(v.picked).toBe(true);
  });
});

describe("0024 api_keys", () => {
  it("has RLS on and the documented columns", async () => {
    const rls = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'api_keys' and relnamespace = 'public'::regnamespace",
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyA));
    expect(k.scopes).toEqual([]);
    expect(k.lastUsedAt).toBeNull();
    expect(k.revokedAt).toBeNull();
    expect(k.createdAt).toBeInstanceOf(Date);
  });

  it("keeps the prefix unique across workspaces and requires a hash", async () => {
    await expect(
      db.insert(apiKeys).values({ workspaceId: wsB, name: "dup", prefix: "cv_live_aaaa", keyHash: "x" }),
    ).rejects.toThrow();
    await expect(
      client.query("insert into api_keys (workspace_id, name, prefix) values ($1, 'n', 'cv_live_nohash')", [wsA]),
    ).rejects.toThrow();
  });

  it("stores scopes as a text array", async () => {
    const [k] = await db
      .insert(apiKeys)
      .values({ workspaceId: wsA, name: "Agent", prefix: "cv_live_scope", keyHash: "s", scopes: ["packs:write", "packs:read"] })
      .returning();
    expect(k.scopes).toEqual(["packs:write", "packs:read"]);
  });

  it("lets owners and admins read keys, and no other seat", async () => {
    for (const user of [OWNER_A, ADMIN_A]) {
      await actAs(client, user);
      const res = await client.query("select id from api_keys where id = $1", [keyA]);
      expect(res.rows, user).toHaveLength(1);
    }
    for (const user of [EDITOR_A, CLIENT_A]) {
      await actAs(client, user);
      const res = await client.query("select id from api_keys where id = $1", [keyA]);
      expect(res.rows, user).toHaveLength(0);
    }
  });

  // Migration 0026: keys are written only through the owner connection
  // (createApiKey and revokeApiKey), so every client role is read only. An
  // admin with a session JWT must not mint a key directly, rewrite created_by
  // to borrow the owner's membership, swap another member's key_hash, or bring
  // back a key the owner revoked.
  it("has no insert, update or delete policy on api_keys", async () => {
    const res = await client.query<{ policyname: string; cmd: string }>(
      "select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'api_keys' order by policyname",
    );
    expect(res.rows).toEqual([{ policyname: "api_keys_select_owner_admin", cmd: "SELECT" }]);
  });

  it("refuses a key inserted by an owner or admin through a client role, even as themselves", async () => {
    for (const [user, act] of [
      [OWNER_A, actAs],
      [ADMIN_A, actAs],
      [ADMIN_A, actAsAuthenticated],
    ] as const) {
      await act(client, user);
      await expect(
        client.query(
          `insert into api_keys (workspace_id, name, prefix, key_hash, created_by) values ($1, 'n', $2, 'a', $3)`,
          [wsA, `cv_live_direct_${user.slice(-2)}`, user],
        ),
        user,
      ).rejects.toThrow();
    }
  });

  it("refuses an admin rewriting created_by, key_hash, prefix or scopes", async () => {
    for (const act of [actAs, actAsAuthenticated]) {
      await act(client, ADMIN_A);
      await client
        .query("update api_keys set created_by = $1 where id = $2", [OWNER_A, keyA])
        .catch(() => undefined);
      await client.query("update api_keys set created_by = $1 where id = $2", [ADMIN_A, keyA]).catch(() => undefined);
      await client.query("update api_keys set key_hash = 'taken' where id = $1", [keyA]).catch(() => undefined);
      await client.query("update api_keys set prefix = 'cv_live_moved' where id = $1", [keyA]).catch(() => undefined);
      await client
        .query("update api_keys set scopes = '{packs:write}'::text[] where id = $1", [keyA])
        .catch(() => undefined);
    }
    await actAsSuperuser(client);
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyA));
    expect(k.createdBy).toBe(OWNER_A);
    expect(k.keyHash).toBe("h".repeat(64));
    expect(k.prefix).toBe("cv_live_aaaa");
    expect(k.scopes).toEqual([]);
  });

  it("refuses an owner or admin un-revoking a revoked key", async () => {
    const [revoked] = await db
      .insert(apiKeys)
      .values({
        workspaceId: wsA,
        name: "Leaked",
        prefix: "cv_live_leaked",
        keyHash: "l",
        createdBy: ADMIN_A,
        revokedAt: new Date("2026-09-01T00:00:00Z"),
      })
      .returning();
    for (const user of [OWNER_A, ADMIN_A]) {
      for (const act of [actAs, actAsAuthenticated]) {
        await act(client, user);
        await client
          .query("update api_keys set revoked_at = null where id = $1", [revoked.id])
          .catch(() => undefined);
      }
    }
    await actAsSuperuser(client);
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, revoked.id));
    expect(k.revokedAt).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("revokes client write grants on api_keys and keeps the owner connection writing", async () => {
    // The test harness re-grants every table to the Supabase roles after
    // migrations, so check the migration text carries the revoke, and that
    // the owner connection (used by DbApiKeyStore) still revokes a key.
    const sqlText = readFileSync(
      fileURLToPath(new URL("../migrations/0026_api_keys_client_read_only.sql", import.meta.url)),
      "utf8",
    );
    expect(sqlText).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.api_keys/);
    const [k] = await db
      .insert(apiKeys)
      .values({ workspaceId: wsA, name: "Owner conn", prefix: "cv_live_ownerconn", keyHash: "o", createdBy: ADMIN_A })
      .returning();
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, k.id));
    const [after] = await db.select().from(apiKeys).where(eq(apiKeys.id, k.id));
    expect(after.revokedAt).toBeInstanceOf(Date);
  });

  it("refuses writes from editors and clients", async () => {
    for (const user of [EDITOR_A, CLIENT_A]) {
      await actAs(client, user);
      await expect(
        client.query(
          `insert into api_keys (workspace_id, name, prefix, key_hash, created_by) values ($1, 'n', $2, 'a', $3)`,
          [wsA, `cv_live_${user.slice(-4)}`, user],
        ),
        user,
      ).rejects.toThrow();
      await client.query("update api_keys set revoked_at = now(), key_hash = 'z' where id = $1", [keyA]);
    }
    await actAsSuperuser(client);
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyA));
    expect(k.revokedAt).toBeNull();
    expect(k.keyHash).toBe("h".repeat(64));
  });

  it("lets nobody delete a key through a client role", async () => {
    await actAs(client, OWNER_A);
    await client.query("delete from api_keys where id = $1", [keyA]);
    await actAsSuperuser(client);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.id, keyA))).toHaveLength(1);
  });

  it("denies another workspace and anon", async () => {
    await actAs(client, OWNER_B);
    expect((await client.query("select id from api_keys where id = $1", [keyA])).rows).toHaveLength(0);
    await client.query("update api_keys set revoked_at = now() where id = $1", [keyA]);
    await expect(
      client.query(
        `insert into api_keys (workspace_id, name, prefix, key_hash, created_by) values ($1, 'n', 'cv_live_cross', 'a', $2)`,
        [wsA, OWNER_B],
      ),
    ).rejects.toThrow();
    await actAsAnon(client);
    const anon = await client.query("select id from api_keys").catch(() => ({ rows: [] }));
    expect(anon.rows).toHaveLength(0);
    await actAsSuperuser(client);
    const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyA));
    expect(k.revokedAt).toBeNull();
  });

  it("goes with its workspace", async () => {
    const [c] = await db.insert(workspaces).values({ name: "C" }).returning();
    await db.insert(apiKeys).values({ workspaceId: c.id, name: "n", prefix: "cv_live_gone", keyHash: "g" });
    await db.delete(workspaces).where(eq(workspaces.id, c.id));
    expect(await db.select().from(apiKeys).where(eq(apiKeys.workspaceId, c.id))).toHaveLength(0);
  });
});

describe("0024 favorites", () => {
  it("has RLS on and one row per workspace and asset", async () => {
    const rls = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'favorites' and relnamespace = 'public'::regnamespace",
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    await expect(db.insert(favorites).values({ workspaceId: wsA, assetId: assetA })).rejects.toThrow();
  });

  it("refuses an asset from another workspace, even from the owner connection", async () => {
    await expect(
      client.query("insert into favorites (workspace_id, asset_id) values ($1, $2)", [wsA, assetB]),
    ).rejects.toThrow("favorites_asset_workspace_fk");
  });

  it("lets every member read, a client seat too", async () => {
    for (const user of [OWNER_A, ADMIN_A, EDITOR_A, CLIENT_A]) {
      await actAs(client, user);
      const res = await client.query("select asset_id from favorites where workspace_id = $1", [wsA]);
      expect(res.rows, user).toHaveLength(1);
    }
  });

  it("lets an editor add and remove a favorite as themselves", async () => {
    await actAs(client, EDITOR_A);
    await client.query("insert into favorites (workspace_id, asset_id, created_by) values ($1, $2, $3)", [
      wsA,
      assetA2,
      EDITOR_A,
    ]);
    await actAsSuperuser(client);
    expect(
      await db.select().from(favorites).where(and(eq(favorites.workspaceId, wsA), eq(favorites.assetId, assetA2))),
    ).toHaveLength(1);
    await actAs(client, EDITOR_A);
    await client.query("delete from favorites where workspace_id = $1 and asset_id = $2", [wsA, assetA2]);
    await actAsSuperuser(client);
    expect(
      await db.select().from(favorites).where(and(eq(favorites.workspaceId, wsA), eq(favorites.assetId, assetA2))),
    ).toHaveLength(0);
  });

  it("refuses a favorite in someone else's name", async () => {
    await actAs(client, EDITOR_A);
    await expect(
      client.query("insert into favorites (workspace_id, asset_id, created_by) values ($1, $2, $3)", [
        wsA,
        assetA2,
        OWNER_A,
      ]),
    ).rejects.toThrow();
  });

  it("keeps the client seat read only", async () => {
    await actAs(client, CLIENT_A);
    await expect(
      client.query("insert into favorites (workspace_id, asset_id, created_by) values ($1, $2, $3)", [
        wsA,
        assetA2,
        CLIENT_A,
      ]),
    ).rejects.toThrow();
    await client.query("delete from favorites where workspace_id = $1", [wsA]);
    await actAsSuperuser(client);
    expect(await db.select().from(favorites).where(eq(favorites.workspaceId, wsA))).toHaveLength(1);
  });

  it("denies another workspace and anon", async () => {
    await actAs(client, OWNER_B);
    expect((await client.query("select asset_id from favorites where workspace_id = $1", [wsA])).rows).toHaveLength(0);
    await expect(
      client.query("insert into favorites (workspace_id, asset_id, created_by) values ($1, $2, $3)", [
        wsA,
        assetA2,
        OWNER_B,
      ]),
    ).rejects.toThrow();
    await client.query("delete from favorites where workspace_id = $1", [wsA]);
    await actAsAnon(client);
    const anon = await client.query("select asset_id from favorites").catch(() => ({ rows: [] }));
    expect(anon.rows).toHaveLength(0);
    await actAsSuperuser(client);
    expect(await db.select().from(favorites).where(eq(favorites.workspaceId, wsA))).toHaveLength(1);
  });

  it("goes with its asset", async () => {
    await db.insert(favorites).values({ workspaceId: wsA, assetId: assetA2 });
    await db.delete(assets).where(eq(assets.id, assetA2));
    expect(await db.select().from(favorites).where(eq(favorites.assetId, assetA2))).toHaveLength(0);
  });
});
