/**
 * DbService.createJob credit paths against the real migrations in PGlite:
 * only an underfunded workspace reads as "Not enough credits" (Update.md
 * 1.8), any other reserve or queue failure is a retryable 503 that returns
 * the hold, plan entitlements are enforced before anything is written, and
 * the hold equals the estimate, which leaves out undeliverable video.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  creditLedger,
  generationJobs,
  members,
  products,
  sourceMedia,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { DbService, isInsufficientCreditsError } from "./db";
import { estimatePackCredits } from "@/lib/pack-estimate";

type EnqueuedPayload = { tier: string; creditBudget: number };
const enqueue = vi.hoisted(() => ({
  fn: vi.fn<(payload: EnqueuedPayload) => Promise<"inline">>(async () => "inline"),
}));
vi.mock("@/lib/jobs/enqueue", () => ({ enqueueGeneratePack: enqueue.fn }));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f001";
const STILLS = ["amazon.main", "shopify.product", "meta.feed_1x1"];
let keyCounter = 0;

/** The SQL text of a drizzle sql`` object, enough to spot a function call. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<{ value?: unknown }> }).queryChunks ?? [];
  return chunks.map((c) => (Array.isArray(c.value) ? c.value.join("") : "")).join("?");
}

/** A Db whose execute runs `hook` for statements that mention `fn`. */
function dbWith(fn: string, hook: (run: () => Promise<unknown>) => Promise<unknown>): Db {
  const real = db as unknown as Db;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (query: unknown) => {
          const run = () => (target.execute as (q: unknown) => Promise<unknown>)(query);
          return sqlText(query).includes(fn) ? hook(run) : run();
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function service(database: Db = db as unknown as Db): DbService {
  return new DbService({ db: database, getUserId: async () => OWNER, getSupabase: async () => null });
}

async function workspaceWith(plan: string, credits: number): Promise<{ ws: string; productId: string }> {
  const [w] = await db.insert(workspaces).values({ name: `${plan} ws`, plan }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: OWNER, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
  await db.insert(sourceMedia).values({
    workspaceId: w.id,
    productId: p.id,
    r2Key: `ws/${w.id}/src/mug.jpg`,
    kind: "image",
    sha256: "a".repeat(64),
  });
  if (credits > 0) {
    await db.insert(creditLedger).values({ workspaceId: w.id, delta: credits, reason: "grant", source: "system" });
  }
  return { ws: w.id, productId: p.id };
}

async function balance(ws: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>("select credit_balance($1)", [ws]);
  return Number(result.rows[0].credit_balance);
}

function jobInput(productId: string, channels = STILLS) {
  keyCounter += 1;
  return { productId, channels, mode: "listing" as const, idempotencyKey: `create-job-test-${keyCounter}` };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  enqueue.fn.mockReset();
  enqueue.fn.mockResolvedValue("inline");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DbService.createJob reserve error mapping (Update.md 1.8)", () => {
  it("answers insufficient_credits only for an underfunded workspace", async () => {
    const { ws, productId } = await workspaceWith("starter", 2);
    const result = await service().createJob(ws, jobInput(productId));
    expect(result).toMatchObject({ outcome: "rejected", reason: "insufficient_credits" });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
    expect(job.status).toBe("failed");
    const rows = await db.select().from(creditLedger).where(eq(creditLedger.jobId, job.id));
    expect(rows).toHaveLength(0);
    expect(await balance(ws)).toBe(2);
    expect(enqueue.fn).not.toHaveBeenCalled();
  });

  it("answers unavailable, not insufficient credits, when the reserve fails for another reason", async () => {
    const { ws, productId } = await workspaceWith("starter", 100);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await client.exec(`
      alter function reserve_credits(uuid, numeric, uuid) rename to reserve_credits_real;
      create function reserve_credits(ws uuid, amount numeric, job uuid) returns numeric
      language plpgsql as $$ begin raise exception 'terminating connection due to administrator command' using errcode = '57P01'; end $$;
    `);
    try {
      const result = await service().createJob(ws, jobInput(productId));
      expect(result).toMatchObject({ outcome: "rejected", reason: "unavailable" });
      if (result.outcome === "rejected") {
        expect(result.message).toBe("We could not start this pack right now. Please try again in a minute.");
      }
    } finally {
      await client.exec(`
        drop function reserve_credits(uuid, numeric, uuid);
        alter function reserve_credits_real(uuid, numeric, uuid) rename to reserve_credits;
      `);
    }
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
    expect(job.status).toBe("failed");
    expect(await db.select().from(creditLedger).where(eq(creditLedger.jobId, job.id))).toHaveLength(0);
    expect(await balance(ws)).toBe(100);
    expect(errors).toHaveBeenCalled();
    expect(enqueue.fn).not.toHaveBeenCalled();
  });

  it("gives the hold back when the reserve committed but its answer was lost", async () => {
    const { ws, productId } = await workspaceWith("starter", 100);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lostReply = dbWith("reserve_credits", async (run) => {
      await run();
      throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
    });
    const result = await service(lostReply).createJob(ws, jobInput(productId));
    expect(result).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
    expect(job.status).toBe("failed");
    expect(await balance(ws)).toBe(100);
  });

  it("returns the hold and answers unavailable when the pack cannot be queued", async () => {
    const { ws, productId } = await workspaceWith("starter", 100);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue.fn.mockRejectedValueOnce(new Error("trigger.dev unreachable"));
    const result = await service().createJob(ws, jobInput(productId));
    expect(result).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
    expect(job.status).toBe("failed");
    expect(job.error).toBe("The pack could not be queued.");
    expect(await balance(ws)).toBe(100);
    // The real error is what gets logged, first.
    expect(String(errors.mock.calls[0]?.[1])).toContain("trigger.dev unreachable");
  });

  it("never lets a failing release hide the queue error, and leaves the job for the reconciler", async () => {
    const { ws, productId } = await workspaceWith("starter", 100);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue.fn.mockRejectedValueOnce(new Error("trigger.dev unreachable"));
    const releaseDown = dbWith("release_credits", async () => {
      throw new Error("release failed too");
    });
    const result = await service(releaseDown).createJob(ws, jobInput(productId));
    expect(result).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    const logged = errors.mock.calls.map((call) => String(call[1]));
    expect(logged[0]).toContain("trigger.dev unreachable");
    expect(logged.some((line) => line.includes("release failed too"))).toBe(true);
    // Still held, and still live, so the stale run reconciler fails it and
    // returns the hold instead of stranding it on a failed job.
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
    expect(job.status).toBe("queued");
    expect(await balance(ws)).toBe(100 - job.creditsReserved);
  });
});

describe("DbService.createJob holds and entitlements", () => {
  it("holds exactly the estimate, and a Pro workspace with 20 credits can start a stills pack", async () => {
    const { ws, productId } = await workspaceWith("pro", 20);
    const result = await service().createJob(ws, jobInput(productId));
    expect(result.outcome).toBe("created");
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
    const estimate = estimatePackCredits(STILLS, "listing", "pro").total;
    expect(job.creditsReserved).toBe(estimate);
    expect(await balance(ws)).toBe(20 - estimate);
    expect(enqueue.fn.mock.calls[0]?.[0]).toMatchObject({ tier: "pro", creditBudget: estimate });
  });

  it("refuses video channels before writing a product, a job or a hold", async () => {
    const { ws } = await workspaceWith("agency", 100);
    const productsBefore = await db.select().from(products).where(eq(products.workspaceId, ws));
    const result = await service().createJob(ws, {
      ...jobInput("new", ["amazon.main", "video.social_9x16"]),
      newProductTitle: "Should not exist",
    });
    expect(result).toMatchObject({ outcome: "rejected", reason: "feature_unavailable" });
    expect(await db.select().from(products).where(eq(products.workspaceId, ws))).toHaveLength(productsBefore.length);
    expect(await db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws))).toHaveLength(0);
    expect(await balance(ws)).toBe(100);
  });
});

describe("DbService balance reads", () => {
  it("logs a failed balance read instead of silently showing zero", async () => {
    await workspaceWith("starter", 10);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const balanceDown = dbWith("credit_balance", async () => {
      throw new Error("balance read failed");
    });
    const summary = await service(balanceDown).getCurrentWorkspace();
    expect(summary?.creditBalance).toBe(0);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[1])).toContain("balance read failed");
  });
});

describe("isInsufficientCreditsError", () => {
  it("matches the CU402 SQLSTATE, directly or inside a wrapper's cause", () => {
    expect(isInsufficientCreditsError({ code: "CU402", message: "x" })).toBe(true);
    expect(isInsufficientCreditsError(new Error("Failed query", { cause: { code: "CU402" } }))).toBe(true);
  });

  it("matches the pre 0012 plain exception only by its message", () => {
    expect(
      isInsufficientCreditsError({ code: "P0001", message: "insufficient credit balance for workspace x: have 1, need 5" }),
    ).toBe(true);
    expect(isInsufficientCreditsError({ code: "P0001", message: "workspace x not found" })).toBe(false);
  });

  it("never matches connection or unknown errors", () => {
    expect(isInsufficientCreditsError(new Error("insufficient credit balance"))).toBe(false);
    expect(isInsufficientCreditsError({ code: "57P01", message: "terminating connection" })).toBe(false);
    expect(isInsufficientCreditsError(null)).toBe(false);
  });
});
