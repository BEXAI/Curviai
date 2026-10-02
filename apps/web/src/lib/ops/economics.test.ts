import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { creditCosts } from "@curvi/pipeline/seed";
import { priceFloor } from "@curvi/pipeline/economics";
import { assets, generationJobs, jobSteps, products, spendCapCounters, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { creditFamiliesOn, formatUnitEconomicsReport, loadEconomicsInputs, unitEconomicsReport } from "./economics";

// docs/phases/PHASE_20.md P20-04: the unit economics report on PGlite
// fixtures. Read only.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60_000;
let doneJob = "";
let failedJob = "";

const asDb = (): Db => db as unknown as Db;

async function job(workspaceId: string, productId: string, status: "done" | "failed", ageDays: number, cogs: number, charged: number) {
  const at = new Date(NOW.getTime() - ageDays * DAY);
  const [row] = await db
    .insert(generationJobs)
    .values({ workspaceId, productId, status, cogsMicros: cogs, creditsCharged: charged, createdAt: at, updatedAt: at })
    .returning();
  return row.id;
}

function qc(method: string, costMicros: number, attempts: number) {
  return { shot: { method }, costMicros, attempts, status: "passed" };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [ws] = await db.insert(workspaces).values({ name: "Economics" }).returning();
  const [product] = await db.insert(products).values({ workspaceId: ws.id, title: "Mug", mode: "listing" }).returning();
  doneJob = await job(ws.id, product.id, "done", 3, 260_000, 3.5);
  failedJob = await job(ws.id, product.id, "failed", 2, 30_000, 0);
  const oldJob = await job(ws.id, product.id, "done", 60, 999_000, 9);
  await db.insert(assets).values([
    { workspaceId: ws.id, jobId: doneJob, shotType: "main", approved: true, qc: qc("deterministic", 10_000, 1) },
    { workspaceId: ws.id, jobId: doneJob, shotType: "lifestyle", approved: true, qc: qc("composite_generate", 60_000, 1) },
    { workspaceId: ws.id, jobId: doneJob, shotType: "lifestyle", approved: true, qc: qc("edit_generate", 90_000, 2) },
    { workspaceId: ws.id, jobId: doneJob, shotType: "lifestyle", approved: false, qc: qc("composite_generate", 40_000, 3) },
    // A failed pack's shots were not charged, approved or not.
    { workspaceId: ws.id, jobId: failedJob, shotType: "main", approved: true, qc: qc("deterministic", 30_000, 1) },
    { workspaceId: ws.id, jobId: oldJob, shotType: "lifestyle", approved: true, qc: qc("composite_generate", 500_000, 1) },
  ]);
  await db.insert(jobSteps).values([
    { workspaceId: ws.id, jobId: doneJob, shotId: "s1", stage: "lifestyle", provider: "worker", status: "done", costMicros: 150_000 },
    { workspaceId: ws.id, jobId: doneJob, shotId: "s2", stage: "lifestyle", provider: "worker", status: "needs_review", costMicros: 40_000 },
    { workspaceId: ws.id, jobId: doneJob, shotId: "s3", stage: "main", provider: "planner", status: "pending", costMicros: 0 },
  ]);
  await db.insert(spendCapCounters).values([
    { key: `llm|job|${doneJob}|openai|cost_micros`, totalMicros: 50_000 },
    { key: `llm|job|${doneJob}|anthropic|cost_micros`, totalMicros: 5_000 },
    { key: `llm|job|${oldJob}|openai|cost_micros`, totalMicros: 70_000 },
    { key: `llm|day|2026-10-17|shot_planner|openai|cost_micros`, totalMicros: 50_000 },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe("unit economics on the database", () => {
  it("reads delivered and undelivered shots, finished packs with their LLM cost, and stage cost, for the window only", async () => {
    const inputs = await loadEconomicsInputs(asDb(), { since: new Date(NOW.getTime() - 30 * DAY), until: NOW });
    expect(inputs.shots.map((shot) => [shot.method, shot.costMicros, shot.attempts]).sort()).toEqual(
      [
        ["composite_generate", 60_000, 1],
        ["deterministic", 10_000, 1],
        ["edit_generate", 90_000, 2],
      ].sort(),
    );
    expect(inputs.undelivered.map((shot) => shot.costMicros).sort()).toEqual([30_000, 40_000]);
    expect(inputs.packs).toEqual([
      { jobId: doneJob, cogsMicros: 260_000, creditsCharged: 3.5, llmMicrosByFamily: { openai: 50_000, anthropic: 5_000 } },
    ]);
    expect(inputs.stages).toEqual([
      { stage: "lifestyle", status: "done", rows: 1, costMicros: 150_000 },
      { stage: "lifestyle", status: "needs_review", rows: 1, costMicros: 40_000 },
    ]);
    expect(inputs.packs.some((pack) => pack.jobId === failedJob)).toBe(false);
  });

  it("builds the report with the provider credit while it lasts, and changes nothing", async () => {
    const before = await client.query("select (select count(*) from generation_jobs) as jobs, (select count(*) from spend_cap_counters) as counters");
    const report = await unitEconomicsReport(asDb(), 30, NOW);
    expect(report.creditFamilies).toEqual(creditFamiliesOn(NOW));
    expect(report.perPack.atListPrice.mean).toBeCloseTo(0.26, 10);
    expect(report.perPack.withCredit.mean).toBeCloseTo(report.creditFamilies.includes("openai") ? 0.21 : 0.26, 10);
    expect(report.rule.currentCreditsPerStill).toBe(creditCosts.generativeStill);
    expect(report.floor.gross.key).toBe(priceFloor().gross.key);
    expect(report.retry).toMatchObject({ deliveredShots: 3 });
    const after = await client.query("select (select count(*) from generation_jobs) as jobs, (select count(*) from spend_cap_counters) as counters");
    expect(after.rows).toEqual(before.rows);
  });

  it("formats plain lines with the rule's answer and no dashes or arrows", async () => {
    const lines = formatUnitEconomicsReport(await unitEconomicsReport(asDb(), 30, NOW));
    const text = lines.join("\n");
    expect(text).toContain("Unit economics, packs created in the last 30 days. Read only.");
    expect(text).toContain("composite_generate: n 1");
    expect(text).toContain("Price rule for a generative still (decision 2):");
    expect(text).toMatch(/gives \d+(\.5)? credits? a still\./);
    expect(text).toContain("This report changes nothing.");
    expect(text).not.toMatch(/ [-–—] |→|->/);
  });

  it("says so when no generative still was delivered", async () => {
    const lines = formatUnitEconomicsReport(await unitEconomicsReport(asDb(), 1, NOW));
    expect(lines.join("\n")).toContain("No generative still was delivered in the window");
  });

  it("treats a provider credit as over after its last day", () => {
    expect(creditFamiliesOn(new Date("2026-12-31T23:00:00Z"), [{ family: "openai", expiresOn: "2026-12-31", reminderDates: [] }])).toEqual([
      "openai",
    ]);
    expect(creditFamiliesOn(new Date("2027-01-01T00:00:00Z"), [{ family: "openai", expiresOn: "2026-12-31", reminderDates: [] }])).toEqual([]);
  });
});
