import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
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
import { members, termsAcceptances, workspaces } from "./schema";

// Migration 0015: terms_acceptances is written only by the owner connection,
// and each user reads only their own rows (CLAUDE.md rule 5).

const USER_A = "00000000-0000-4000-8000-0000000015a1";
const USER_B = "00000000-0000-4000-8000-0000000015b1";

let client: PGlite;
let db: TestDb;
let wsA: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "Workspace A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "Workspace B" }).returning();
  wsA = a.id;
  await db.insert(members).values([
    { workspaceId: a.id, userId: USER_A, role: "owner" },
    { workspaceId: b.id, userId: USER_B, role: "owner" },
  ]);
  await db.insert(termsAcceptances).values([
    { userId: USER_A, workspaceId: a.id, version: "2026-09-28", ip: "203.0.113.7", source: "signup_callback" },
    { userId: USER_B, workspaceId: b.id, version: "2026-09-28", ip: "198.51.100.2", source: "first_app_visit" },
  ]);
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("terms_acceptances (0015)", () => {
  it("has row level security on", async () => {
    const result = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'terms_acceptances'",
    );
    expect(result.rows[0]?.relrowsecurity).toBe(true);
  });

  it("shows each user only their own acceptance", async () => {
    for (const become of [() => actAs(client, USER_A), () => actAsAuthenticated(client, USER_A)]) {
      await become();
      const rows = await client.query<{ user_id: string; ip: string }>("select user_id, ip from terms_acceptances");
      expect(rows.rows).toEqual([{ user_id: USER_A, ip: "203.0.113.7" }]);
    }
  });

  it("shows anon nothing", async () => {
    await actAsAnon(client);
    const rows = await client.query("select * from terms_acceptances");
    expect(rows.rows).toHaveLength(0);
  });

  it("never lets a signed in user write or rewrite a record", async () => {
    await actAsAuthenticated(client, USER_A);
    await expect(
      client.query(
        "insert into terms_acceptances (user_id, version, source) values ($1, '2099-01-01', 'first_app_visit')",
        [USER_A],
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await client.query("update terms_acceptances set accepted_at = now() - interval '5 years'");
    expect(updated.affectedRows ?? 0).toBe(0);
    const deleted = await client.query("delete from terms_acceptances");
    expect(deleted.affectedRows ?? 0).toBe(0);
  });

  it("keeps one row per user and version", async () => {
    await actAsServiceRole(client);
    await expect(
      client.query(
        "insert into terms_acceptances (user_id, version, source) values ($1, '2026-09-28', 'first_app_visit')",
        [USER_A],
      ),
    ).rejects.toThrow(/terms_acceptances_user_version_uq|duplicate key/);
  });

  it("keeps the record when the workspace goes, with workspace_id set null", async () => {
    await actAsSuperuser(client);
    await client.query("delete from workspaces where id = $1", [wsA]);
    const rows = await client.query<{ workspace_id: string | null }>(
      "select workspace_id from terms_acceptances where user_id = $1",
      [USER_A],
    );
    expect(rows.rows).toEqual([{ workspace_id: null }]);
  });
});
