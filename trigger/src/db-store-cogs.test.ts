/**
 * COGS persistence (plan 4.4.3 cogsMicros, plat-cogs-spend-alerts): the
 * runner's metered provider spend lands on generation_jobs.cogs_micros when
 * a pack ends, done or failed, and even when the job was already settled.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { creditLedger, generationJobs, products, workspaces } from "@curvi/db/schema";
import { endExiftool } from "@curvi/pipeline";
import { DbJobStore } from "./db-store";
import { runGeneratePack, systemClock, type GeneratePackInput, type ShotGenerator } from "./pipeline-runner";
import { buildRuntimeDeps, DemoShotGenerator } from "./runtime";
import type { PackUploader } from "./r2";

let client: PGlite;
let db: TestDb;
let ws: string;
let productId: string;

const PER_GENERATION_MICROS = 1_500;

class NullUploader implements PackUploader {
  readonly bucket = "test-bucket";
  async upload(): Promise<{ bytes: number }> {
    return { bytes: 1 };
  }
}

/** The demo generator with a metered provider cost on every generation. */
function meteredGenerator(): ShotGenerator {
  const inner = new DemoShotGenerator();
  return {
    generate: async (args) => ({ ...(await inner.generate(args)), costMicros: PER_GENERATION_MICROS }),
  };
}

async function newJob(reserve: number): Promise<string> {
  const [j] = await db.insert(generationJobs).values({ workspaceId: ws, productId, status: "queued" }).returning();
  if (reserve > 0) {
    await client.query("select reserve_credits($1, $2, $3)", [ws, reserve, j.id]);
  }
  return j.id;
}

async function cogsOf(id: string): Promise<number> {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
  return row.cogsMicros;
}

function store(uploader: PackUploader | null = new NullUploader()): DbJobStore {
  return new DbJobStore(db as unknown as Db, { reserveHandledExternally: true, uploader });
}

const input = (jobId: string): GeneratePackInput => ({
  jobId,
  workspaceId: ws,
  tier: "starter",
  channels: ["amazon"],
  creditBudget: 10,
  images: [{ mediaId: "m1" }],
  mode: "listing",
});

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "Cogs", plan: "starter" }).returning();
  ws = w.id;
  const [p] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
  productId = p.id;
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 500, reason: "grant", source: "system" });
});

afterAll(async () => {
  await endExiftool();
  await client.close();
});

describe("DbJobStore records job COGS", () => {
  it("writes the metered spend on the final state and never lowers it", async () => {
    const id = await newJob(0);
    expect(await store().setJobState(id, "analyzing")).toBe(true);
    expect(await cogsOf(id)).toBe(0);
    expect(await store().setJobState(id, "generating", { costMicros: 2_400.4 })).toBe(true);
    expect(await cogsOf(id)).toBe(2_400);
    await store().setJobState(id, "qc", { costMicros: 100 });
    expect(await cogsOf(id)).toBe(2_400);
    await store().setJobState(id, "done", { passed: 3, costMicros: 9_000 });
    expect(await cogsOf(id)).toBe(9_000);
  });

  it("ignores a missing or invalid cost", async () => {
    const id = await newJob(0);
    await store().setJobState(id, "generating", { costMicros: Number.NaN });
    await store().setJobState(id, "qc", { costMicros: -5 });
    await store().setJobState(id, "failed", { error: "x", costMicros: "12" });
    expect(await cogsOf(id)).toBe(0);
  });

  it("records spend on a job that was already settled, without reviving it", async () => {
    const id = await newJob(0);
    await db.update(generationJobs).set({ status: "failed" }).where(eq(generationJobs.id, id));
    expect(await store().setJobState(id, "failed", { error: "late", costMicros: 7_777 })).toBe(false);
    const [row] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
    expect(row.status).toBe("failed");
    expect(row.cogsMicros).toBe(7_777);
  });

  it("persists the runner's total when a pack finishes", async () => {
    const id = await newJob(10);
    const summary = await runGeneratePack(input(id), {
      ...buildRuntimeDeps(),
      generator: meteredGenerator(),
      store: store(),
      clock: systemClock,
    });
    expect(summary.state).toBe("done");
    expect(summary.costMicros).toBeGreaterThan(0);
    expect(await cogsOf(id)).toBe(Math.round(summary.costMicros));
  });

  it("persists the runner's total when a pack fails after spending", async () => {
    const id = await newJob(10);
    const summary = await runGeneratePack(input(id), {
      ...buildRuntimeDeps(),
      generator: meteredGenerator(),
      // No storage: the pack fails after every shot was generated and paid for.
      store: store(null),
      clock: systemClock,
    });
    expect(summary.state).toBe("failed");
    expect(summary.costMicros).toBeGreaterThan(0);
    expect(await cogsOf(id)).toBe(Math.round(summary.costMicros));
  });
});
