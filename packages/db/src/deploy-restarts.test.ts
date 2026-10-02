import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { actAs, actAsSuperuser, createAppUserRole, createTestDb, type TestDb } from "./test-helpers";
import { generationJobs, products, workspaces } from "./schema";

// Migration deploy_restarts (docs/phases/PHASE_18.md P18-23): restart_count
// and restart_payload on generation_jobs. No new table, so the existing
// policies keep covering them: another workspace never sees them, and a
// trigger keeps every client connection, owners included, from writing
// them or moving run_key to a restart: key. The restart pickup trusts all
// three, so only the server may set them.

const OWNER_A = "00000000-0000-4000-8000-0000000028a1";
const CLIENT_A = "00000000-0000-4000-8000-0000000028a3";
const OWNER_B = "00000000-0000-4000-8000-0000000028b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let productA: string;
let jobA: string;

const payload = { jobId: "x", workspaceId: "y", images: [], creditBudget: 8 };

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  await client.query(
    `insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'client'), ($4, $5, 'owner')`,
    [wsA, OWNER_A, CLIENT_A, b.id, OWNER_B],
  );
  const [p] = await db.insert(products).values({ workspaceId: wsA, title: "Candle", mode: "listing" }).returning();
  productA = p.id;
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: wsA, productId: productA, runKey: "run-1" })
    .returning();
  jobA = job.id;
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

async function row() {
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
  return job;
}

describe("deploy_restarts", () => {
  it("adds restart_count (0 by default, never negative) and a nullable object restart_payload", async () => {
    const job = await row();
    expect(job.restartCount).toBe(0);
    expect(job.restartPayload).toBeNull();
    const cols = await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'generation_jobs' and column_name in ('restart_count', 'restart_payload')
        order by column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "restart_count", data_type: "integer", is_nullable: "NO", column_default: "0" },
      { column_name: "restart_payload", data_type: "jsonb", is_nullable: "YES", column_default: null },
    ]);
    for (const bad of ["[]", '"x"', "3", "true", "null"]) {
      await expect(client.query(`update generation_jobs set restart_payload = $1::jsonb where id = $2`, [bad, jobA])).rejects.toThrow(
        "generation_jobs_restart_payload_object",
      );
    }
    await expect(client.query(`update generation_jobs set restart_count = -1 where id = $1`, [jobA])).rejects.toThrow(
      "generation_jobs_restart_count_range",
    );
  });

  it("lets the server set and clear them", async () => {
    await db
      .update(generationJobs)
      .set({ restartCount: 1, restartPayload: payload, runKey: "restart:abc", status: "queued" })
      .where(eq(generationJobs.id, jobA));
    expect(await row()).toMatchObject({ restartCount: 1, restartPayload: payload, runKey: "restart:abc" });
    await db.update(generationJobs).set({ restartPayload: null, runKey: "run-2" }).where(eq(generationJobs.id, jobA));
    expect(await row()).toMatchObject({ restartCount: 1, restartPayload: null, runKey: "run-2" });
  });

  it("shows them to the workspace's members and hides them from another workspace", async () => {
    await actAs(client, CLIENT_A);
    const seen = await client.query<{ restart_count: number }>("select restart_count from generation_jobs where id = $1", [jobA]);
    expect(seen.rows).toEqual([{ restart_count: 1 }]);
    await actAs(client, OWNER_B);
    const hidden = await client.query("select restart_count, restart_payload from generation_jobs where id = $1", [jobA]);
    expect(hidden.rows).toHaveLength(0);
  });

  it("refuses an owner's client connection that writes them or a restart run key", async () => {
    await actAs(client, OWNER_A);
    await expect(client.query("update generation_jobs set restart_count = 0 where id = $1", [jobA])).rejects.toThrow(
      "can only be changed by the server",
    );
    await expect(
      client.query(`update generation_jobs set restart_payload = '{"creditBudget": 999}'::jsonb where id = $1`, [jobA]),
    ).rejects.toThrow("can only be changed by the server");
    await expect(
      client.query("update generation_jobs set run_key = 'restart:forged', status = 'queued' where id = $1", [jobA]),
    ).rejects.toThrow("can only be changed by the server");
    await expect(
      client.query(
        `insert into generation_jobs (workspace_id, product_id, run_key, restart_count) values ($1, $2, 'restart:x', 1)`,
        [wsA, productA],
      ),
    ).rejects.toThrow("can only be changed by the server");
    // Other columns stay as the 0001 policies allow.
    await client.query("update generation_jobs set error = 'owner note' where id = $1", [jobA]);
    await actAsSuperuser(client);
    expect(await row()).toMatchObject({ restartCount: 1, restartPayload: null, runKey: "run-2", error: "owner note" });
  });

  it("keeps a client seat read only", async () => {
    await actAs(client, CLIENT_A);
    await client.query("update generation_jobs set restart_count = 5 where id = $1", [jobA]).catch(() => undefined);
    await actAsSuperuser(client);
    expect((await row()).restartCount).toBe(1);
  });
});
