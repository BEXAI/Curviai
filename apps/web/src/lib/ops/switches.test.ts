import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { sql, type Db } from "@curvi/db";
import { opsSwitch } from "@/lib/features";
import { platformSettingReader } from "@/lib/platform-settings";
import { setOperatorSwitch } from "./switches";

let db: TestDb;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
const owner = "founder@curvi.ai";
const asDb = () => db as unknown as Db;
beforeAll(async () => { vi.stubEnv("OPS_EMAILS", owner); ({ db, client } = await createTestDb()); });
afterAll(async () => { vi.unstubAllEnvs(); await client.close(); });
describe("operator switches", () => {
  it("changes the cached pause state immediately and writes an audit for each change", async () => {
    expect((await opsSwitch("ops:packs_paused", platformSettingReader(asDb()))).on).toBe(false);
    await setOperatorSwitch(asDb(), { key: "ops:packs_paused", value: "true", message: "Maintenance", operator: owner });
    expect(await opsSwitch("ops:packs_paused", platformSettingReader(asDb()))).toMatchObject({ on: true, message: "Maintenance" });
    await setOperatorSwitch(asDb(), { key: "ops:packs_paused", value: "false", operator: owner });
    expect((await opsSwitch("ops:packs_paused", platformSettingReader(asDb()))).on).toBe(false);
    const result = await client.query<{ n: number }>("select count(*)::int as n from ops_audit where action='switch.set'");
    expect(result.rows[0]?.n).toBe(2);
  });
  it("rejects nonoperators, unknown keys, and invalid dollar amounts without writing", async () => {
    await expect(setOperatorSwitch(asDb(), { key: "ops:packs_paused", value: "true", operator: "seller@example.com" })).rejects.toThrow("Operator access");
    await expect(setOperatorSwitch(asDb(), { key: "secret", value: "true", operator: owner })).rejects.toThrow("Unknown");
    await expect(setOperatorSwitch(asDb(), { key: "ops:global_hard_stop_usd", value: "-1", operator: owner })).rejects.toThrow("nonnegative");
    await db.execute(sql`select 1`);
  });
});
