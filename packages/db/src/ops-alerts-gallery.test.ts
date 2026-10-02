import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actAsAnon, actAsAuthenticated, actAsSuperuser } from "./test-helpers";
import { createPhase20MigrationDb, platformPrivileges } from "./phase20-platform-test-helpers";

const WS = "00000000-0000-4000-8000-000000004301";
const OWNER = "00000000-0000-4000-8000-000000004302";

describe("ops_alerts_gallery", () => {
  let client: PGlite;
  beforeAll(async () => {
    client = await createPhase20MigrationDb(async (before, tag) => {
      if (!tag.endsWith("_ops_alerts_gallery")) return;
      await before.query("insert into workspaces (id, name) values ($1, 'Gallery')", [WS]);
      await before.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [WS, OWNER]);
      await before.query("insert into gallery_items (workspace_id, category, consent_at, published) values ($1, 'legacy', now(), true)", [WS]);
    });
    await client.query("insert into gallery_items (workspace_id, category, consent_at, published, review_status) values ($1, 'pending', now(), true, 'pending'), ($1, 'rejected', now(), true, 'rejected'), ($1, 'unpublished', now(), false, 'approved')", [WS]);
    await client.query("insert into ops_alerts (rule, subject, detail) values ('failed_pack', 'job:1', '{\"reason\":\"failed\"}')");
  });
  afterEach(async () => { await actAsSuperuser(client); });
  afterAll(async () => { await client.close(); });

  it("preserves previously published rows and exposes approved published items only", async () => {
    await actAsAnon(client);
    expect((await client.query<{ category: string; review_status: string }>("select category, review_status from gallery_items")).rows).toEqual([{ category: "legacy", review_status: "approved" }]);
    await actAsAuthenticated(client, OWNER);
    expect((await client.query("select * from gallery_items")).rows).toHaveLength(4);
    const changed = await client.query("update gallery_items set review_status = 'approved' returning id").then((r) => r.rows.length).catch(() => 0);
    expect(changed).toBe(0);
  });

  it("allows one open alert per rule and subject and preserves resolved history", async () => {
    await expect(client.query("insert into ops_alerts (rule, subject) values ('failed_pack', 'job:1')")).rejects.toThrow("ops_alerts_open_rule_subject_uq");
    await client.query("update ops_alerts set status = 'resolved', resolved_at = now() where rule = 'failed_pack'");
    await client.query("insert into ops_alerts (rule, subject) values ('failed_pack', 'job:1')");
    expect((await client.query("select * from ops_alerts where rule = 'failed_pack'")).rows).toHaveLength(2);
    await expect(client.query("update ops_alerts set count = 0")).rejects.toThrow("ops_alerts_count_positive");
    await expect(client.query("update ops_alerts set detail = '[]'")).rejects.toThrow("ops_alerts_detail_object");
  });

  it("revokes client privileges and has RLS with the restrictive OAuth policy only", async () => {
    expect(await platformPrivileges(client, "ops_alerts")).toEqual([]);
    expect((await client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'ops_alerts'")).rows).toEqual([{ relrowsecurity: true }]);
    const policies = await client.query<{ policyname: string; permissive: string }>("select policyname, permissive from pg_policies where tablename = 'ops_alerts'");
    expect(policies.rows).toEqual([{ policyname: "no_oauth_clients", permissive: "RESTRICTIVE" }]);
    for (const become of [() => actAsAnon(client), () => actAsAuthenticated(client, OWNER)]) {
      await become();
      await expect(client.query("select * from ops_alerts")).rejects.toThrow(/permission denied/);
      await expect(client.query("insert into ops_alerts (rule, subject) values ('forged', 'subject')")).rejects.toThrow(/permission denied/);
      await expect(client.query("update ops_alerts set count = 2")).rejects.toThrow(/permission denied/);
      await expect(client.query("delete from ops_alerts")).rejects.toThrow(/permission denied/);
    }
  });
});
