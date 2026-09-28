import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assetVariants,
  assets,
  galleryItems,
  generationJobs,
  products,
  shareLinks,
  sourceMedia,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { DbShareStore } from "./db-store";
import { isShareSlug } from "./pick";
import type { ShareWorkspace } from "./types";

// Share pages against the real migrations (0016) in PGlite: who may
// publish, what the public page and the image route may reach, slug reuse,
// the gallery opt in and taking a page down.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let store: DbShareStore;

interface Fixture {
  ws: ShareWorkspace;
  productId: string;
  jobId: string;
  beforeId: string;
  mainVariant: string;
  lifestyleVariant: string;
  lifestyleStory: string;
}

async function makePack(status: "done" | "generating" = "done"): Promise<Fixture> {
  const [w] = await db.insert(workspaces).values({ name: "Shop", plan: "free" }).returning();
  const [p] = await db
    .insert(products)
    .values({ workspaceId: w.id, title: "Copper kettle", mode: "listing", profile: { category: "home_kitchen" } })
    .returning();
  const [media] = await db
    .insert(sourceMedia)
    .values({ workspaceId: w.id, productId: p.id, r2Key: `ws/${w.id}/src/photo`, kind: "image", sha256: "a".repeat(64) })
    .returning();
  const [job] = await db.insert(generationJobs).values({ workspaceId: w.id, productId: p.id, status }).returning();
  const [main] = await db.insert(assets).values({ workspaceId: w.id, jobId: job.id, shotType: "amazon_main" }).returning();
  const [life] = await db.insert(assets).values({ workspaceId: w.id, jobId: job.id, shotType: "lifestyle:1" }).returning();
  const out = (name: string) => `ws/${w.id}/out/${job.id}/${name}`;
  const [mainVariant] = await db
    .insert(assetVariants)
    .values({ workspaceId: w.id, assetId: main.id, channelSpecId: "amazon.main", r2Key: out("main.jpg"), filename: "MAIN.jpg", width: 2000, height: 2000 })
    .returning();
  const [lifeSquare] = await db
    .insert(assetVariants)
    .values({ workspaceId: w.id, assetId: life.id, channelSpecId: "meta.feed_1x1", r2Key: out("life.jpg"), filename: "life.jpg", width: 1080, height: 1080 })
    .returning();
  const [lifeStory] = await db
    .insert(assetVariants)
    .values({ workspaceId: w.id, assetId: life.id, channelSpecId: "meta.story_9x16", r2Key: out("story.jpg"), filename: "story.jpg", width: 1080, height: 1920 })
    .returning();
  return {
    ws: { id: w.id, role: "owner" },
    productId: p.id,
    jobId: job.id,
    beforeId: media.id,
    mainVariant: mainVariant.id,
    lifestyleVariant: lifeSquare.id,
    lifestyleStory: lifeStory.id,
  };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  store = new DbShareStore(db as unknown as Db);
});

afterAll(async () => {
  await client.close();
});

describe("publishing", () => {
  it("publishes a finished pack as a before and after with the lifestyle scene as the hero", async () => {
    const f = await makePack();
    const before = await store.getStatus(f.ws, f.jobId);
    expect(before).toMatchObject({ eligible: true, canPublish: true, published: false, path: null, hasBefore: true });

    const result = await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.published).toBe(true);
    expect(isShareSlug(result.status.slug)).toBe(true);
    expect(result.status.path).toBe(`/s/${result.status.slug}`);
    expect(result.status.inGallery).toBe(false);

    const page = await store.getPublic(result.status.slug!);
    expect(page).toMatchObject({ kind: "before_after", title: "Copper kettle", category: "home_kitchen", illustration: false });
    expect(page?.before?.src).toBe(`/s/${result.status.slug}/image/before`);
    expect(page?.after?.ref).toBe(`v_${f.lifestyleVariant}`);
    expect(page?.images).toEqual([]);
    // Nothing on the public view names a row id beyond the served image refs, or a key.
    expect(JSON.stringify(page)).not.toContain(f.ws.id);
    expect(JSON.stringify(page)).not.toContain(f.jobId);
  });

  it("refuses editors and clients, and packs with nothing delivered", async () => {
    const f = await makePack();
    for (const role of ["editor", "client"] as const) {
      const result = await store.publish({ id: f.ws.id, role }, f.jobId, { kind: "pack", gallery: true });
      expect(result).toMatchObject({ ok: false, reason: "forbidden" });
      expect((await store.getStatus({ id: f.ws.id, role }, f.jobId))?.canPublish).toBe(false);
    }
    const running = await makePack("generating");
    expect(await store.publish(running.ws, running.jobId, { kind: "pack", gallery: false })).toMatchObject({
      ok: false,
      reason: "not_ready",
    });
    expect((await store.getStatus(running.ws, running.jobId))?.eligible).toBe(false);
  });

  it("never reaches another workspace's pack", async () => {
    const mine = await makePack();
    const theirs = await makePack();
    expect(await store.getStatus(mine.ws, theirs.jobId)).toBeNull();
    expect(await store.publish(mine.ws, theirs.jobId, { kind: "pack", gallery: false })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await store.publish(mine.ws, "not-a-uuid", { kind: "pack", gallery: false })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("keeps the slug across unpublish and republish, and switches what it shows", async () => {
    const f = await makePack();
    const first = await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: false });
    if (!first.ok) throw new Error("publish failed");
    const slug = first.status.slug!;
    const down = await store.unpublish(f.ws, f.jobId);
    expect(down).toMatchObject({ ok: true, status: { published: false, path: null, slug } });
    expect(await store.getPublic(slug)).toBeNull();
    expect(await store.imageKey(slug, "before")).toBeNull();

    const again = await store.publish(f.ws, f.jobId, { kind: "pack", gallery: false });
    expect(again).toMatchObject({ ok: true, status: { published: true, slug, kind: "pack" } });
    const page = await store.getPublic(slug);
    expect(page?.images.map((i) => i.ref)).toEqual([`v_${f.lifestyleVariant}`, `v_${f.mainVariant}`]);
    const rows = await db.select().from(shareLinks).where(eq(shareLinks.jobId, f.jobId));
    expect(rows).toHaveLength(1);
  });
});

describe("the image route's keys", () => {
  it("serves only what the page shows, and only while it is published", async () => {
    const f = await makePack();
    const result = await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: false });
    if (!result.ok) throw new Error("publish failed");
    const slug = result.status.slug!;
    expect(await store.imageKey(slug, "before")).toBe(`ws/${f.ws.id}/src/photo`);
    expect(await store.imageKey(slug, `v_${f.lifestyleVariant}`)).toBe(`ws/${f.ws.id}/out/${f.jobId}/life.jpg`);
    // A before and after page does not expose the rest of the pack, or the
    // other files of the hero shot.
    expect(await store.imageKey(slug, `v_${f.mainVariant}`)).toBeNull();
    expect(await store.imageKey(slug, `v_${f.lifestyleStory}`)).toBeNull();
    expect(await store.imageKey(slug, "v_not-a-uuid")).toBeNull();
    expect(await store.imageKey(slug, "../etc")).toBeNull();

    await store.publish(f.ws, f.jobId, { kind: "pack", gallery: false });
    expect(await store.imageKey(slug, `v_${f.mainVariant}`)).toBe(`ws/${f.ws.id}/out/${f.jobId}/main.jpg`);
    expect(await store.imageKey(slug, `v_${f.lifestyleStory}`)).toBeNull();
  });

  it("never serves a stored key outside the workspace", async () => {
    const f = await makePack();
    const other = await makePack();
    await db
      .update(sourceMedia)
      .set({ r2Key: `ws/${other.ws.id}/src/photo` })
      .where(eq(sourceMedia.id, f.beforeId))
      .catch(() => undefined);
    const result = await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: false });
    if (!result.ok) throw new Error("publish failed");
    const key = await store.imageKey(result.status.slug!, "before");
    expect(key === null || key.startsWith(`ws/${f.ws.id}/`)).toBe(true);
  });
});

describe("the gallery", () => {
  it("lists a makeover only while the owner opts in and the page is up", async () => {
    const f = await makePack();
    const shown = await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: true });
    if (!shown.ok) throw new Error("publish failed");
    const slug = shown.status.slug!;
    expect(shown.status.inGallery).toBe(true);
    expect((await store.getPublic(slug))?.inGallery).toBe(true);
    expect((await store.listGallery(50)).map((e) => e.slug)).toContain(slug);
    const [item] = await db.select().from(galleryItems).where(eq(galleryItems.shareSlug, slug));
    expect(item.consentAt).toBeInstanceOf(Date);
    expect(item.category).toBe("home_kitchen");

    await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: false });
    expect((await store.listGallery(50)).map((e) => e.slug)).not.toContain(slug);

    await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: true });
    expect((await store.listGallery(50)).map((e) => e.slug)).toContain(slug);
    await store.unpublish(f.ws, f.jobId);
    expect((await store.listGallery(50)).map((e) => e.slug)).not.toContain(slug);
    const items = await db.select().from(galleryItems).where(eq(galleryItems.shareSlug, slug));
    expect(items).toHaveLength(1);
    expect(items[0].published).toBe(false);
  });
});

describe("views", () => {
  it("counts views of a published page only", async () => {
    const f = await makePack();
    const result = await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: false });
    if (!result.ok) throw new Error("publish failed");
    const slug = result.status.slug!;
    await store.recordView(slug);
    await store.recordView(slug);
    await store.recordView("unknownsl2");
    expect((await store.getStatus(f.ws, f.jobId))?.views).toBe(2);
    await store.unpublish(f.ws, f.jobId);
    await store.recordView(slug);
    expect((await store.getStatus(f.ws, f.jobId))?.views).toBe(2);
  });
});
