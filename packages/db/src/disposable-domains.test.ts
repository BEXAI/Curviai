import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actAsAnon, actAsAuthenticated, actAsSuperuser } from "./test-helpers";
import { createPhase20MigrationDb, platformPrivileges } from "./phase20-platform-test-helpers";

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

describe("disposable_domains: confirmed signup grants", () => {
  let client: PGlite;
  beforeAll(async () => {
    client = await createPhase20MigrationDb();
    await client.query("insert into platform_settings (key, value) values ('free_signup_credits', '7')");
    await client.query("insert into disposable_email_domains (domain) values ('throwaway.example')");
  });
  afterEach(async () => { await actAsSuperuser(client); });
  afterAll(async () => { await client.close(); });

  async function grant(user: string) {
    return (await client.query<{ credits: string; withheld_reason: string | null }>("select credits::text, withheld_reason from signup_grants where user_id = $1", [user])).rows;
  }

  it.each([
    [1, "seller@throwaway.example"],
    [2, "seller@child.throwaway.example"],
    [3, "Seller@Deep.Child.Throwaway.Example"],
  ])("withholds confirmed disposable address %i without stopping signup", async (n, email) => {
    const user = uid(n);
    await client.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [user, email]);
    expect(await grant(user)).toEqual([{ credits: "0.0", withheld_reason: "disposable_email" }]);
    expect((await client.query("select workspace_id from members where user_id = $1", [user])).rows).toHaveLength(1);
    const withheld = await client.query("select id from events where name = 'free_grant_withheld' and workspace_id in (select workspace_id from members where user_id = $1)", [user]);
    expect(withheld.rows).toHaveLength(1);
    await client.query("select grant_signup_credits($1)", [user]);
    expect(await grant(user)).toHaveLength(1);
    expect((await client.query("select id from credit_ledger where workspace_id in (select workspace_id from members where user_id = $1)", [user])).rows).toHaveLength(0);
  });

  it.each([[4, "seller@normal.example"], [5, "seller@notthrowaway.example"], [6, "seller@throwaway.example.normal.example"]])("pays a legitimate or lookalike domain %i once", async (n, email) => {
    const user = uid(n);
    await client.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [user, email]);
    expect(await grant(user)).toEqual([{ credits: "7.0", withheld_reason: null }]);
    await client.query("select grant_signup_credits($1)", [user]);
    expect((await client.query("select id from credit_ledger where workspace_id in (select workspace_id from members where user_id = $1)", [user])).rows).toHaveLength(1);
  });

  it("waits for confirmation and retains normalized email deduplication", async () => {
    await client.query("insert into auth.users (id, email) values ($1, 'wait@throwaway.example')", [uid(7)]);
    expect(await grant(uid(7))).toEqual([]);
    await client.query("update auth.users set email_confirmed_at = now() where id = $1", [uid(7)]);
    expect(await grant(uid(7))).toEqual([{ credits: "0.0", withheld_reason: "disposable_email" }]);
    await client.query("insert into auth.users (id, email, email_confirmed_at) values ($1, 'seller+second@normal.example', now())", [uid(8)]);
    expect(await grant(uid(8))).toEqual([{ credits: "0.0", withheld_reason: "email_already_granted" }]);
  });

  it("keeps the list private with revoked privileges and the OAuth restriction", async () => {
    expect(await platformPrivileges(client, "disposable_email_domains")).toEqual([]);
    const policy = await client.query<{ policyname: string; permissive: string }>("select policyname, permissive from pg_policies where tablename = 'disposable_email_domains'");
    expect(policy.rows).toEqual([{ policyname: "no_oauth_clients", permissive: "RESTRICTIVE" }]);
    expect((await client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'disposable_email_domains'")).rows).toEqual([{ relrowsecurity: true }]);
    for (const become of [() => actAsAnon(client), () => actAsAuthenticated(client, uid(1))]) {
      await become();
      for (const statement of [
        "select * from disposable_email_domains",
        "insert into disposable_email_domains (domain) values ('forged.example')",
        "update disposable_email_domains set domain = 'changed.example'",
        "delete from disposable_email_domains",
        "truncate disposable_email_domains",
        `select grant_signup_credits('${uid(1)}')`,
      ]) await expect(client.query(statement)).rejects.toThrow(/permission denied/);
    }
  });
});
