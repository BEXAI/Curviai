import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assetVariants, assets, galleryItems, generationJobs, products, shareLinks, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { DbShareStore } from "@/lib/shares/db-store";
import { gallerySitemapRows } from "@/lib/shares/sitemap";
import { listGalleryQueue, reviewGalleryItem } from "./gallery";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let id: string;
let slug: string;
let store: DbShareStore;
const operator = { email: "founder@curvi.ai", email_confirmed_at: "2026-01-01" };
const asDb = () => db as unknown as Db;

beforeAll(async () => {
  vi.stubEnv("OPS_EMAILS", operator.email);
  ({ client, db } = await createTestDb());
  await loadChannelSpecs(asDb());
  const [ws] = await db.insert(workspaces).values({ name: "Gallery review" }).returning();
  const [p] = await db.insert(products).values({ workspaceId: ws.id, title: "Mug", mode: "listing" }).returning();
  const [job] = await db.insert(generationJobs).values({ workspaceId: ws.id, productId: p.id, status: "done" }).returning();
  const [asset] = await db.insert(assets).values({ workspaceId: ws.id, jobId: job.id, shotType: "amazon_main" }).returning();
  await db.insert(assetVariants).values({ workspaceId: ws.id, assetId: asset.id, channelSpecId: "amazon.main", r2Key: `ws/${ws.id}/out/${job.id}/main.jpg`, filename: "MAIN.jpg" });
  store = new DbShareStore(asDb());
  const result = await store.publish({ id: ws.id, role: "owner" }, job.id, { kind: "pack", gallery: true });
  if (!result.ok) throw new Error("fixture failed");
  slug = result.status.slug!;
  [id] = (await db.select().from(galleryItems)).map((item) => item.id);
});
afterAll(async () => { vi.unstubAllEnvs(); await client.close(); });

describe("gallery review", () => {
  it("keeps pending submissions out of the gallery, sitemap and indexing", async () => {
    expect(await listGalleryQueue(asDb())).toHaveLength(1);
    expect(await store.listGallery(20)).toEqual([]);
    expect(await gallerySitemapRows("https://curvi.ai", (limit) => store.listGallery(limit))).toEqual([]);
    expect((await store.getPublic(slug))?.inGallery).toBe(false);
  });

  it("refuses unverified operators without changing or auditing anything", async () => {
    await expect(reviewGalleryItem(asDb(), { itemId: id, decision: "approved", operator, aal: "aal1" })).rejects.toThrow(/verification/);
    await expect(reviewGalleryItem(asDb(), { itemId: id, decision: "approved", operator: { ...operator, email: "other@example.com" }, aal: "aal2" })).rejects.toThrow(/verification/);
    expect((await client.query("select id from ops_audit")).rows).toHaveLength(0);
  });

  it("approves with an audit and invalidates both caches immediately", async () => {
    await reviewGalleryItem(asDb(), { itemId: id, decision: "approved", operator, aal: "aal2" });
    expect(await listGalleryQueue(asDb())).toEqual([]);
    expect((await store.listGallery(20)).map((row) => row.slug)).toEqual([slug]);
    expect(await gallerySitemapRows("https://curvi.ai", (limit) => store.listGallery(limit))).toHaveLength(1);
    expect((await store.getPublic(slug))?.inGallery).toBe(true);
    expect((await client.query<{ action: string }>("select action from ops_audit")).rows).toEqual([{ action: "gallery.approve" }]);
  });

  it("rejects an approved item with an audit and removes it from public surfaces", async () => {
    await reviewGalleryItem(asDb(), { itemId: id, decision: "rejected", operator, aal: "aal2" });
    expect(await store.listGallery(20)).toEqual([]);
    expect(await gallerySitemapRows("https://curvi.ai", (limit) => store.listGallery(limit))).toEqual([]);
    expect((await store.getPublic(slug))?.inGallery).toBe(false);
    expect((await client.query("select id from ops_audit")).rows).toHaveLength(2);
    await db.update(shareLinks).set({ isPublic: false }).where(eq(shareLinks.slug, slug));
    await expect(reviewGalleryItem(asDb(), { itemId: id, decision: "approved", operator, aal: "aal2" })).rejects.toThrow(/no longer available/);
    expect((await client.query("select id from ops_audit")).rows).toHaveLength(2);
  });
});
