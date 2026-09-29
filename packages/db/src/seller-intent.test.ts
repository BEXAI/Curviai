import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { actAs, actAsSuperuser, createAppUserRole, createTestDb, type TestDb } from "./test-helpers";
import { generationJobs, products, sourceMedia, workspaces } from "./schema";

// Migration 0020: the seller's note and parsed intent on generation_jobs,
// and the chosen product box on source_media. No new table, so the existing
// policies must keep covering the new columns: another workspace never sees
// them and a client seat cannot change them.

const OWNER_A = "00000000-0000-4000-8000-0000000020a1";
const CLIENT_A = "00000000-0000-4000-8000-0000000020a3";
const OWNER_B = "00000000-0000-4000-8000-0000000020b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let productA: string;
let jobA: string;
let mediaA: string;

const intent = { featureOnly: "blue bottle", exclude: ["red bottle"], mustKeep: [], styleNotes: null };
const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.6 };

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  await client.query(
    `insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'client'), ($4, $5, 'owner')`,
    [wsA, OWNER_A, CLIENT_A, b.id, OWNER_B],
  );
  const [p] = await db.insert(products).values({ workspaceId: wsA, title: "Bottle", mode: "listing" }).returning();
  productA = p.id;
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: wsA, productId: productA, sellerNote: "Only the blue one", sellerIntent: intent })
    .returning();
  jobA = job.id;
  const [media] = await db
    .insert(sourceMedia)
    .values({ workspaceId: wsA, productId: productA, r2Key: `ws/${wsA}/src/p1`, sha256: "p1", targetBox: box })
    .returning();
  mediaA = media.id;
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("0020 seller intent", () => {
  it("stores the note, the parsed intent and the target box", async () => {
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
    expect(job.sellerNote).toBe("Only the blue one");
    expect(job.sellerIntent).toEqual(intent);
    const [media] = await db.select().from(sourceMedia).where(eq(sourceMedia.id, mediaA));
    expect(media.targetBox).toEqual(box);
  });

  it("leaves all three null on rows written without them", async () => {
    const [job] = await db.insert(generationJobs).values({ workspaceId: wsA, productId: productA }).returning();
    expect(job.sellerNote).toBeNull();
    expect(job.sellerIntent).toBeNull();
    const [media] = await db
      .insert(sourceMedia)
      .values({ workspaceId: wsA, productId: productA, r2Key: `ws/${wsA}/src/p2`, sha256: "p2" })
      .returning();
    expect(media.targetBox).toBeNull();
  });

  it("hides them from another workspace", async () => {
    await actAs(client, OWNER_B);
    const jobs = await client.query("select seller_note, seller_intent from generation_jobs where id = $1", [jobA]);
    expect(jobs.rows).toHaveLength(0);
    const media = await client.query("select target_box from source_media where id = $1", [mediaA]);
    expect(media.rows).toHaveLength(0);
  });

  it("keeps a client seat read only", async () => {
    await actAs(client, CLIENT_A);
    const seen = await client.query<{ seller_note: string }>("select seller_note from generation_jobs where id = $1", [jobA]);
    expect(seen.rows[0]?.seller_note).toBe("Only the blue one");
    await client.query("update generation_jobs set seller_note = 'changed' where id = $1", [jobA]).catch(() => undefined);
    await client.query("update source_media set target_box = null where id = $1", [mediaA]).catch(() => undefined);
    await actAsSuperuser(client);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
    expect(job.sellerNote).toBe("Only the blue one");
    const [media] = await db.select().from(sourceMedia).where(eq(sourceMedia.id, mediaA));
    expect(media.targetBox).toEqual(box);
  });
});
