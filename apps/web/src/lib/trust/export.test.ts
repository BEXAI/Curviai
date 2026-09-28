import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assetVariants,
  assets,
  brandKits,
  creditLedger,
  generationJobs,
  packFiles,
  products,
  sourceMedia,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { loadChannelSpecs, type Db } from "@curvi/db";
import { DemoService, getDemoStore } from "@/lib/services/demo";
import { buildDbExport, buildServicesExport, EXPORT_FORMAT, exportFilename } from "./export";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
});

afterAll(async () => {
  await client.close();
});

describe("buildDbExport", () => {
  it("lists products with photos, packs with files and the credit history, signing only this workspace's keys", async () => {
    const [w] = await db.insert(workspaces).values({ name: "Export", plan: "starter" }).returning();
    const [other] = await db.insert(workspaces).values({ name: "Other" }).returning();
    const [p] = await db
      .insert(products)
      .values({ workspaceId: w.id, title: "Mug", mode: "listing", amazonSku: "MUG1" })
      .returning();
    await db.insert(sourceMedia).values({
      workspaceId: w.id,
      productId: p.id,
      r2Key: `ws/${w.id}/src/photo`,
      sha256: "c".repeat(64),
      width: 800,
      height: 600,
    });
    const [done] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: p.id, status: "done", channels: ["amazon"], creditsCharged: 3 })
      .returning();
    const [failed] = await db
      .insert(generationJobs)
      .values({ workspaceId: w.id, productId: p.id, status: "failed" })
      .returning();
    const [asset] = await db.insert(assets).values({ workspaceId: w.id, jobId: done.id, shotType: "amazon_main" }).returning();
    await db.insert(assetVariants).values({
      workspaceId: w.id,
      assetId: asset.id,
      channelSpecId: "amazon.main",
      r2Key: `ws/${w.id}/jobs/${done.id}/files/amazon/MUG1.MAIN.jpg`,
      filename: "MUG1.MAIN.jpg",
      bytes: 1234,
    });
    await db.insert(packFiles).values({
      workspaceId: w.id,
      jobId: done.id,
      kind: "zip",
      channel: "amazon",
      filename: "amazon.zip",
      r2Key: `ws/${w.id}/jobs/${done.id}/pack/amazon.zip`,
    });
    // A failed pack's stray file is not served, so it is not exported.
    const [failedAsset] = await db
      .insert(assets)
      .values({ workspaceId: w.id, jobId: failed.id, shotType: "amazon_main" })
      .returning();
    await db.insert(assetVariants).values({
      workspaceId: w.id,
      assetId: failedAsset.id,
      channelSpecId: "amazon.main",
      r2Key: `ws/${w.id}/jobs/${failed.id}/files/amazon/X.jpg`,
      filename: "X.jpg",
    });
    await db.insert(brandKits).values({ workspaceId: w.id, name: "Kit", colors: ["#112233"], logoR2Key: `ws/${w.id}/src/logo` });
    await db.insert(creditLedger).values({ workspaceId: w.id, delta: 25, reason: "grant", source: "system" });
    // Rows of another workspace never appear.
    await db.insert(products).values({ workspaceId: other.id, title: "Secret", mode: "listing" });

    const signed: string[] = [];
    const sign = async (key: string) => {
      signed.push(key);
      return `https://signed.example/${key}`;
    };
    const now = new Date("2026-09-28T10:00:00Z");
    const out = await buildDbExport(
      db as unknown as Db,
      { id: w.id, name: "Export", plan: "starter", creditBalance: 22, role: "owner" },
      "seller@example.com",
      sign,
      now,
    );

    expect(out.format).toBe(EXPORT_FORMAT);
    expect(out.account.email).toBe("seller@example.com");
    expect(out.products.map((x) => x.title)).toEqual(["Mug"]);
    expect(out.products[0]).toMatchObject({ amazonSku: "MUG1" });
    expect(out.products[0].photos).toEqual([
      expect.objectContaining({ width: 800, height: 600, url: `https://signed.example/ws/${w.id}/src/photo` }),
    ]);
    const donePack = out.packs.find((x) => x.id === done.id);
    expect(donePack?.files.map((f) => f.name).sort()).toEqual(["MUG1.MAIN.jpg", "amazon.zip"]);
    expect(donePack?.files.every((f) => f.url?.startsWith("https://signed.example/") && f.appPath?.startsWith(`/api/jobs/${done.id}/files/`))).toBe(true);
    expect(out.packs.find((x) => x.id === failed.id)?.files).toEqual([]);
    expect(out.brandKit).toMatchObject({ name: "Kit", colors: ["#112233"], logoUrl: expect.stringContaining("/src/logo") });
    expect(out.credits).toEqual([expect.objectContaining({ delta: 25, reason: "grant" })]);
    expect(signed.every((k) => k.startsWith(`ws/${w.id}/`))).toBe(true);
    expect(exportFilename(now)).toBe("curvi-export-2026-09-28.json");
  });

  it("leaves links empty when storage is not configured", async () => {
    const [w] = await db.insert(workspaces).values({ name: "No R2" }).returning();
    const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Tray", mode: "listing" }).returning();
    await db.insert(sourceMedia).values({ workspaceId: w.id, productId: p.id, r2Key: `ws/${w.id}/src/a`, sha256: "d".repeat(64) });
    const out = await buildDbExport(
      db as unknown as Db,
      { id: w.id, name: "No R2", plan: "free", creditBalance: 0, role: "owner" },
      null,
      null,
    );
    expect(out.products[0].photos[0].url).toBeNull();
  });
});

describe("buildServicesExport (demo mode)", () => {
  it("builds the same document shape from the demo service", async () => {
    const services = new DemoService(getDemoStore());
    const workspace = await services.ensureWorkspace();
    expect(workspace).not.toBeNull();
    const out = await buildServicesExport(services, workspace!);
    expect(out.format).toBe(EXPORT_FORMAT);
    expect(out.workspace.id).toBe(workspace!.id);
    expect(Array.isArray(out.products)).toBe(true);
    expect(Array.isArray(out.packs)).toBe(true);
  });
});
