import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { writeOpsAudit } from "./audit";

// docs/phases/PHASE_20.md principle 9 and P20-66. The table arrives with
// Lane 5's ops_switches_and_audit migration; this test builds a stand in
// with the planned columns, so the columns writeOpsAudit writes are pinned
// for that migration.

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (((result as { rows?: T[] }).rows ?? []) as T[]);
}

describe("writeOpsAudit", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
    const exists = rowsOf<{ name: string | null }>(await db.execute(sql`select to_regclass('public.ops_audit')::text as name`));
    if (!exists[0]?.name) {
      await db.execute(sql`
        create table ops_audit (
          id bigserial primary key,
          at timestamptz not null default now(),
          operator_email text not null,
          action text not null,
          target_kind text not null,
          target_id text,
          workspace_id uuid,
          detail jsonb not null default '{}'::jsonb,
          forced boolean not null default false
        )
      `);
    }
  });

  afterAll(async () => {
    await client.close();
  });

  it("writes one row with the operator, action, target, detail and force flag", async () => {
    const at = new Date("2026-10-01T12:00:00Z");
    await writeOpsAudit(
      db,
      {
        operatorEmail: " Founder@Curvi.ai ",
        action: "credits.grant",
        targetKind: "workspace",
        targetId: "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d",
        workspaceId: "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d",
        detail: { credits: 300, note: "Concierge packs" },
        forced: true,
      },
      at,
    );
    await writeOpsAudit(db, { operatorEmail: "ops@curvi.ai", action: "switch.set", targetKind: "platform_setting", targetId: "ops:packs_paused" }, at);
    const rows = rowsOf<Record<string, unknown>>(
      await db.execute(
        sql`select operator_email, action, target_kind, target_id, workspace_id, detail, forced, at from ops_audit order by id`,
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      operator_email: "founder@curvi.ai",
      action: "credits.grant",
      target_kind: "workspace",
      target_id: "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d",
      workspace_id: "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d",
      detail: { credits: 300, note: "Concierge packs" },
      forced: true,
    });
    expect(new Date(rows[0]!.at as string | Date).toISOString()).toBe(at.toISOString());
    expect(rows[1]).toMatchObject({ workspace_id: null, detail: {}, forced: false, target_id: "ops:packs_paused" });
  });

  it("throws when the row cannot be written", async () => {
    await expect(
      writeOpsAudit(db, { operatorEmail: "ops@curvi.ai", action: "x", targetKind: "workspace", targetId: null, workspaceId: "not a uuid" }),
    ).rejects.toThrow();
  });
});
