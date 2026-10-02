import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StoredFidelity } from "@curvi/pipeline/fidelity-record";
import { assetVariants, assets, generationJobs, products, shareLinks, sourceMedia, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { proofImages } from "@/components/marketing/share-proof-panel";
import { complianceFromQc } from "@/lib/services/job-shots";
import { fileProofsFromQc, proofForFile } from "@/lib/proof-view";
import { NOT_REDRAWN_NOTE, SCENE_CAPTION } from "@/lib/proof-copy";
import { DbShareStore } from "./db-store";
import type { ShareWorkspace } from "./types";

// P18-16: the opt in proof panel. The share store returns proof only when
// show_proof is on, its numbers match the pack page's "See the proof", and
// nothing private (file keys, workspace or job ids, file names) reaches
// the public view.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let store: DbShareStore;

const mainFidelity: StoredFidelity = {
  meanDeltaE: 0.12,
  maxDeltaE: 1.4,
  exactByteShare: 0.9431,
  maskArea: 2_400_000,
  threshold: 3,
  maxDeltaELimit: 10,
  kind: "main",
  exact: false,
};
const sceneFidelity: StoredFidelity = { ...mainFidelity, meanDeltaE: 0.84, maxDeltaE: 3.2, threshold: 5, kind: "other" };

const mainQc = {
  pass: true,
  shotId: "s01_amazon_main",
  specId: "amazon.main",
  fillPct: 87,
  background: [255, 255, 255],
  fidelity: mainFidelity,
  digitalSource: "none",
  outputs: [
    {
      specId: "amazon.main",
      fidelity: mainFidelity,
      checks: [
        { name: "dimensions", pass: true, measured: "2000x2000", limit: "1x1 to 10000x10000" },
        { name: "backgroundWhiteShare", pass: true, measured: 1, limit: ">= 1" },
        { name: "fillRatio", pass: true, measured: 0.8731, limit: "0.85 to 0.9" },
      ],
    },
  ],
};

const sceneQc = {
  pass: true,
  shotId: "s02_lifestyle",
  specId: "meta.feed_1x1",
  fillPct: null,
  background: null,
  fidelity: sceneFidelity,
  digitalSource: "composite",
  outputs: [
    {
      specId: "meta.feed_1x1",
      fidelity: sceneFidelity,
      checks: [{ name: "dimensions", pass: true, measured: "1080x1080", limit: "exactly 1080x1080" }],
    },
  ],
};

async function makePack(): Promise<{ ws: ShareWorkspace; jobId: string }> {
  const [w] = await db.insert(workspaces).values({ name: "Candles", plan: "starter" }).returning();
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Amber candle", mode: "listing" }).returning();
  await db
    .insert(sourceMedia)
    .values({ workspaceId: w.id, productId: p.id, r2Key: `ws/${w.id}/src/photo`, kind: "image", sha256: "b".repeat(64) });
  const [job] = await db.insert(generationJobs).values({ workspaceId: w.id, productId: p.id, status: "done" }).returning();
  const [main] = await db
    .insert(assets)
    .values({ workspaceId: w.id, jobId: job.id, shotType: "amazon_main", approved: true, qc: mainQc })
    .returning();
  const [scene] = await db
    .insert(assets)
    .values({ workspaceId: w.id, jobId: job.id, shotType: "lifestyle", approved: true, qc: sceneQc })
    .returning();
  const out = (name: string) => `ws/${w.id}/out/${job.id}/${name}`;
  await db.insert(assetVariants).values([
    { workspaceId: w.id, assetId: main.id, channelSpecId: "amazon.main", r2Key: out("main.jpg"), filename: "CANDLE.MAIN.jpg", width: 2000, height: 2000 },
    { workspaceId: w.id, assetId: scene.id, channelSpecId: "meta.feed_1x1", r2Key: out("scene.jpg"), filename: "scene_secret.jpg", width: 1080, height: 1080 },
  ]);
  return { ws: { id: w.id, role: "owner" }, jobId: job.id };
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

describe("the share store and show_proof", () => {
  it("returns no proof on a page whose owner left it off, the default", async () => {
    const f = await makePack();
    const result = await store.publish(f.ws, f.jobId, { kind: "pack", gallery: false });
    expect(result.ok && result.status.showProof).toBe(false);
    const slug = result.ok ? result.status.slug! : "";
    const page = await store.getPublic(slug);
    expect(page?.proof).toBe(false);
    expect(page?.after?.proof).toBeUndefined();
    expect(page?.images.every((image) => image.proof === undefined)).toBe(true);
    expect(proofImages(page!)).toEqual([]);
    const row = await db.select().from(shareLinks).where(eq(shareLinks.slug, slug));
    expect(row[0].showProof).toBe(false);
  });

  it("returns each image's proof with proof on, matching the pack page's numbers", async () => {
    const f = await makePack();
    const result = await store.publish(f.ws, f.jobId, { kind: "pack", gallery: false, proof: true });
    expect(result.ok && result.status.showProof).toBe(true);
    const page = (await store.getPublic(result.ok ? result.status.slug! : ""))!;
    expect(page.proof).toBe(true);

    const scene = page.images.find((image) => image.specId === "meta.feed_1x1")!;
    expect(scene.proof).toMatchObject({
      channel: "Meta feed square",
      productUnchanged: "Product not redrawn: average color difference 0.84, limit 5",
      note: NOT_REDRAWN_NOTE,
      caption: SCENE_CAPTION,
    });
    const main = page.images.find((image) => image.specId === "amazon.main")!;
    expect(main.proof?.rows.map((row) => [row.label, row.measured, row.pass])).toEqual([
      ["Image size", "2000 x 2000 px", true],
      ["Pure white background", "100 percent", true],
      ["Product fill", "87.31 percent", true],
    ]);
    expect(main.proof?.productUnchanged).toBe("Product not redrawn: average color difference 0.12, limit 3");
    expect(main.proof?.caption).toBeNull();

    // The pack page's "See the proof" reads the same asset rows.
    expect(complianceFromQc(mainQc)?.files).toEqual([main.proof]);
    expect(fileProofsFromQc(sceneQc)).toEqual([scene.proof]);
    expect(proofImages(page)).toHaveLength(2);
  });

  it("puts no key, id, file name or metadata on the public view", async () => {
    const f = await makePack();
    const result = await store.publish(f.ws, f.jobId, { kind: "pack", gallery: false, proof: true });
    const text = JSON.stringify(await store.getPublic(result.ok ? result.status.slug! : ""));
    for (const secret of [f.ws.id, f.jobId, "ws/", "scene_secret", "CANDLE.MAIN", "exactByteShare", "maskArea"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("keeps the owner's choice on a republish that does not name it, and turns it off when asked", async () => {
    const f = await makePack();
    await store.publish(f.ws, f.jobId, { kind: "pack", gallery: false, proof: true });
    const again = await store.publish(f.ws, f.jobId, { kind: "before_after", gallery: false });
    expect(again.ok && again.status.showProof).toBe(true);
    const page = await store.getPublic(again.ok ? again.status.slug! : "");
    // A before and after page shows the hero's proof only.
    expect(page?.after?.proof?.caption).toBe(SCENE_CAPTION);
    expect(proofImages(page!)).toHaveLength(1);
    const off = await store.publish(f.ws, f.jobId, { kind: "pack", gallery: false, proof: false });
    expect(off.ok && off.status.showProof).toBe(false);
  });

  it("shows the channel and caption for a file saved before Phase 18", () => {
    const proof = proofForFile({ pass: true, shotId: "s9", specId: "meta.feed_1x1", digitalSource: "composite" }, "meta.feed_1x1");
    expect(proof).toEqual({
      specId: "meta.feed_1x1",
      channel: "Meta feed square",
      rows: [],
      productUnchanged: null,
      note: null,
      caption: SCENE_CAPTION,
    });
    // A representative record still counts for the spec it was measured on.
    expect(proofForFile({ specId: "amazon.main", fidelity: mainFidelity }, "amazon.main").productUnchanged).toBe(
      "Product not redrawn: average color difference 0.12, limit 3",
    );
    expect(proofForFile({ specId: "amazon.main", fidelity: mainFidelity }, "shopify.product").productUnchanged).toBeNull();
  });
});
