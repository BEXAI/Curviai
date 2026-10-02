import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actAsAuthenticated, actAsSuperuser, createTestDb } from "./test-helpers";

const OWNER = "00000000-0000-4000-8000-0000000048a1";
const CLIENT = "00000000-0000-4000-8000-0000000048a2";
const OTHER = "00000000-0000-4000-8000-0000000048b1";
const HASH = "a".repeat(64);
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let workspaceId: string;
let productId: string;
let jobId: string;

beforeAll(async () => {
  ({ client } = await createTestDb());
  workspaceId = (await client.query<{ id: string }>("insert into workspaces (name) values ('Receipt A') returning id")).rows[0].id;
  const other = (await client.query<{ id: string }>("insert into workspaces (name) values ('Receipt B') returning id")).rows[0].id;
  await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'client'), ($4, $5, 'owner')", [workspaceId, OWNER, CLIENT, other, OTHER]);
  productId = (await client.query<{ id: string }>("insert into products (workspace_id, title, mode) values ($1, 'Mug', 'listing') returning id", [workspaceId])).rows[0].id;
  jobId = (await client.query<{ id: string }>("insert into generation_jobs (workspace_id, product_id, request_fingerprint) values ($1, $2, $3) returning id", [workspaceId, productId, HASH])).rows[0].id;
});
afterEach(async () => { await actAsSuperuser(client); });
afterAll(async () => { await client.close(); });

describe("accepted job request fingerprints", () => {
  it("allows legacy NULL receipts and rejects malformed fingerprints", async () => {
    const legacy = await client.query<{ request_fingerprint: string | null }>("insert into generation_jobs (workspace_id, product_id) values ($1, $2) returning request_fingerprint", [workspaceId, productId]);
    expect(legacy.rows[0].request_fingerprint).toBeNull();
    for (const bad of ["", "b".repeat(63), "g".repeat(64), "A".repeat(64)]) {
      await expect(client.query("update generation_jobs set request_fingerprint = $1 where id = $2", [bad, jobId])).rejects.toThrow("generation_jobs_request_fingerprint_format");
    }
  });

  it("refuses an authenticated owner's insert, overwrite, and removal", async () => {
    const before = (await client.query("select request_fingerprint, error from generation_jobs where id = $1", [jobId])).rows;
    await actAsAuthenticated(client, OWNER);
    await expect(client.query("insert into generation_jobs (workspace_id, product_id, request_fingerprint) values ($1, $2, $3)", [workspaceId, productId, HASH])).rejects.toThrow("can only be changed by the server");
    expect((await client.query("update generation_jobs set request_fingerprint = $1 where id = $2", ["b".repeat(64), jobId])).affectedRows).toBe(0);
    expect((await client.query("update generation_jobs set request_fingerprint = NULL where id = $1", [jobId])).affectedRows).toBe(0);
    // 0049 also closes ordinary job writes; the accepted receipt is still readable.
    expect((await client.query("update generation_jobs set error = 'member note' where id = $1", [jobId])).affectedRows).toBe(0);
    expect((await client.query("select request_fingerprint, error from generation_jobs where id = $1", [jobId])).rows).toEqual(before);
    await actAsSuperuser(client);
    expect((await client.query("select request_fingerprint, error from generation_jobs where id = $1", [jobId])).rows).toEqual(before);
  });

  it("allows service-role writes, while clients cannot change or cross-read receipts", async () => {
    await client.exec("set role service_role");
    expect((await client.query("update generation_jobs set request_fingerprint = NULL where id = $1", [jobId])).affectedRows).toBe(1);
    expect((await client.query("select request_fingerprint from generation_jobs where id = $1", [jobId])).rows).toEqual([{ request_fingerprint: null }]);
    expect((await client.query("update generation_jobs set request_fingerprint = $1 where id = $2", [HASH, jobId])).affectedRows).toBe(1);
    await actAsAuthenticated(client, CLIENT);
    expect((await client.query("update generation_jobs set request_fingerprint = NULL where id = $1", [jobId])).affectedRows).toBe(0);
    expect((await client.query<{ request_fingerprint: string }>("select request_fingerprint from generation_jobs where id = $1", [jobId])).rows[0].request_fingerprint).toBe(HASH);
    await actAsAuthenticated(client, OTHER);
    expect((await client.query("select request_fingerprint from generation_jobs where id = $1", [jobId])).rows).toHaveLength(0);
  });
});
