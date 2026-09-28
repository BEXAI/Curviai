import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  actAs,
  actAsAnon,
  actAsServiceRole,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  type TestDb,
} from "./test-helpers";
import { cancelFlows, workspaces } from "./schema";

// Migration 0018: cancel_flows carries workspace_id and RLS (CLAUDE.md rule
// 5). Owners, admins and editors read their own workspace's rows; the client
// role, other workspaces and anon read nothing; no member writes.

const OWNER_A = "00000000-0000-4000-8000-0000000018a1";
const EDITOR_A = "00000000-0000-4000-8000-0000000018a2";
const CLIENT_A = "00000000-0000-4000-8000-0000000018a3";
const OWNER_B = "00000000-0000-4000-8000-0000000018b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;

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
       ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'client'), ($5, $6, 'owner')`,
    [wsA, OWNER_A, EDITOR_A, CLIENT_A, wsB, OWNER_B],
  );
  await db.insert(cancelFlows).values([
    { workspaceId: wsA, reason: "too_expensive", outcome: "discounted", offersShown: ["discount", "pause"] },
    { workspaceId: wsB, reason: "unused", outcome: "canceled" },
  ]);
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("0018: cancel_flows", () => {
  it("enables row level security with the workspace foreign key", async () => {
    const rls = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'cancel_flows'",
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
    await expect(
      client.query("insert into cancel_flows (workspace_id, reason, outcome) values (gen_random_uuid(), 'other', 'kept')"),
    ).rejects.toThrow(/foreign key/);
  });

  it("lets owners and editors read only their own workspace's rows", async () => {
    for (const user of [OWNER_A, EDITOR_A]) {
      await actAsSuperuser(client);
      await actAs(client, user);
      const rows = await db.select().from(cancelFlows);
      expect(rows).toHaveLength(1);
      expect(rows[0].workspaceId).toBe(wsA);
      expect(rows[0].stripeApplied).toBe(false);
    }
  });

  it("shows the client role, other workspaces and anon nothing", async () => {
    await actAs(client, CLIENT_A);
    expect(await db.select().from(cancelFlows)).toHaveLength(0);
    await actAsSuperuser(client);
    await actAs(client, OWNER_B);
    const other = await db.select().from(cancelFlows);
    expect(other.every((row) => row.workspaceId === wsB)).toBe(true);
    await actAsAnon(client);
    expect((await client.query("select * from cancel_flows")).rows).toHaveLength(0);
  });

  it("denies every member writing rows, and keeps service role writes", async () => {
    await actAs(client, OWNER_A);
    await expect(
      client.query("insert into cancel_flows (workspace_id, reason, outcome) values ($1, 'other', 'kept')", [wsA]),
    ).rejects.toThrow(/row-level security/);
    const update = await client.query("update cancel_flows set outcome = 'kept' where workspace_id = $1", [wsA]);
    expect(update.affectedRows ?? 0).toBe(0);
    const del = await client.query("delete from cancel_flows where workspace_id = $1", [wsA]);
    expect(del.affectedRows ?? 0).toBe(0);

    await actAsServiceRole(client);
    await client.query("insert into cancel_flows (workspace_id, reason, outcome) values ($1, 'other', 'kept')", [wsA]);
  });
});
