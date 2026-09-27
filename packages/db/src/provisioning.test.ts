import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "./test-helpers";
import { creditLedger, members, workspaces } from "./schema";
import { eq } from "drizzle-orm";

let client: PGlite;
let db: TestDb;

const USER = "00000000-0000-4000-8000-0000000000aa";

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

describe("provision_workspace", () => {
  it("creates a workspace, owner membership and the free grant once", async () => {
    const first = await client.query<{ provision_workspace: string }>(
      "select provision_workspace($1, $2, $3)",
      [USER, "Test workspace", 15],
    );
    const wsId = first.rows[0].provision_workspace;
    expect(wsId).toBeTruthy();

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
    expect(ws.name).toBe("Test workspace");
    expect(ws.plan).toBe("free");

    const memberRows = await db.select().from(members).where(eq(members.workspaceId, wsId));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0].userId).toBe(USER);
    expect(memberRows[0].role).toBe("owner");

    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, wsId));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].delta).toBe(15);
    expect(ledgerRows[0].reason).toBe("grant");
  });

  it("is idempotent: a second call returns the same workspace with no second grant", async () => {
    const again = await client.query<{ provision_workspace: string }>(
      "select provision_workspace($1, $2, $3)",
      [USER, "Different name", 15],
    );
    const wsId = again.rows[0].provision_workspace;
    const allWorkspaces = await db.select().from(workspaces);
    expect(allWorkspaces).toHaveLength(1);
    const ledgerRows = await db.select().from(creditLedger).where(eq(creditLedger.workspaceId, wsId));
    expect(ledgerRows).toHaveLength(1);
  });

  it("is not executable by client facing roles", async () => {
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [USER]);
    await client.exec("set role authenticated");
    await expect(
      client.query("select provision_workspace($1, $2, $3)", [USER, "X", 15]),
    ).rejects.toThrow(/permission denied/);
    await client.exec("reset role");
  });
});
