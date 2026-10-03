import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actAsAnon, actAsAuthenticated, actAsJwt, actAsSuperuser, createTestDb } from "./test-helpers";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let workspace: string;
const users = { owner: randomUUID(), admin: randomUUID(), editor: randomUUID(), client: randomUUID() };
let key: string;
beforeAll(async () => {
  ({ client } = await createTestDb());
  workspace = (await client.query<{ id: string }>("insert into workspaces(name) values('Source retirement') returning id")).rows[0].id;
  key = `ws/${workspace}/src/retired`;
  for (const [role, user] of Object.entries(users)) await client.query("insert into members(workspace_id,user_id,role) values($1,$2,$3)", [workspace, user, role]);
  await client.query("insert into retired_source_objects(workspace_id,r2_key) values($1,$2)", [workspace, key]);
});
afterEach(async () => { await actAsSuperuser(client); });
afterAll(async () => { await client.close(); });

describe("durable source retirement", () => {
  it.each(Object.keys(users) as Array<keyof typeof users>)("denies %s reads and writes even with blanket table grants", async (role) => {
    await actAsAuthenticated(client, users[role]);
    expect((await client.query("select * from retired_source_objects")).rows).toEqual([]);
    await expect(client.query("insert into retired_source_objects(workspace_id,r2_key) values($1,$2)", [workspace, `${key}-forged`])).rejects.toThrow("row-level security");
    expect((await client.query("delete from retired_source_objects returning r2_key")).rows).toEqual([]);
    expect((await client.query("update retired_source_objects set retired_at=now() returning r2_key")).rows).toEqual([]);
    await actAsSuperuser(client);
    expect((await client.query("select * from retired_source_objects where r2_key=$1", [key])).rows).toHaveLength(1);
  });

  it("hides markers from OAuth clients, strangers and anonymous callers", async () => {
    await actAsJwt(client, { sub: users.owner, client_id: "oauth-client" });
    expect((await client.query("select * from retired_source_objects")).rows).toEqual([]);
    await expect(client.query("insert into retired_source_objects(workspace_id,r2_key) values($1,$2)", [workspace, `${key}-oauth`])).rejects.toThrow("row-level security");
    await actAsAuthenticated(client, randomUUID());
    expect((await client.query("select * from retired_source_objects")).rows).toEqual([]);
    await actAsAnon(client);
    expect((await client.query("select * from retired_source_objects")).rows).toEqual([]);
  });

  it("lets the server retire keys, refuses malformed/cross-workspace keys, and retains markers until workspace deletion", async () => {
    await client.exec("set role service_role");
    await client.query("insert into retired_source_objects(workspace_id,r2_key,retired_at) values($1,$2,'2000-01-01')", [workspace, `${key}-old`]);
    expect((await client.query("select * from retired_source_objects where workspace_id=$1", [workspace])).rows).toHaveLength(2);
    for (const bad of [`ws/${randomUUID()}/src/foreign`, `ws/${workspace}/`, `ws/${workspace}/src/../x`, `ws/${workspace}/src/back\\slash`, `ws/${workspace}/src/${"x".repeat(1024)}`]) {
      await expect(client.query("insert into retired_source_objects(workspace_id,r2_key) values($1,$2)", [workspace, bad])).rejects.toThrow("retired_source_objects_workspace_key");
    }
    const temp = (await client.query<{ id: string }>("insert into workspaces(name) values('Retired tenant') returning id")).rows[0].id;
    await client.query("insert into retired_source_objects(workspace_id,r2_key) values($1,$2)", [temp, `ws/${temp}/src/gone`]);
    await client.query("delete from workspaces where id=$1", [temp]);
    expect((await client.query("select * from retired_source_objects where workspace_id=$1", [temp])).rows).toEqual([]);
  });
});
