import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assetVariants, assets, galleryItems, generationJobs, members, packFeedback, products, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, loadChannelSpecs, type Db } from "@curvi/db";
import { clearGalleryCache, DbShareStore } from "./db-store";

// P18-14 gallery hygiene against the real migrations: a pack made in an
// operator's workspace (OPS_EMAILS, founder decision 15) is labeled as the
// Curvi team's; a seller's entry keeps "Shared by the seller" and carries
// the seller's consented quote (P18-05). Without OPS_EMAILS nothing is
// labeled as the team's.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;

const OPERATOR = "00000000-0000-4000-8000-00000000e101";
const SELLER = "00000000-0000-4000-8000-00000000e102";

async function galleryPack(owner: string, title: string): Promise<{ workspaceId: string; jobId: string }> {
  const [w] = await db.insert(workspaces).values({ name: title }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: owner, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title, mode: "listing" }).returning();
  const [job] = await db.insert(generationJobs).values({ workspaceId: w.id, productId: p.id, status: "done" }).returning();
  const [main] = await db.insert(assets).values({ workspaceId: w.id, jobId: job.id, shotType: "amazon_main" }).returning();
  await db.insert(assetVariants).values({
    workspaceId: w.id,
    assetId: main.id,
    channelSpecId: "amazon.main",
    r2Key: `ws/${w.id}/out/${job.id}/main.jpg`,
    filename: "MAIN.jpg",
    width: 2000,
    height: 2000,
  });
  const store = new DbShareStore(db as unknown as Db);
  const published = await store.publish({ id: w.id, role: "owner" }, job.id, { kind: "before_after", gallery: true });
  expect(published.ok).toBe(true);
  await db.update(galleryItems).set({ reviewStatus: "approved" }).where(eq(galleryItems.workspaceId, w.id));
  clearGalleryCache(db as unknown as Db);
  return { workspaceId: w.id, jobId: job.id };
}

let seller: { workspaceId: string; jobId: string };

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  // Supabase's auth.users, as far as the operator lookup reads it.
  await client.exec("create table if not exists auth.users (id uuid primary key, email text)");
  await client.query("insert into auth.users (id, email) values ($1, 'Founder@Curvi.ai'), ($2, 'seller@shop.example')", [
    OPERATOR,
    SELLER,
  ]);
  await galleryPack(OPERATOR, "Founder candle");
  seller = await galleryPack(SELLER, "Oak soap");
  await db.insert(packFeedback).values({
    workspaceId: seller.workspaceId,
    jobId: seller.jobId,
    userId: SELLER,
    usable: "yes",
    comment: "Listed it the same day.",
    quoteConsent: true,
    displayName: "Sam, Oak Soap",
  });
});

afterEach(() => {
  delete process.env.OPS_EMAILS;
});

afterAll(async () => {
  await client.close();
});

describe("gallery labels", () => {
  it("label the operator's pack as the team's and quote the seller", async () => {
    process.env.OPS_EMAILS = "founder@curvi.ai";
    const entries = await new DbShareStore(db as unknown as Db).listGallery(10);
    const byTitle = new Map(entries.map((entry) => [entry.title, entry]));
    expect(byTitle.get("Founder candle")).toMatchObject({ madeByTeam: true, quote: null });
    expect(byTitle.get("Oak soap")).toMatchObject({
      madeByTeam: false,
      quote: { text: "Listed it the same day.", name: "Sam, Oak Soap" },
    });
  });

  it("label nothing as the team's without OPS_EMAILS", async () => {
    // The gallery cache is kept per page size, so another size reads again.
    const entries = await new DbShareStore(db as unknown as Db).listGallery(11);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.madeByTeam === false)).toBe(true);
  });
});
