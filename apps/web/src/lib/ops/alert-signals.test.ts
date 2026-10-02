import { afterAll, beforeAll, expect, it } from "vitest";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { grossMargin, priceFloor } from "@curvi/pipeline/economics";
import { costCaps } from "@curvi/pipeline/seed";
import { readOpsAlertSignals } from "./alert-signals";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { fixture = await createTestDb(); });
afterAll(async () => { await fixture.client.close(); });

it("joins only today's exact workspace counters and measures delivered plus failed shot costs", async () => {
  const c = fixture.client, ws = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", product = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", job = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await c.query("insert into workspaces(id,name,plan) values($1,'Alerts','growth')", [ws]);
  await c.query("insert into products(id,workspace_id,title,mode) values($1,$2,'Mug','listing')", [product, ws]);
  await c.query("insert into generation_jobs(id,workspace_id,product_id,status,finished_at) values($1,$2,$3,'done','2026-10-01')", [job, ws, product]);
  await c.query("insert into spend_cap_counters(key,total_micros) values($1,11000000),($2,999999999),('caps:workspace:malformed:2026-10-02',999999999)", [`caps:workspace:${ws}:2026-10-02`, `caps:workspace:${ws}:2026-10-01`]);
  for (const [type, approved, qc] of [
    ["lifestyle", true, { costMicros: 100000, shot: { credits: 1 } }],
    ["lifestyle", false, { costMicros: 50000 }],
    ["main", true, { costMicros: 0, shot: { credits: 0.5 } }],
  ] as const) await c.query("insert into assets(workspace_id,job_id,shot_type,approved,qc) values($1,$2,$3,$4,$5)", [ws, job, type, approved, JSON.stringify(qc)]);
  const signals = await readOpsAlertSignals(fixture.db as unknown as Db, new Date("2026-10-02"), new Date(Date.now() + 30_000));
  expect(signals.workspaceCaps).toEqual([{ workspaceId: ws, usedMicros: 11_000_000, limitMicros: costCaps.workspaceExpectedDailyMicrosByTier.growth * costCaps.workspaceDailyMultiplier }]);
  expect(signals.shotMargins).toEqual(expect.arrayContaining([
    { shotType: "lifestyle", grossMargin: grossMargin(priceFloor().net.netRevenuePerCredit, 0.15) },
    { shotType: "main", grossMargin: 1 },
  ]));
});

it("leaves margin alerts unchanged when the window has missing historical QC telemetry", async () => {
  await fixture.client.query("insert into assets(workspace_id,job_id,shot_type,approved,qc) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc','unknown',true,'{}')");
  const signals = await readOpsAlertSignals(fixture.db as unknown as Db, new Date("2026-10-02"), new Date(Date.now() + 30_000));
  expect(signals).not.toHaveProperty("shotMargins");
  expect(signals.workspaceCaps).toHaveLength(1);
});

it("does not start telemetry once the tick budget is exhausted", async () => {
  await expect(readOpsAlertSignals(fixture.db as unknown as Db, new Date(), new Date(0))).rejects.toThrow(/budget/);
});
