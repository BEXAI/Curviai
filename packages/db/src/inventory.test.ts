import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { actAs, actAsSuperuser, createAppUserRole, createTestDb, type TestDb } from "./test-helpers";
import { generationJobs, products, workspaces, type JobInventory } from "./schema";

// Migration 0021: the product inventory on generation_jobs. No new table, so
// the existing policies must keep covering the new column: another
// workspace never sees it and a client seat cannot change it.

const OWNER_A = "00000000-0000-4000-8000-0000000021a1";
const CLIENT_A = "00000000-0000-4000-8000-0000000021a3";
const OWNER_B = "00000000-0000-4000-8000-0000000021b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let productA: string;
let jobA: string;

const inventory: JobInventory = {
  version: 1,
  photos: [
    {
      mediaId: "ws/a/src/p1",
      items: [
        {
          label: "Blue Gatorade bottle",
          labelSource: "intake",
          box: { x: 0.1, y: 0.2, width: 0.3, height: 0.6 },
          areaShare: 0.12,
          aspectRatio: 2,
          shape: "tall",
          colorHex: "#1e50c8",
          colorName: "blue",
          status: "featured",
        },
        {
          label: "red tall object",
          labelSource: "deterministic",
          box: { x: 0.6, y: 0.2, width: 0.3, height: 0.6 },
          areaShare: 0.12,
          aspectRatio: 2,
          shape: "tall",
          colorHex: "#c81e1e",
          colorName: "red",
          status: "removed",
        },
      ],
      intakeCount: 1,
      countMatch: false,
      unmatchedItems: [1],
      unmatchedProducts: [],
      rule: "note",
      touching: false,
    },
  ],
};

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
  const [job] = await db.insert(generationJobs).values({ workspaceId: wsA, productId: productA, inventory }).returning();
  jobA = job.id;
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("0021 inventory", () => {
  it("stores the inventory", async () => {
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
    expect(job.inventory).toEqual(inventory);
  });

  it("is null on rows written without it", async () => {
    const [job] = await db.insert(generationJobs).values({ workspaceId: wsA, productId: productA }).returning();
    expect(job.inventory).toBeNull();
  });

  it("hides it from another workspace", async () => {
    await actAs(client, OWNER_B);
    const jobs = await client.query("select inventory from generation_jobs where id = $1", [jobA]);
    expect(jobs.rows).toHaveLength(0);
  });

  it("keeps a client seat read only", async () => {
    await actAs(client, CLIENT_A);
    const seen = await client.query<{ inventory: JobInventory }>("select inventory from generation_jobs where id = $1", [jobA]);
    expect(seen.rows[0]?.inventory.photos[0].items).toHaveLength(2);
    await client.query("update generation_jobs set inventory = null where id = $1", [jobA]).catch(() => undefined);
    await actAsSuperuser(client);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
    expect(job.inventory).toEqual(inventory);
  });
});
