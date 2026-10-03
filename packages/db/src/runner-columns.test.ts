import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actAsAuthenticated, actAsServiceRole, actAsSuperuser, createTestDb } from "./test-helpers";

const WS = "00000000-0000-4000-8000-000000004101";
const OWNER = "00000000-0000-4000-8000-000000004102";
const OTHER = "00000000-0000-4000-8000-000000004103";
const PRODUCT = "00000000-0000-4000-8000-000000004104";

describe("runner_columns: server owned recovery leases", () => {
  let client: PGlite;

  beforeAll(async () => {
    ({ client } = await createTestDb());
    await client.query("insert into workspaces (id, name) values ($1, 'Runner')", [WS]);
    await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [WS, OWNER]);
    await client.query("insert into products (id, workspace_id, title, mode) values ($1, $2, 'Candle', 'listing')", [PRODUCT, WS]);
    await client.query("insert into generation_jobs (workspace_id, product_id) values ($1, $2)", [WS, PRODUCT]);
  });
  afterEach(async () => { await actAsSuperuser(client); });
  afterAll(async () => { await client.close(); });

  it("leaves old jobs nullable and lets the server set the runner fields", async () => {
    await actAsServiceRole(client);
    const rows = await client.query("select heartbeat_at, runner_id, started_at, finished_at from generation_jobs");
    expect(rows.rows).toEqual([{ heartbeat_at: null, runner_id: null, started_at: null, finished_at: null }]);
    await client.query("update generation_jobs set runner_id = $1, heartbeat_at = now(), started_at = now(), finished_at = now()", ["r".repeat(64)]);
    await expect(client.query("update generation_jobs set runner_id = $1", ["r".repeat(65)])).rejects.toThrow("generation_jobs_runner_id_length");
  });

  it("lets members read the lease and prevents another workspace from reading it", async () => {
    await actAsAuthenticated(client, OWNER);
    expect((await client.query("select runner_id from generation_jobs")).rows).toHaveLength(1);
    await actAsAuthenticated(client, OTHER);
    expect((await client.query("select runner_id from generation_jobs")).rows).toHaveLength(0);
  });

  it("blocks member writes to every runner column, including inserts", async () => {
    const fields = "heartbeat_at, runner_id, started_at, finished_at, error";
    const before = (await client.query(`select ${fields} from generation_jobs`)).rows;
    await actAsAuthenticated(client, OWNER);
    for (const column of ["heartbeat_at", "runner_id", "started_at", "finished_at"]) {
      expect((await client.query(`update generation_jobs set ${column} = null`)).affectedRows).toBe(0);
    }
    await expect(client.query(
      "insert into generation_jobs (workspace_id, product_id, runner_id) values ($1, $2, 'forged')", [WS, PRODUCT],
    )).rejects.toThrow("runner metadata can only be changed by the server");
    // 0049 removes all direct member job writes, including ordinary fields.
    expect((await client.query("update generation_jobs set error = 'forged note'")).affectedRows).toBe(0);
    expect((await client.query(`select ${fields} from generation_jobs`)).rows).toEqual(before);
    await actAsSuperuser(client);
    expect((await client.query(`select ${fields} from generation_jobs`)).rows).toEqual(before);
  });

  it("indexes only live jobs by status and heartbeat and reuses the restart payload", async () => {
    const rows = await client.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'generation_jobs_live_heartbeat_idx'");
    expect(rows.rows[0]?.indexdef).toMatch(/\(status, heartbeat_at\).*WHERE/);
    expect(rows.rows[0]?.indexdef).toContain("queued");
    expect(rows.rows[0]?.indexdef).not.toContain("'done'");
    const payload = await client.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'generation_jobs' and column_name in ('run_payload', 'restart_payload')");
    expect(payload.rows).toEqual([{ column_name: "restart_payload" }]);
  });
});
