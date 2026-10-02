import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { tierByKey } from "@curvi/pipeline/seed";
import { operatorWorkspaceIds } from "@/lib/customer-metrics";
import { loadFunnelReport } from "@/lib/funnel-report";
import { DbMetricsReader } from "./weekly-report";
import { loadEconomicsInputs } from "./economics";
import { readOpsAlertSignals } from "./alert-signals";
import { evaluateOpsAlerts } from "./alerts";

const now = new Date("2026-10-05T13:00:00Z");
const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const customer = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const operator = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const product = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const syntheticProduct = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const customerJob = "11111111-1111-4111-8111-111111111111";
const syntheticJob = "22222222-2222-4222-8222-222222222222";
let fixture: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
beforeAll(async () => {
  fixture = await createTestDb(); db = fixture.db as unknown as Db;
  vi.stubEnv("OPS_EMAILS", "FOUNDER@curvi.test");
  const c = fixture.client;
  await c.exec("create schema if not exists auth; create table if not exists auth.users(id uuid primary key,email text,created_at timestamptz default now())");
  await c.query("insert into auth.users(id,email,created_at) values($1,'founder@curvi.test','2026-09-01')", [user]);
  await c.query("insert into workspaces(id,name,plan,created_at) values($1,'Customer','starter','2026-09-01'),($2,'Synthetic','growth','2026-09-01')", [customer, operator]);
  await c.query("insert into members(workspace_id,user_id,role) values($1,$2,'owner')", [operator, user]);
  await c.query("insert into products(id,workspace_id,title,mode) values($1,$2,'Customer','listing'),($3,$4,'Synthetic','listing')", [product, customer, syntheticProduct, operator]);
  await c.query("insert into subscriptions(workspace_id,tier,cadence,status,created_at) values($1,'starter','monthly','active','2026-09-01'),($2,'growth','monthly','active','2026-09-01')", [customer, operator]);
  for (const [id, ws, p, cost] of [[customerJob, customer, product, 100000], [syntheticJob, operator, syntheticProduct, 200000]] as const) {
    await c.query("insert into generation_jobs(id,workspace_id,product_id,status,created_at,finished_at,credits_charged,cogs_micros) values($1,$2,$3,'done','2026-10-04','2026-10-04',1,$4)", [id, ws, p, cost]);
    await c.query("insert into assets(workspace_id,job_id,shot_type,approved,qc) values($1,$2,'main',true,$3)", [ws, id, JSON.stringify({ costMicros: cost, shot: { credits: 1, method: "deterministic" } })]);
    await c.query("insert into events(workspace_id,name,props,at) values($1,'funnel.payment','{\"kind\":\"topup\",\"amount_usd\":12}','2026-10-04'),($1,'funnel.first_payment','{}','2026-10-04')", [ws]);
  }
  await c.query("insert into spend_cap_counters(key,total_micros) values('caps:global:2026-10-05',300000),($1,11000000)", [`caps:workspace:${operator}:2026-10-05`]);
});
afterAll(async () => { vi.unstubAllEnvs(); await fixture.client.close(); });

it("uses the same authoritative ownership policy for weekly revenue and funnel retention", async () => {
  expect(await operatorWorkspaceIds(db)).toEqual([operator]);
  const metrics = await new DbMetricsReader(db, { now, databaseBytes: async () => null, storageBytes: async () => null }).read();
  expect(metrics).toMatchObject({ excludedWorkspaces: 1, mrrUsd: tierByKey("starter").monthlyUsd, topUpsUsd: 12, cogsUsd: 0.1, allPackCogsUsd: 0.3, paidPacksMonth: 1, payingCustomers: 1, dailySpendUsd: 0.3 });
  expect(metrics.packs.started).toBe(1);
  const funnel = await loadFunnelReport(db, { now, operatorEmails: ["founder@curvi.test"] });
  expect(funnel.excludedWorkspaces).toBe(1);
  expect(funnel.week.payments).toBe(1);
});

it("excludes synthetic shot economics while retaining its workspace safety cap", async () => {
  const inputs = await loadEconomicsInputs(db, { since: new Date("2026-10-01"), until: now });
  expect(inputs.packs.map((pack) => pack.jobId)).toEqual([customerJob]);
  const signals = await readOpsAlertSignals(db, now, new Date(Date.now() + 30000));
  expect(signals.workspaceCaps?.map((cap) => cap.workspaceId)).toContain(operator);
  expect(signals.shotMargins).toHaveLength(1);
});

it("excludes synthetic customer-failure metrics but still alerts on an orphaned synthetic job", async () => {
  await fixture.client.query("update generation_jobs set status='failed',updated_at=$1,finished_at=$1 where id=$2", [now.toISOString(), syntheticJob]);
  const notify = vi.fn(async () => true);
  const first = await evaluateOpsAlerts(db, { now, notify });
  expect(first.opened).toBe(0);
  await fixture.client.query("update generation_jobs set status='generating',heartbeat_at='2026-10-01',updated_at='2026-10-01' where id=$1", [syntheticJob]);
  expect((await evaluateOpsAlerts(db, { now, notify })).opened).toBe(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ rule: "stale_job", subject: syntheticJob }));
});
