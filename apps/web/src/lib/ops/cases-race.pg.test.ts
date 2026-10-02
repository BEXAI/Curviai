import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@curvi/db";
import { createRaceDatabase, type RaceDatabase } from "@curvi/db/race";
import { DbCaseStore } from "@/lib/cases/db-store";
import { updateOperatorCase } from "@/lib/ops/cases";
vi.mock("@/lib/ops", () => ({ opsEmails: () => ["case-operator@example.com"] }));
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("case store races on real Postgres", () => {
  let race: RaceDatabase, db: Db, store: DbCaseStore;
  const operator = { userId: randomUUID(), email: "case-operator@example.com" };
  beforeAll(async () => { race = await createRaceDatabase(url!, 5); db = createDb(race.url, { max: 25 }); store = new DbCaseStore(db); }, 120_000);
  afterAll(async () => { await (db as unknown as { $client?: { end(): Promise<void> } } | undefined)?.$client?.end(); await race?.drop(); });
  async function fixture() {
    const [workspace] = await race.sql<{ id: string }[]>`insert into workspaces(name) values('Case race') returning id`;
    const actor = { workspaceId: workspace!.id, userId: randomUUID() };
    await race.sql`insert into members(workspace_id,user_id,role) values(${actor.workspaceId},${actor.userId},'owner')`;
    const [product] = await race.sql<{ id: string }[]>`insert into products(workspace_id,title,mode) values(${actor.workspaceId},'Mug','listing') returning id`;
    const [job] = await race.sql<{ id: string }[]>`insert into generation_jobs(workspace_id,product_id,status) values(${actor.workspaceId},${product!.id},'done') returning id`;
    return { actor, jobId: job!.id };
  }
  const input = () => ({ category: "fidelity" as const, description: "The product label is not clear.", requestId: randomUUID() });
  it("20 identical and distinct request keys create one open case and one intake event", async () => {
    const f = await fixture(), shared = input();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.create(f.actor, f.jobId, index % 2 ? input() : shared)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.case.id)).size).toBe(1);
    const [row] = await race.sql<{ count: number }[]>`select count(*)::int as count from pack_case_events where workspace_id=${f.actor.workspaceId}`;
    expect(row!.count).toBe(1);
  });
  it("parallel resolution retries create one event and audit with no credit changes", async () => {
    const f = await fixture(), opened = await store.create(f.actor, f.jobId, input());
    const resolution = { private: false, status: "resolved" as const, message: "Use a sharper source photo for your next pack.", requestId: randomUUID() };
    await Promise.all(Array.from({ length: 20 }, () => updateOperatorCase(db, operator, opened.case.id, resolution)));
    const [events] = await race.sql<{ count: number }[]>`select count(*)::int as count from pack_case_events where case_id=${opened.case.id}`;
    const [audits] = await race.sql<{ count: number }[]>`select count(*)::int as count from ops_audit where target_id=${opened.case.id}`;
    expect(events!.count).toBe(2); expect(audits!.count).toBe(1);
    expect(await race.sql`select id from credit_ledger where workspace_id=${f.actor.workspaceId}`).toHaveLength(0);
  });
  it("reopening and new reports racing for the same category leave exactly one open case", async () => {
    const f = await fixture(), opened = await store.create(f.actor, f.jobId, input());
    await updateOperatorCase(db, operator, opened.case.id, { private: false, status: "resolved", message: "Please provide a new photo of this product.", requestId: randomUUID() });
    const results = await Promise.allSettled([
      store.reply(f.actor, f.jobId, opened.case.id, { reopen: true, message: "I have a clearer source photo available.", requestId: randomUUID() }),
      ...Array.from({ length: 10 }, () => store.create(f.actor, f.jobId, input())),
    ]);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ reason: "open_case" });
    const open = await race.sql`select id from pack_cases where workspace_id=${f.actor.workspaceId} and status <> 'resolved'`;
    expect(open).toHaveLength(1);
  });
});
