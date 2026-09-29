import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { actAs, actAsAnon, actAsSuperuser, createAppUserRole, createTestDb, type TestDb } from "./test-helpers";
import { uploadPreflights, workspaces } from "./schema";

// Migration 0022: upload_preflights, a new tenant table (CLAUDE.md rule 5).
// Members read their own workspace's rows; nobody writes through the anon or
// authenticated roles, the owner connection does.

const OWNER_A = "00000000-0000-4000-8000-0000000022a1";
const CLIENT_A = "00000000-0000-4000-8000-0000000022a3";
const OWNER_B = "00000000-0000-4000-8000-0000000022b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let rowA: string;

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
    `insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'client'), ($4, $5, 'owner')`,
    [wsA, OWNER_A, CLIENT_A, wsB, OWNER_B],
  );
  const [row] = await db
    .insert(uploadPreflights)
    .values({
      workspaceId: wsA,
      r2Key: `ws/${wsA}/src/photo`,
      noteKey: "n".repeat(64),
      status: "ready",
      result: { found: "silver watch" },
      intake: { recipeVersion: 3 },
      costMicros: 1200,
    })
    .returning();
  rowA = row.id;
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("0022 upload_preflights", () => {
  it("stores one row per workspace and upload key", async () => {
    await expect(
      db.insert(uploadPreflights).values({
        workspaceId: wsA,
        r2Key: `ws/${wsA}/src/photo`,
        noteKey: "x",
        status: "ready",
        result: {},
      }),
    ).rejects.toThrow();
    // The same key in another workspace is a different row.
    await db
      .insert(uploadPreflights)
      .values({ workspaceId: wsB, r2Key: `ws/${wsA}/src/photo`, noteKey: "x", status: "blocked", result: {} });
  });

  it("refuses an unknown status", async () => {
    await expect(
      db.insert(uploadPreflights).values({ workspaceId: wsA, r2Key: "k2", noteKey: "x", status: "maybe" as never, result: {} }),
    ).rejects.toThrow();
  });

  it("lets a member of the workspace read it, and a client seat too", async () => {
    await actAs(client, OWNER_A);
    const owner = await client.query<{ cost_micros: string }>("select cost_micros from upload_preflights where id = $1", [rowA]);
    expect(owner.rows).toHaveLength(1);
    await actAs(client, CLIENT_A);
    const seat = await client.query("select id from upload_preflights where id = $1", [rowA]);
    expect(seat.rows).toHaveLength(1);
  });

  it("hides it from another workspace and from anon", async () => {
    await actAs(client, OWNER_B);
    const other = await client.query("select id from upload_preflights where id = $1", [rowA]);
    expect(other.rows).toHaveLength(0);
    await actAsAnon(client);
    const anon = await client.query("select id from upload_preflights").catch(() => ({ rows: [] }));
    expect(anon.rows).toHaveLength(0);
  });

  it("lets no member write it", async () => {
    await actAs(client, OWNER_A);
    await client
      .query("update upload_preflights set status = 'blocked', cost_micros = 0 where id = $1", [rowA])
      .catch(() => undefined);
    await client
      .query(
        `insert into upload_preflights (workspace_id, r2_key, note_key, status, result) values ($1, 'ws/x/src/y', 'n', 'ready', '{}')`,
        [wsA],
      )
      .catch(() => undefined);
    await client.query("delete from upload_preflights where id = $1", [rowA]).catch(() => undefined);
    await actAsSuperuser(client);
    const [row] = await db.select().from(uploadPreflights).where(eq(uploadPreflights.id, rowA));
    expect(row.status).toBe("ready");
    expect(row.costMicros).toBe(1200);
    const inserted = await db.select().from(uploadPreflights).where(eq(uploadPreflights.r2Key, "ws/x/src/y"));
    expect(inserted).toHaveLength(0);
  });

  it("goes with its workspace", async () => {
    const [c] = await db.insert(workspaces).values({ name: "C" }).returning();
    await db.insert(uploadPreflights).values({ workspaceId: c.id, r2Key: "k", noteKey: "x", status: "ready", result: {} });
    await db.delete(workspaces).where(eq(workspaces.id, c.id));
    const left = await db.select().from(uploadPreflights).where(eq(uploadPreflights.workspaceId, c.id));
    expect(left).toHaveLength(0);
  });
});
