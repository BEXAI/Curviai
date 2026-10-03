import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import {
  assets, assetVariants, creditLedger, generationJobs, members, packCompletionEvents,
  packFiles, products, sourceMedia, webhookDeliveries, webhookEndpoints, workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { authenticateApiKey, type ApiAuthResult, type ApiCaller } from "@/lib/api-keys/auth";
import { API_SCOPES } from "@/lib/api-keys/format";
import { EstimateChat, PackChat } from "@/lib/api-v1/chat-views";
import { PROTOCOL_VERSION_META, handleMcpPost } from "@/lib/api-v1/mcp";
import { demoApiFixture } from "@/lib/api-v1/test-fixtures";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { DbService } from "@/lib/services/db";
import { DEMO_WORKSPACE_ID } from "@/lib/services/demo";
import { sweepStaleJobs } from "@/lib/services/reconcile";

// These fixtures never use live storage, even in a configured developer shell.
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  isR2Configured: () => false,
}));

// Real migrations, ledger functions and completion-event triggers. A stale
// delivered pack owes a charge; an undelivered one owes a release. Neither
// obligation may be settled by a tool advertised as read-only.
let db: TestDb;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
const OWNER = "00000000-0000-4000-8000-00000000f901";
const VERSION = "2026-07-28";
let nextId = 1;

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  client = created.client;
  await loadChannelSpecs(db as unknown as Db);
});

beforeEach(() => {
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  vi.stubEnv("MCP_LINK_KEYS", `readonly-test:${"local-test-fixture-only".repeat(3)}`);
  vi.stubEnv("MCP_OAUTH_ENABLED", "0");
});

afterEach(() => {
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await client.close();
});

async function fixture() {
  const [workspace] = await db.insert(workspaces).values({ name: "Readonly MCP", plan: "pro" }).returning();
  const ws = workspace.id;
  await db.insert(members).values({ workspaceId: ws, userId: OWNER, role: "owner" });
  await db.insert(creditLedger).values({ workspaceId: ws, delta: 100, reason: "grant", source: "system" });
  const [product] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
  await db.insert(sourceMedia).values({
    workspaceId: ws, productId: product.id, r2Key: `ws/${ws}/src/front.jpg`,
    kind: "image", sha256: "a".repeat(64), angle: "front", width: 3000, height: 3000,
  });
  // No network delivery runs here. An enabled fixture proves that settlement
  // would enqueue an outbox row as well as a completion event.
  await db.insert(webhookEndpoints).values({
    workspaceId: ws, createdBy: OWNER, name: "Test endpoint", url: "https://example.com/pack",
    enabled: true, verifiedAt: new Date(), keyId: "test", encryptedSecret: "fixture-only",
  });
  async function job(delivered: boolean) {
    const [row] = await db.insert(generationJobs).values({ workspaceId: ws, productId: product.id }).returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 10, row.id]);
    if (delivered) {
      const [asset] = await db.insert(assets).values({
        workspaceId: ws, jobId: row.id, shotType: "alt_angle_white", approved: true,
        qc: { shotId: "shot-1", credits: 4, status: "passed" },
      }).returning();
      await db.insert(assetVariants).values({
        workspaceId: ws, assetId: asset.id, channelSpecId: "amazon.main",
        r2Key: `ws/${ws}/jobs/${row.id}/main.jpg`, filename: "main.jpg",
      });
      await db.insert(packFiles).values({
        workspaceId: ws, jobId: row.id, kind: "report", filename: "compliance-report.json",
        r2Key: `ws/${ws}/jobs/${row.id}/compliance-report.json`,
      });
    }
    await db.update(generationJobs).set({
      status: "generating", updatedAt: new Date(Date.now() - 31 * 60 * 1000),
    }).where(eq(generationJobs.id, row.id));
    return row.id;
  }
  const delivered = await job(true);
  const undelivered = await job(false);
  const service = new DbService({
    db: db as unknown as Db, getUserId: async () => OWNER, getSupabase: async () => null,
    outputOptionsEnabled: async () => true, cutoutCached: async () => false,
  });
  const caller: ApiCaller = {
    kind: "api_key", keyId: "00000000-0000-4000-8000-00000000f902", prefix: "fixture",
    connectionId: null, ipExempt: false, scopes: [...API_SCOPES],
    principal: { workspaceId: ws, workspaceName: workspace.name, plan: "pro", role: "owner", userId: OWNER },
    services: service, rateSubject: OWNER,
  };
  return { ws, productId: product.id, delivered, undelivered, service, caller };
}

async function snapshot(ws: string) {
  const [jobs, ledger, events, deliveries, productRows, media, files, assetRows, variants] = await Promise.all([
    db.select().from(generationJobs).where(eq(generationJobs.workspaceId, ws)).orderBy(generationJobs.id),
    db.select().from(creditLedger).where(eq(creditLedger.workspaceId, ws)).orderBy(creditLedger.id),
    db.select().from(packCompletionEvents).where(eq(packCompletionEvents.workspaceId, ws)).orderBy(packCompletionEvents.id),
    db.select().from(webhookDeliveries).where(eq(webhookDeliveries.workspaceId, ws)).orderBy(webhookDeliveries.id),
    db.select().from(products).where(eq(products.workspaceId, ws)).orderBy(products.id),
    db.select().from(sourceMedia).where(eq(sourceMedia.workspaceId, ws)).orderBy(sourceMedia.id),
    db.select().from(packFiles).where(eq(packFiles.workspaceId, ws)).orderBy(packFiles.id),
    db.select().from(assets).where(eq(assets.workspaceId, ws)).orderBy(assets.id),
    db.select().from(assetVariants).where(eq(assetVariants.workspaceId, ws)).orderBy(assetVariants.id),
  ]);
  return { jobs, ledger, events, deliveries, productRows, media, files, assetRows, variants };
}

async function call(caller: ApiCaller, name: string, args: Record<string, unknown>) {
  const request = new Request("https://curvi.ai/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json", "mcp-protocol-version": VERSION,
      "mcp-method": "tools/call", "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: nextId++, method: "tools/call",
      params: { name, arguments: args, _meta: { [PROTOCOL_VERSION_META]: VERSION } },
    }),
  });
  const response = await handleMcpPost(request, {
    oauthEnabled: false,
    authenticate: async (): Promise<ApiAuthResult> => ({ ok: true, caller }),
  });
  const body = await response.json() as { result?: { isError: boolean; structuredContent?: unknown }; error?: unknown };
  expect(response.status).toBe(200);
  expect(body.result?.isError, JSON.stringify(body)).toBe(false);
  return body.result!.structuredContent;
}

describe("MCP read-only business state", () => {
  it.each(["get_pack", "show_pack", "estimate_pack"])("%s leaves stale jobs, charges, releases and completion outbox unchanged", async (name) => {
    const f = await fixture();
    const before = await snapshot(f.ws);
    expect(before.events).toHaveLength(0);
    expect(before.deliveries).toHaveLength(0);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      if (name === "estimate_pack") {
        const result = EstimateChat.parse(await call(f.caller, name, { productId: f.productId, channels: ["amazon.main"] }));
        expect(result.credits_available).toBe(80);
      } else {
        for (const id of [f.delivered, f.undelivered]) {
          const result = PackChat.parse(await call(f.caller, name, { pack_id: id, ...(name === "get_pack" ? { include_files: true } : {}) }));
          expect(result.pack_id).toBe(id);
          expect(result.finished).toBe(false);
          expect(result.credits.charged).toBe(0);
        }
      }
      expect(await snapshot(f.ws)).toEqual(before);
    }
  });

  it.each(["getJob", "estimateJob", "scheduled sweep"])("preserves default %s recovery, including delivered charges and outbox writes", async (recovery) => {
    const f = await fixture();
    async function recover() {
      if (recovery === "getJob") {
        await f.service.getJob(f.ws, f.delivered);
        await f.service.getJob(f.ws, f.undelivered);
      } else if (recovery === "estimateJob") {
        await f.service.estimateJob(f.ws, { productId: f.productId, channels: ["amazon.main"], mode: "listing" });
      } else {
        await sweepStaleJobs(db as unknown as Db);
      }
    }
    await recover();
    const after = await snapshot(f.ws);
    expect(after.jobs.find((job) => job.id === f.delivered)?.status).toBe("done");
    expect(after.jobs.find((job) => job.id === f.undelivered)?.status).toBe("failed");
    expect(after.ledger.filter((entry) => entry.reason === "charge")).toMatchObject([{ jobId: f.delivered, delta: -4 }]);
    // Charging converts 4 held credits to a charge before releasing the
    // remaining 6. The undelivered job releases its entire 10-credit hold.
    expect(after.ledger.filter((entry) => entry.reason === "release").map((entry) => entry.delta).sort((a, b) => a - b)).toEqual([4, 6, 10]);
    expect(after.ledger.reduce((sum, entry) => sum + entry.delta, 0)).toBe(96);
    expect(after.events).toHaveLength(2);
    expect(after.deliveries).toHaveLength(2);
    await recover();
    expect(await snapshot(f.ws)).toEqual(after);
  });

  it("does not advance demo generation through repeated get/show reads", async () => {
    const demo = demoApiFixture();
    const created = await demo.service.createJob(DEMO_WORKSPACE_ID, {
      productId: "new", channels: ["amazon.main"], mode: "listing", idempotencyKey: "readonly-demo",
    });
    if (created.outcome !== "created") throw new Error("demo pack should be created");
    const auth = await authenticateApiKey(new Headers({ authorization: `Bearer ${demo.key}` }), null, { backend: demo.backend });
    if (!auth.ok) throw new Error("demo caller should authenticate");
    const before = await demo.service.getJob(DEMO_WORKSPACE_ID, created.job.id, { reconcile: false });
    const credits = await demo.service.workspaceBalance(DEMO_WORKSPACE_ID);
    for (let i = 0; i < 20; i += 1) {
      await call(auth.caller, i % 2 ? "show_pack" : "get_pack", { pack_id: created.job.id });
      expect(await demo.service.getJob(DEMO_WORKSPACE_ID, created.job.id, { reconcile: false })).toEqual(before);
    }
    expect(await demo.service.workspaceBalance(DEMO_WORKSPACE_ID)).toBe(credits);
    // The default fixture tick still simulates a worker finishing the pack.
    for (let i = 0; i < 20; i += 1) await demo.service.getJob(DEMO_WORKSPACE_ID, created.job.id);
    expect((await demo.service.getJob(DEMO_WORKSPACE_ID, created.job.id, { reconcile: false }))?.status).toBe("done");
  });
});
