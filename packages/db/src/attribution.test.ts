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
import { signupAttributions, workspaces } from "./schema";

// Migration attribution_and_funnel (docs/phases/PHASE_18.md P18-01 and
// P18-02, CLAUDE.md rule 5): signup_attributions is read by the owners and
// admins of its workspace and written only by the owner connection; client
// roles cannot write funnel or billing names into events.

const OWNER_A = "00000000-0000-4000-8000-0000000018a1";
const ADMIN_A = "00000000-0000-4000-8000-0000000018a2";
const EDITOR_A = "00000000-0000-4000-8000-0000000018a3";
const CLIENT_A = "00000000-0000-4000-8000-0000000018a4";
const OWNER_B = "00000000-0000-4000-8000-0000000018b1";
const NEW_USER = "00000000-0000-4000-8000-0000000018c1";

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
       ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'editor'), ($1, $5, 'client'), ($6, $7, 'owner')`,
    [wsA, OWNER_A, ADMIN_A, EDITOR_A, CLIENT_A, wsB, OWNER_B],
  );
  await db.insert(signupAttributions).values([
    {
      userId: OWNER_A,
      workspaceId: wsA,
      selfReported: "reddit",
      source: "home",
      utmSource: "reddit",
      utmCampaign: "label_test",
      consent: "granted",
      method: "email",
    },
    { userId: OWNER_B, workspaceId: wsB, selfReported: "search", source: "pricing", consent: null },
  ]);
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("signup_attributions (attribution_and_funnel)", () => {
  it("has row level security on", async () => {
    const result = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'signup_attributions'",
    );
    expect(result.rows[0]?.relrowsecurity).toBe(true);
  });

  it("shows owners and admins their own workspace's row only", async () => {
    for (const user of [OWNER_A, ADMIN_A]) {
      for (const become of [() => actAs(client, user), () => actAsAuthenticated(client, user)]) {
        await become();
        const rows = await client.query<{ user_id: string; utm_campaign: string }>(
          "select user_id, utm_campaign from signup_attributions",
        );
        expect(rows.rows).toEqual([{ user_id: OWNER_A, utm_campaign: "label_test" }]);
        await actAsSuperuser(client);
      }
    }
  });

  it("shows editors, client seats, other workspaces and anon nothing of workspace A", async () => {
    for (const user of [EDITOR_A, CLIENT_A]) {
      await actAsAuthenticated(client, user);
      expect((await client.query("select * from signup_attributions")).rows).toHaveLength(0);
    }
    await actAsAuthenticated(client, OWNER_B);
    const own = await client.query<{ user_id: string }>("select user_id from signup_attributions");
    expect(own.rows).toEqual([{ user_id: OWNER_B }]);
    await actAsAnon(client);
    expect((await client.query("select * from signup_attributions")).rows).toHaveLength(0);
  });

  it("never lets a client role insert, rewrite or delete a row", async () => {
    for (const user of [OWNER_A, ADMIN_A]) {
      await actAsAuthenticated(client, user);
      await expect(
        client.query(
          "insert into signup_attributions (user_id, workspace_id, source) values ($1, $2, 'home')",
          [NEW_USER, wsA],
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
      const updated = await client.query("update signup_attributions set utm_source = 'forged'");
      expect(updated.affectedRows ?? 0).toBe(0);
      const deleted = await client.query("delete from signup_attributions");
      expect(deleted.affectedRows ?? 0).toBe(0);
      await actAsSuperuser(client);
    }
    await actAsAnon(client);
    await expect(
      client.query("insert into signup_attributions (user_id, workspace_id) values ($1, $2)", [NEW_USER, wsA]),
    ).rejects.toThrow(/row-level security|permission denied/);
    await actAsSuperuser(client);
    const rows = await client.query<{ utm_source: string | null }>(
      "select utm_source from signup_attributions where user_id = $1",
      [OWNER_A],
    );
    expect(rows.rows).toEqual([{ utm_source: "reddit" }]);
  });

  it("lets the owner connection write once per user", async () => {
    await actAsServiceRole(client);
    const first = await client.query(
      "insert into signup_attributions (user_id, workspace_id, source) values ($1, $2, 'share') on conflict (user_id) do nothing returning user_id",
      [NEW_USER, wsA],
    );
    expect(first.rows).toHaveLength(1);
    const second = await client.query(
      "insert into signup_attributions (user_id, workspace_id, source) values ($1, $2, 'home') on conflict (user_id) do nothing returning user_id",
      [NEW_USER, wsA],
    );
    expect(second.rows).toHaveLength(0);
    const stored = await client.query<{ source: string; method: string }>(
      "select source, method from signup_attributions where user_id = $1",
      [NEW_USER],
    );
    expect(stored.rows).toEqual([{ source: "share", method: "email" }]);
  });

  it("refuses values past the caps and unknown consent or method values", async () => {
    await actAsSuperuser(client);
    const user = "00000000-0000-4000-8000-0000000018d1";
    await expect(
      client.query("insert into signup_attributions (user_id, workspace_id, utm_source) values ($1, $2, $3)", [
        user,
        wsA,
        "a".repeat(101),
      ]),
    ).rejects.toThrow(/signup_attributions_lengths_check/);
    await expect(
      client.query("insert into signup_attributions (user_id, workspace_id, self_reported_other) values ($1, $2, $3)", [
        user,
        wsA,
        "b".repeat(81),
      ]),
    ).rejects.toThrow(/signup_attributions_lengths_check/);
    await expect(
      client.query("insert into signup_attributions (user_id, workspace_id, consent) values ($1, $2, 'maybe')", [user, wsA]),
    ).rejects.toThrow(/signup_attributions_consent_check/);
    await expect(
      client.query("insert into signup_attributions (user_id, workspace_id, method) values ($1, $2, 'magic')", [user, wsA]),
    ).rejects.toThrow(/signup_attributions_method_check/);
  });

  it("goes with its workspace", async () => {
    await actAsSuperuser(client);
    const [c] = await db.insert(workspaces).values({ name: "C" }).returning();
    const user = "00000000-0000-4000-8000-0000000018e1";
    await db.insert(signupAttributions).values({ userId: user, workspaceId: c.id, source: "help" });
    await client.query("delete from workspaces where id = $1", [c.id]);
    const rows = await client.query("select * from signup_attributions where user_id = $1", [user]);
    expect(rows.rows).toHaveLength(0);
  });
});

describe("events written only by the server (attribution_and_funnel)", () => {
  it("refuses funnel, billing and operator names from members, and keeps client analytics names working", async () => {
    await actAsAuthenticated(client, OWNER_A);
    // ops:prospect_credits feeds the operator's monthly prospect credit cap
    // (P18-04): a forged negative row would lift it.
    for (const name of ["funnel.payment", "funnel.first_pack_done", "billing:stripe:clawback:ch_1", "ops:prospect_credits"]) {
      await expect(
        client.query("insert into events (workspace_id, name) values ($1, $2)", [wsA, name]),
      ).rejects.toThrow(/row-level security/);
    }
    await client.query("insert into events (workspace_id, name) values ($1, 'asset_viewed')", [wsA]);
    await actAsSuperuser(client);
    const rows = await client.query<{ name: string }>(
      "select name from events where workspace_id = $1 order by id",
      [wsA],
    );
    expect(rows.rows.map((row) => row.name)).toEqual(["asset_viewed"]);
  });

  it("keeps one funnel.first_<step> row per workspace", async () => {
    await actAsSuperuser(client);
    await client.query("insert into events (workspace_id, name) values ($1, 'funnel.first_download')", [wsB]);
    await expect(
      client.query("insert into events (workspace_id, name) values ($1, 'funnel.first_download')", [wsB]),
    ).rejects.toThrow(/events_funnel_first_uq|duplicate key/);
    // Plain steps repeat freely, and another workspace has its own first row.
    await client.query("insert into events (workspace_id, name) values ($1, 'funnel.download'), ($1, 'funnel.download')", [wsB]);
    await client.query("insert into events (workspace_id, name) values ($1, 'funnel.first_download')", [wsA]);
  });
});
