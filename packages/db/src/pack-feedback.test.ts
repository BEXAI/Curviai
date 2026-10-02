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
import { packFeedback, workspaces } from "./schema";

// Migration pack_feedback (docs/phases/PHASE_18.md P18-05, CLAUDE.md
// rule 5): members of a workspace read its pack answers; nobody writes them
// through a client role, the workspace owner included. Only the server's
// owner connection does, once per pack and person.

const OWNER_A = "00000000-0000-4000-8000-0000000018e1";
const CLIENT_A = "00000000-0000-4000-8000-0000000018e2";
const OWNER_B = "00000000-0000-4000-8000-0000000018f1";
const NEW_USER = "00000000-0000-4000-8000-0000000018f2";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let jobA: string;

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
    "insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'client'), ($4, $5, 'owner')",
    [wsA, OWNER_A, CLIENT_A, wsB, OWNER_B],
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
  await db.insert(packFeedback).values({
    workspaceId: wsA,
    jobId: jobA,
    userId: OWNER_A,
    usable: "yes",
    wouldPay: "maybe",
    comment: "The scenes look real.",
    quoteConsent: true,
    displayName: "Ana, Juniper Candles",
  });
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await actAsSuperuser(client);
  await client.close();
});

describe("pack_feedback (pack_feedback)", () => {
  it("has row level security on", async () => {
    const result = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'pack_feedback'",
    );
    expect(result.rows[0]?.relrowsecurity).toBe(true);
  });

  it("shows members of the workspace its answers, and nobody else", async () => {
    for (const member of [OWNER_A, CLIENT_A]) {
      for (const become of [() => actAs(client, member), () => actAsAuthenticated(client, member)]) {
        await become();
        const rows = await client.query<{ usable: string }>("select usable from pack_feedback");
        expect(rows.rows).toEqual([{ usable: "yes" }]);
        await actAsSuperuser(client);
      }
    }
    await actAsAuthenticated(client, OWNER_B);
    expect((await client.query("select * from pack_feedback")).rows).toHaveLength(0);
    await actAsAnon(client);
    expect((await client.query("select * from pack_feedback")).rows).toHaveLength(0);
  });

  it("never lets a client role insert, rewrite or delete an answer", async () => {
    for (const member of [OWNER_A, CLIENT_A]) {
      await actAsAuthenticated(client, member);
      await expect(
        client.query(
          "insert into pack_feedback (workspace_id, job_id, user_id, usable) values ($1, $2, $3, 'yes')",
          [wsA, jobA, member === OWNER_A ? NEW_USER : member],
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
      const updated = await client.query("update pack_feedback set usable = 'not_yet', quote_consent = false");
      expect(updated.affectedRows ?? 0).toBe(0);
      const deleted = await client.query("delete from pack_feedback");
      expect(deleted.affectedRows ?? 0).toBe(0);
      await actAsSuperuser(client);
    }
    await actAsAnon(client);
    await expect(
      client.query("insert into pack_feedback (workspace_id, job_id, user_id, usable) values ($1, $2, $3, 'yes')", [
        wsA,
        jobA,
        NEW_USER,
      ]),
    ).rejects.toThrow(/row-level security|permission denied/);
    await actAsSuperuser(client);
    const rows = await client.query<{ usable: string; quote_consent: boolean }>(
      "select usable, quote_consent from pack_feedback",
    );
    expect(rows.rows).toEqual([{ usable: "yes", quote_consent: true }]);
  });

  it("keeps one answer per pack and person for the owner connection", async () => {
    await actAsServiceRole(client);
    const first = await client.query(
      "insert into pack_feedback (workspace_id, job_id, user_id, usable) values ($1, $2, $3, 'some') on conflict (job_id, user_id) do nothing returning id",
      [wsA, jobA, CLIENT_A],
    );
    expect(first.rows).toHaveLength(1);
    const again = await client.query(
      "insert into pack_feedback (workspace_id, job_id, user_id, usable) values ($1, $2, $3, 'yes') on conflict (job_id, user_id) do nothing returning id",
      [wsA, jobA, CLIENT_A],
    );
    expect(again.rows).toHaveLength(0);
  });

  it("refuses unknown answers, long text and a quote with nothing to quote", async () => {
    await actAsSuperuser(client);
    const insert = (values: string) =>
      client.query(
        `insert into pack_feedback (workspace_id, job_id, user_id, usable, would_pay, comment, quote_consent, display_name) values ${values}`,
        [wsA, jobA],
      );
    await expect(insert(`($1, $2, '${NEW_USER}', 'maybe', null, null, false, null)`)).rejects.toThrow(/usable_check/);
    await expect(insert(`($1, $2, '${NEW_USER}', 'yes', 'sure', null, false, null)`)).rejects.toThrow(/would_pay_check/);
    await expect(insert(`($1, $2, '${NEW_USER}', 'yes', null, repeat('a', 501), false, null)`)).rejects.toThrow(
      /lengths_check/,
    );
    await expect(insert(`($1, $2, '${NEW_USER}', 'yes', null, 'ok', false, repeat('a', 61))`)).rejects.toThrow(
      /lengths_check/,
    );
    await expect(insert(`($1, $2, '${NEW_USER}', 'yes', null, '   ', true, 'Ana')`)).rejects.toThrow(/quote_check/);
  });

  it("goes away with its pack", async () => {
    await actAsSuperuser(client);
    const product = await client.query<{ id: string }>(
      "insert into products (workspace_id, title, mode) values ($1, 'Soap', 'listing') returning id",
      [wsB],
    );
    const job = await client.query<{ id: string }>(
      "insert into generation_jobs (workspace_id, product_id, status) values ($1, $2, 'done') returning id",
      [wsB, product.rows[0].id],
    );
    await client.query("insert into pack_feedback (workspace_id, job_id, user_id, usable) values ($1, $2, $3, 'yes')", [
      wsB,
      job.rows[0].id,
      OWNER_B,
    ]);
    await client.query("delete from generation_jobs where id = $1", [job.rows[0].id]);
    const left = await client.query("select * from pack_feedback where workspace_id = $1", [wsB]);
    expect(left.rows).toHaveLength(0);
  });
});
