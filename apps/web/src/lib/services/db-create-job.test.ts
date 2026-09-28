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
  signupGrants,
  sourceMedia,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { DbService, RESTARTING_MESSAGE, isInsufficientCreditsError } from "./db";
import { InlineRunnerClosedError } from "@/lib/jobs/inline-runner";
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

/** A Db whose execute runs `hook` for statements that mention `fn`, on the
 * database itself and inside any transaction it opens. */
function dbWith(fn: string, hook: (run: () => Promise<unknown>) => Promise<unknown>): Db {
  const wrap = <T extends object>(inner: T): T =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return (query: unknown) => {
            const run = () => ((target as { execute: (q: unknown) => Promise<unknown> }).execute)(query);
            return sqlText(query).includes(fn) ? hook(run) : run();
          };
        }
        if (prop === "transaction") {
          return (callback: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
            (target as { transaction: (cb: (tx: object) => Promise<unknown>, ...r: unknown[]) => Promise<unknown> })
              .transaction((tx) => callback(wrap(tx)), ...rest);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  return wrap(db as unknown as Db);
}

/** Jobs a workspace has, to prove a rejected pack left nothing behind. */
async function jobsOf(ws: string) {
  return db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws));
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
  // The owner's signup grant is settled, as 0012 records for existing
  // members, so workspace reads never add the free grant to a fixture.
  await db.insert(signupGrants).values({ userId: OWNER, credits: 0 });
});

/** Records, in order, the statements a createJob transaction runs. */
function recordingDb(log: string[]): Db {
  const tableNames = new Map<unknown, string>([
    [products, "products"],
    [sourceMedia, "source_media"],
    [generationJobs, "generation_jobs"],
  ]);
  const wrapTx = <T extends object>(tx: T): T =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return (query: unknown) => {
            log.push(`execute ${sqlText(query)}`);
            return (target as { execute: (q: unknown) => Promise<unknown> }).execute(query);
          };
        }
        if (prop === "insert") {
          return (table: unknown) => {
            log.push(`insert ${tableNames.get(table) ?? "other"}`);
            return (target as { insert: (t: unknown) => unknown }).insert(table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  return new Proxy(db as unknown as Db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return (callback: (tx: object) => Promise<unknown>, ...rest: unknown[]) =>
          (target as unknown as { transaction: (cb: (tx: object) => Promise<unknown>, ...r: unknown[]) => Promise<unknown> })
            .transaction((tx) => callback(wrapTx(tx)), ...rest);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

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
    // Product, uploads, job and hold commit together (Update.md 6.3), so a
    // refused reservation leaves no job and no ledger row behind.
    expect(await jobsOf(ws)).toHaveLength(0);
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
    expect(await jobsOf(ws)).toHaveLength(0);
    expect(await balance(ws)).toBe(100);
    expect(errors).toHaveBeenCalled();
    expect(enqueue.fn).not.toHaveBeenCalled();
  });

  it("keeps no hold when the reserve ran but its answer was lost", async () => {
    const { ws, productId } = await workspaceWith("starter", 100);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lostReply = dbWith("reserve_credits", async (run) => {
      await run();
      throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
    });
    const result = await service(lostReply).createJob(ws, jobInput(productId));
    expect(result).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    // The reserve ran inside the job's transaction, which rolled back.
    expect(await jobsOf(ws)).toHaveLength(0);
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

describe("DbService.createJob per workspace lock (deadlock fix)", () => {
  // PGlite runs one connection and serializes transactions, so two
  // concurrent createJob calls cannot deadlock here even without the lock.
  // What this checks is the order that prevents it on Postgres: the
  // workspace row is locked FOR UPDATE before any insert takes FOR KEY SHARE
  // on it through a foreign key, and before reserve_credits asks for FOR
  // UPDATE on the same row.
  it("locks the workspace row first, before the inserts and the reservation", async () => {
    const { ws } = await workspaceWith("starter", 100);
    const log: string[] = [];
    const result = await service(recordingDb(log)).createJob(ws, {
      ...jobInput("new"),
      newProductTitle: "Lamp",
      uploads: [{ key: `ws/${ws}/src/lamp.jpg`, sha256: "c".repeat(64), kind: "image" as const }],
    });
    expect(result.outcome).toBe("created");
    expect(log[0]).toMatch(/^execute select 1 from workspaces where id = \?+::uuid for update$/);
    expect(log.slice(1, 4)).toEqual(["insert products", "insert source_media", "insert generation_jobs"]);
    expect(log[4]).toContain("reserve_credits");
  });
});

describe("DbService.createJob on a draining server", () => {
  it("answers unavailable with plain restart copy and returns the hold", async () => {
    const { ws, productId } = await workspaceWith("starter", 100);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    enqueue.fn.mockRejectedValueOnce(new InlineRunnerClosedError());
    const result = await service().createJob(ws, jobInput(productId));
    expect(result).toEqual({ outcome: "rejected", reason: "unavailable", message: RESTARTING_MESSAGE });
    expect(RESTARTING_MESSAGE).not.toMatch(/[–—→]| - |->/);
    const [job] = await jobsOf(ws);
    expect(job.status).toBe("failed");
    expect(await balance(ws)).toBe(100);
    // Expected during a deploy: a warning, not an error.
    expect(warnings).toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
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
