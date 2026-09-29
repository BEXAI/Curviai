/**
 * Remember choices per product (docs/phases/PHASE_15.md P1, founder decision
 * 7) against the real migrations in PGlite: a pack that carried options
 * saves the choice on products.output_defaults (never the resolved hex),
 * listProducts hands it to the form, a pack without options leaves it, and
 * createJob never reads it, so a request without options stays Marketplace
 * ready.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { brandKits, creditLedger, generationJobs, members, products, signupGrants, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { DbService } from "./db";
import { outputDefaultsFor, readOutputDefaults } from "./output-defaults";
import type { CreateJobInput } from "./types";

const queue = vi.hoisted(() => ({ pack: vi.fn(async () => "inline" as const) }));
vi.mock("@/lib/jobs/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/enqueue")>()),
  enqueueGeneratePack: queue.pack,
}));

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const OWNER = "00000000-0000-4000-8000-00000000f601";
const CHANNELS = ["amazon.secondary", "shopify.product"];
let keyCounter = 0;

function service(): DbService {
  return new DbService({
    db: db as unknown as Db,
    getUserId: async () => OWNER,
    getSupabase: async () => null,
    outputOptionsEnabled: async () => true,
    providerVerdict: async () => "ok",
  });
}

async function workspaceWith(kit?: string[]): Promise<{ ws: string; productId: string }> {
  const [w] = await db.insert(workspaces).values({ name: "Defaults ws", plan: "growth" }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: OWNER, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Mug", mode: "listing" }).returning();
  await db.insert(sourceMedia).values({
    workspaceId: w.id,
    productId: p.id,
    r2Key: `ws/${w.id}/src/front.jpg`,
    kind: "image",
    sha256: "a".repeat(64),
    angle: "front",
    width: 3000,
    height: 3000,
  });
  if (kit) {
    await db.insert(brandKits).values({ workspaceId: w.id, colors: kit });
  }
  await db.insert(creditLedger).values({ workspaceId: w.id, delta: 100, reason: "grant", source: "system" });
  return { ws: w.id, productId: p.id };
}

function jobInput(productId: string, extra: Partial<CreateJobInput> = {}): CreateJobInput {
  keyCounter += 1;
  return { productId, channels: CHANNELS, mode: "listing", idempotencyKey: `defaults-${keyCounter}`, ...extra };
}

async function productRow(productId: string) {
  const [row] = await db.select().from(products).where(eq(products.id, productId));
  return row;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  await db.insert(signupGrants).values({ userId: OWNER, credits: 0 });
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  queue.pack.mockClear();
});

describe("outputDefaultsFor", () => {
  it("saves nothing without options, for concept packs or for options the schema refuses", () => {
    expect(outputDefaultsFor({ mode: "listing" })).toBeUndefined();
    expect(outputDefaultsFor({ mode: "concept", outputOptions: { background: "keep" } })).toBeUndefined();
    expect(outputDefaultsFor({ mode: "listing", outputOptions: { background: "blur" } as never })).toBeUndefined();
  });

  it("saves the normalized choice with its look card, never a resolved hex", () => {
    const saved = outputDefaultsFor({ mode: "listing", outputOptions: { lookBase: "brand", color: { kind: "brand", index: 0 } } });
    expect(saved).toMatchObject({ v: 1, lookBase: "brand", background: "remove", color: { kind: "brand", index: 0 } });
    expect(JSON.stringify(saved)).not.toMatch(/colorHex|brandSweepHex|keepMediaIds/);
  });

  it("reads only a plain object back", () => {
    expect(readOutputDefaults(null)).toBeNull();
    expect(readOutputDefaults([1])).toBeNull();
    expect(readOutputDefaults("keep")).toBeNull();
    expect(readOutputDefaults({ background: "keep" })).toEqual({ background: "keep" });
  });
});

describe("DbService remembers choices per product", () => {
  it("saves a pack's choice on the product and lists it for the form", async () => {
    const { ws, productId } = await workspaceWith(["#1F2A44"]);
    const result = await service().createJob(
      ws,
      jobInput(productId, { outputOptions: { lookBase: "brand", color: { kind: "brand", index: 0 } } }),
    );
    expect(result.outcome).toBe("created");
    const row = await productRow(productId);
    expect(row.outputDefaults).toMatchObject({ lookBase: "brand", color: { kind: "brand", index: 0 } });
    expect(JSON.stringify(row.outputDefaults)).not.toContain("#1F2A44");
    const listed = (await service().listProducts(ws)).find((p) => p.id === productId);
    expect(listed?.outputDefaults).toEqual(row.outputDefaults);
  });

  it("keeps the remembered choice when a pack carries no options, and never applies it", async () => {
    const { ws, productId } = await workspaceWith();
    await service().createJob(ws, jobInput(productId, { outputOptions: { lookBase: "keep_photo", background: "keep" } }));
    const remembered = (await productRow(productId)).outputDefaults;
    expect(remembered).toMatchObject({ background: "keep" });

    const plain = await service().createJob(ws, jobInput(productId));
    expect(plain.outcome).toBe("created");
    expect((await productRow(productId)).outputDefaults).toEqual(remembered);
    // The request without options ran as Marketplace ready, not as the remembered Keep.
    const jobId = plain.outcome === "created" ? plain.job.id : "";
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    expect(job.outputOptions).toMatchObject({ background: "remove", keepMediaIds: [] });
  });

  it("remembers nothing when the pack is refused", async () => {
    const { ws, productId } = await workspaceWith();
    const refused = await service().createJob(ws, jobInput(productId, { outputOptions: { color: { kind: "brand", index: 3 } } }));
    expect(refused.outcome).toBe("rejected");
    expect((await productRow(productId)).outputDefaults).toBeNull();
  });
});
