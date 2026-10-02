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
import { shareLinks, workspaces } from "./schema";

// Migration share_proof (docs/phases/PHASE_18.md P18-16): share_links gains
// show_proof, off by default. RLS is unchanged: members read their own
// workspace's rows, and no client (owner, client seat or anon) writes the
// column; only the server's owner connection does.

const OWNER_A = "00000000-0000-4000-8000-0000000018c1";
const CLIENT_A = "00000000-0000-4000-8000-0000000018c2";
const OWNER_B = "00000000-0000-4000-8000-0000000018d1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let jobA: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  await client.query(
    "insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'client'), ($4, $5, 'owner')",
    [wsA, OWNER_A, CLIENT_A, b.id, OWNER_B],
  );
  const product = await client.query<{ id: string }>(
    "insert into products (workspace_id, title, mode) values ($1, 'Candle', 'listing') returning id",
    [wsA],
  );
  const job = await client.query<{ id: string }>(
    "insert into generation_jobs (workspace_id, product_id, status) values ($1, $2, 'done') returning id",
    [wsA, product.rows[0].id],
  );
  jobA = job.rows[0].id;
  await db.insert(shareLinks).values({ slug: "proofslug2", workspaceId: wsA, jobId: jobA, isPublic: true });
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await actAsSuperuser(client);
  await client.close();
});

async function showProof(): Promise<boolean> {
  await actAsSuperuser(client);
  const rows = await client.query<{ show_proof: boolean }>("select show_proof from share_links where slug = 'proofslug2'");
  return rows.rows[0].show_proof;
}

describe("share_links.show_proof", () => {
  it("defaults to off and is never null", async () => {
    expect(await showProof()).toBe(false);
    await expect(client.query("update share_links set show_proof = null where slug = 'proofslug2'")).rejects.toThrow();
  });

  it("lets members of the workspace read it, and nobody else", async () => {
    for (const member of [OWNER_A, CLIENT_A]) {
      await actAs(client, member);
      const rows = await client.query<{ show_proof: boolean }>("select show_proof from share_links");
      expect(rows.rows).toEqual([{ show_proof: false }]);
    }
    await actAs(client, OWNER_B);
    expect((await client.query("select show_proof from share_links")).rows).toHaveLength(0);
    await actAsAnon(client);
    expect((await client.query("select show_proof from share_links")).rows).toHaveLength(0);
  });

  it("refuses client writes: members, signed in users and anon cannot turn it on", async () => {
    for (const become of [
      () => actAs(client, OWNER_A),
      () => actAs(client, CLIENT_A),
      () => actAsAuthenticated(client, OWNER_A),
      () => actAsAnon(client),
    ]) {
      await become();
      // RLS has no update policy, so the update matches no row or is refused.
      await client.query("update share_links set show_proof = true where slug = 'proofslug2'").catch(() => undefined);
      await expect(
        client.query(
          "insert into share_links (slug, workspace_id, job_id, public, show_proof) values ('forgedslug', $1, null, true, true)",
          [wsA],
        ),
      ).rejects.toThrow(/permission denied|row-level security/);
      expect(await showProof()).toBe(false);
    }
  });

  it("is written by the server", async () => {
    await actAsServiceRole(client);
    await client.query("update share_links set show_proof = true where slug = 'proofslug2'");
    expect(await showProof()).toBe(true);
  });
});
