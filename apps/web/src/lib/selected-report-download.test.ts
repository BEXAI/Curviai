import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { assets, assetVariants, generationJobs, packFiles, products, workspaces } from "@curvi/db/schema";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import type { PackFileReport, PackResult } from "@curvi/pipeline";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const writes = vi.hoisted(() => vi.fn());
const boundedReads = vi.hoisted(() => vi.fn());
const unboundedReads = vi.hoisted(() => vi.fn());
const signedIn = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/http/services", () => ({ resolveSignedIn: async () => signedIn.value }));
vi.mock("@/lib/funnel", () => ({ recordFunnel: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", async (original) => ({ ...(await original<typeof import("@/lib/env")>()), isR2Configured: () => true }));
vi.mock("@/lib/r2", async (original) => ({
  ...(await original<typeof import("@/lib/r2")>()),
  getObjectBytes: async (key: string) => { unboundedReads(key); return objects.get(key) ?? null; },
  getObjectBytesBounded: async (key: string, maxBytes: number, signal: AbortSignal) => {
    expect(maxBytes).toBe(8 * 1024 * 1024);
    expect(signal).toBeInstanceOf(AbortSignal);
    boundedReads(key);
    return objects.get(key) ?? null;
  },
  presignDownload: async (key: string) => `https://stored.example/${key}`,
  presignObjectGet: async (key: string) => `https://stored.example/${key}`,
  r2Client: () => ({ send: async (command: HeadObjectCommand | PutObjectCommand, options: { abortSignal?: AbortSignal }) => {
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    const key = command.input.Key!;
    if (command instanceof HeadObjectCommand) {
      if (!objects.has(key)) throw { $metadata: { httpStatusCode: 404 } };
      return {};
    }
    expect(command.input.IfNoneMatch).toBe("*");
    expect(command.input.CacheControl).toBe("private, no-store");
    writes(key);
    if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
    objects.set(key, Buffer.from(command.input.Body as Buffer));
    return {};
  } }),
}));

import { readSelectedReport, prepareReportSnapshot, existingReportKey } from "./selected-report-download";
import { DbService } from "./services/db";
import { listPackFiles } from "./api-v1/actions";
import type { ApiContext } from "./api-v1/actions";
import { SHORT_LIVED_PACK_LINKS } from "./api-v1/mcp-tools";
import { handleMcpPost, PROTOCOL_VERSION_META } from "./api-v1/mcp";
import { buildDbExport } from "./trust/export";
import { GET as browserDownload } from "@/app/api/jobs/[id]/files/[fileId]/route";
import { GET as mcpDownload } from "@/app/api/mcp/files/[token]/route";
import { dbMcpLinkBackend, setMcpLinkBackendForTests } from "./mcp-links-backend";
import { clearMcpLinkCacheForTests, signLinkToken } from "./mcp-links";
import { parseSigningKeys } from "./mcp-signing";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "./rate-limit";

let db: TestDb;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
const asDb = () => db as unknown as Db;
const RING = `fixture:${"report-download-only".repeat(3)}`;
beforeAll(async () => {
  ({ db, client } = await createTestDb());
  await loadChannelSpecs(asDb());
});
beforeEach(() => {
  objects.clear(); writes.mockClear(); boundedReads.mockClear(); unboundedReads.mockClear();
  vi.stubEnv("MCP_LINK_KEYS", RING);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  clearMcpLinkCacheForTests();
});
afterEach(() => { vi.unstubAllEnvs(); setMcpLinkBackendForTests(null); setRateLimitStoreForTests(null); });
afterAll(async () => { await client.close(); });

async function fixture() {
  const [workspace] = await db.insert(workspaces).values({ name: "Selected reports" }).returning();
  const ws = workspace.id;
  const [product] = await db.insert(products).values({ workspaceId: ws, title: "Mug", mode: "listing" }).returning();
  const [job] = await db.insert(generationJobs).values({ workspaceId: ws, productId: product.id, status: "done" }).returning();
  const originalKey = `ws/${ws}/jobs/${job.id}/pack/compliance-report.json`;
  const oldFile: PackFileReport = { file: "old.jpg", channel: "amazon", specId: "amazon.main", ref: "original-shot",
    digitalSource: "none", badge: false, notes: [], measured: null,
    checks: [{ name: "fillRatio", pass: true, measured: 0.88, limit: ">= 0.85" }], pass: true };
  const newFile: PackFileReport = { ...oldFile, file: "picked.jpg", ref: "selected-version",
    checks: [{ name: "fillRatio", pass: true, measured: 0.91, limit: ">= 0.85" }],
    fidelity: { meanDeltaE: 0.8, maxDeltaE: 2.3, exactByteShare: 0.9, maskArea: 1000,
      threshold: 3, maxDeltaELimit: 10, kind: "main", exact: false } };
  const newKey = `ws/${ws}/jobs/${job.id}/versions/second/picked.jpg`;
  const [asset] = await db.insert(assets).values({ workspaceId: ws, jobId: job.id, shotType: "amazon_main",
    qc: { fileReports: { [newKey]: newFile } } }).returning();
  const variants = await db.insert(assetVariants).values([
    { workspaceId: ws, assetId: asset.id, channelSpecId: "amazon.main", filename: oldFile.file,
      r2Key: `ws/${ws}/jobs/${job.id}/files/amazon/${oldFile.file}`, picked: false },
    { workspaceId: ws, assetId: asset.id, channelSpecId: "amazon.main", filename: newFile.file, r2Key: newKey, picked: true },
  ]).returning();
  const [pack] = await db.insert(packFiles).values({ workspaceId: ws, jobId: job.id, kind: "report",
    filename: "compliance-report.json", r2Key: originalKey, bytes: 1 }).returning();
  const original: PackResult["report"] = { version: 2, generatedAt: "2026-10-01T00:00:00Z", channels: ["amazon"], files: [oldFile],
    dropped: [{ file: "left-out.jpg", channel: "amazon", specId: "amazon.main", ref: "dropped-shot", reason: "file limit" }],
    intent: { featured: ["Mug"], removed: ["Spoon"] },
    inventory: [{ photo: 1, picked: "Picked by looking at the photo: the mug is centered", items: [
      { label: "Mug", color: "blue", shape: "round", status: "featured" },
      { label: "Spoon", color: "silver", shape: "long", status: "removed" },
    ] }],
  };
  objects.set(originalKey, Buffer.from(JSON.stringify(original)));
  const expected = { ...original, files: [newFile] };
  const service = new DbService({ db: asDb(), getUserId: async () => null, getSupabase: async () => null });
  const summary = { id: ws, name: workspace.name, role: "owner" as const, plan: "free" as const, creditBalance: 0 };
  const userId = randomUUID();
  const ctx: ApiContext = { caller: {
    kind: "api_key", keyId: randomUUID(), prefix: "fixture", connectionId: null, ipExempt: false, scopes: ["packs:read"],
    principal: { workspaceId: ws, workspaceName: workspace.name, role: "owner", plan: "free", userId },
    services: service, rateSubject: userId,
  }, headers: new Headers() };
  return { ws, job, pack, variants, originalKey, original, expected, service, summary, ctx };
}

describe("selected report delivery", () => {
  it("serves the same current picked JSON through browser and sealed MCP without writing storage", async () => {
    const f = await fixture();
    signedIn.value = { workspace: f.summary, services: f.service };
    const browser = await browserDownload(new Request("https://curvi.ai"), { params: Promise.resolve({ id: f.job.id, fileId: `p_${f.pack.id}` }) });
    expect(browser.status).toBe(200);
    expect(browser.headers.get("cache-control")).toBe("no-store");
    expect(browser.headers.get("content-disposition")).toContain("compliance-report.json");
    expect(await browser.json()).toEqual(f.expected);
    const backend = dbMcpLinkBackend(asDb());
    setMcpLinkBackendForTests({ subjectLive: async () => true, fileOf: backend.fileOf.bind(backend) });
    const token = signLinkToken({ subject: { kind: "key", id: randomUUID() }, workspaceId: f.ws, jobId: f.job.id,
      fileId: `p_${f.pack.id}`, kind: "file", exp: Math.floor(Date.now() / 1000) + 60 }, parseSigningKeys(RING)!);
    const mcp = await mcpDownload(new Request(`https://curvi.ai/api/mcp/files/${token}`), { params: Promise.resolve({ token }) });
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toEqual(f.expected);
    expect(writes).not.toHaveBeenCalled();
    const view = await f.service.getComplianceReport(f.ws, f.job.id);
    expect(view?.channels.flatMap((channel) => channel.files.map((file) => file.file))).toEqual(["picked.jpg"]);
  });

  it("omits a stale fallback MCP URL without any PUT, then reuses the explicit REST snapshot", async () => {
    const f = await fixture();
    const files = (await f.service.listJobFiles(f.ws, f.job.id))!.files;
    expect(boundedReads).toHaveBeenCalledWith(f.originalKey);
    expect(unboundedReads).not.toHaveBeenCalledWith(f.originalKey);
    const before = await SHORT_LIVED_PACK_LINKS.links(f.ctx, f.job.id, files);
    expect(before.get(`p_${f.pack.id}`)?.download_url).toBeNull();
    expect(writes).not.toHaveBeenCalled();
    const result = await listPackFiles(f.ctx, f.job.id);
    const report = (result.body as { files: { kind: string; url: string; bytes: number }[] }).files.find((file) => file.kind === "report")!;
    const key = report.url.replace("https://stored.example/", "");
    expect(JSON.parse(objects.get(key)!.toString())).toEqual(f.expected);
    expect(report.bytes).toBe(objects.get(key)!.length);
    expect(writes).toHaveBeenCalledTimes(1);
    const after = await SHORT_LIVED_PACK_LINKS.links(f.ctx, f.job.id, files);
    expect(after.get(`p_${f.pack.id}`)?.download_url).toBe(report.url);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(objects.get(f.originalKey)!.toString())).toEqual(f.original);
    expect((await db.select().from(packFiles).where(eq(packFiles.id, f.pack.id)))[0].r2Key).toBe(f.originalKey);
  });

  it("keeps the configured-storage get_pack tool read-only when no matching snapshot exists", async () => {
    const f = await fixture();
    vi.stubEnv("MCP_LINK_KEYS", "");
    const version = "2026-07-28";
    const request = new Request("https://curvi.ai/api/mcp", { method: "POST", headers: {
      "content-type": "application/json", "mcp-protocol-version": version, "mcp-method": "tools/call", "mcp-name": "get_pack",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "get_pack", arguments: { pack_id: f.job.id, include_files: true }, _meta: { [PROTOCOL_VERSION_META]: version },
    } }) });
    const response = await handleMcpPost(request, { oauthEnabled: false, authenticate: async () => ({ ok: true, caller: f.ctx.caller }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result?.isError, JSON.stringify(body)).toBe(false);
    expect(boundedReads).toHaveBeenCalledWith(f.originalKey);
    expect(unboundedReads).not.toHaveBeenCalledWith(f.originalKey);
    expect(writes).not.toHaveBeenCalled();
    expect(objects.size).toBe(1);
  });

  it("exports a matching immutable snapshot and keeps older links stable after picks change", async () => {
    const f = await fixture();
    const first = await prepareReportSnapshot(asDb(), f.ws, f.job.id, f.pack.id);
    const out = await buildDbExport(asDb(), f.summary, null, async (key) => `https://stored.example/${key}`);
    const exported = out.packs.find((pack) => pack.id === f.job.id)!.files.find((file) => file.kind === "report")!;
    expect(exported.url).toBe(`https://stored.example/${first!.key}`);
    expect(JSON.parse(objects.get(first!.key)!.toString())).toEqual(f.expected);
    expect(writes).toHaveBeenCalledTimes(1);
    await db.update(assetVariants).set({ picked: false }).where(eq(assetVariants.id, f.variants[1].id));
    await db.update(assetVariants).set({ picked: true }).where(eq(assetVariants.id, f.variants[0].id));
    const selected = await readSelectedReport(asDb(), f.ws, f.job.id, f.pack.id);
    expect(await existingReportKey(selected!)).toBe(f.originalKey);
    expect(writes).toHaveBeenCalledTimes(1);
    const changed = await prepareReportSnapshot(asDb(), f.ws, f.job.id, f.pack.id);
    expect(changed!.key).not.toBe(first!.key);
    expect(JSON.parse(objects.get(first!.key)!.toString())).toEqual(f.expected);
    expect(JSON.parse(objects.get(changed!.key)!.toString())).toEqual(f.original);
  });

  it("refuses foreign or deleted jobs and reports before creating objects", async () => {
    const f = await fixture();
    const other = await fixture();
    expect(await prepareReportSnapshot(asDb(), other.ws, f.job.id, f.pack.id)).toBeNull();
    expect(await prepareReportSnapshot(asDb(), f.ws, f.job.id, other.pack.id)).toBeNull();
    await db.delete(workspaces).where(eq(workspaces.id, f.ws));
    expect(await prepareReportSnapshot(asDb(), f.ws, f.job.id, f.pack.id)).toBeNull();
    expect(writes).not.toHaveBeenCalled();
  });

  it("does not hand out the stale original when a snapshot PUT fails", async () => {
    const f = await fixture();
    const fail = vi.fn(async () => { throw new Error("storage timeout"); });
    await expect(prepareReportSnapshot(asDb(), f.ws, f.job.id, f.pack.id, {
      read: async (key) => objects.get(key) ?? null, exists: async () => false, putIfAbsent: fail,
    })).rejects.toThrow("storage timeout");
    expect(fail).toHaveBeenCalledOnce();
    expect(objects.size).toBe(1);
  });

  it("matches the file-serving rule for failed jobs with and without delivered charges", async () => {
    const f = await fixture();
    await db.update(generationJobs).set({ status: "failed", creditsCharged: 0 }).where(eq(generationJobs.id, f.job.id));
    expect(await readSelectedReport(asDb(), f.ws, f.job.id, f.pack.id)).toBeNull();
    await db.update(generationJobs).set({ creditsCharged: 1 }).where(eq(generationJobs.id, f.job.id));
    expect((await readSelectedReport(asDb(), f.ws, f.job.id, f.pack.id))?.report).toEqual(f.expected);
  });
});
