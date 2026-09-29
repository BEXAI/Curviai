import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { actAs, actAsSuperuser, createAppUserRole, createTestDb, type TestDb } from "./test-helpers";
import { generationJobs, products, sourceMedia, workspaces } from "./schema";

// Migration 0023: the seller's output options on generation_jobs, the saved
// choices on products and the ingest check on source_media. No new table, so
// the existing policies must keep covering the new columns: another
// workspace never sees or changes them. Each column holds an object or null.

const OWNER_A = "00000000-0000-4000-8000-0000000023a1";
const OWNER_B = "00000000-0000-4000-8000-0000000023b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let productA: string;
let jobA: string;
let mediaA: string;

const options = { v: 1, look: "marketplace", background: { kind: "white" } };
const defaults = { look: "brand", background: { kind: "brand", index: 0 } };
const ingest = { width: 3024, height: 4032, reencoded: false };

const COLUMNS = [
  { table: "generation_jobs", column: "output_options", constraint: "generation_jobs_output_options_object" },
  { table: "products", column: "output_defaults", constraint: "products_output_defaults_object" },
  { table: "source_media", column: "ingest", constraint: "source_media_ingest_object" },
] as const;

function rowId(table: (typeof COLUMNS)[number]["table"]): string {
  return table === "generation_jobs" ? jobA : table === "products" ? productA : mediaA;
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  await client.query(`insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')`, [
    wsA,
    OWNER_A,
    b.id,
    OWNER_B,
  ]);
  const [p] = await db
    .insert(products)
    .values({ workspaceId: wsA, title: "Kettle", mode: "listing", outputDefaults: defaults })
    .returning();
  productA = p.id;
  const [job] = await db
    .insert(generationJobs)
    .values({ workspaceId: wsA, productId: productA, outputOptions: options })
    .returning();
  jobA = job.id;
  const [media] = await db
    .insert(sourceMedia)
    .values({ workspaceId: wsA, productId: productA, r2Key: `ws/${wsA}/src/o1`, sha256: "o1", ingest })
    .returning();
  mediaA = media.id;
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("0023 output options", () => {
  it("adds three nullable jsonb columns", async () => {
    for (const { table, column } of COLUMNS) {
      const res = await client.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        `select data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = $1 and column_name = $2`,
        [table, column],
      );
      expect(res.rows, `${table}.${column}`).toEqual([{ data_type: "jsonb", is_nullable: "YES", column_default: null }]);
    }
  });

  it("stores the options, the saved choices and the ingest check", async () => {
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
    expect(job.outputOptions).toEqual(options);
    const [product] = await db.select().from(products).where(eq(products.id, productA));
    expect(product.outputDefaults).toEqual(defaults);
    const [media] = await db.select().from(sourceMedia).where(eq(sourceMedia.id, mediaA));
    expect(media.ingest).toEqual(ingest);
  });

  it("reads null on rows written without them", async () => {
    const [product] = await db.insert(products).values({ workspaceId: wsA, title: "Old", mode: "listing" }).returning();
    expect(product.outputDefaults).toBeNull();
    const [job] = await db.insert(generationJobs).values({ workspaceId: wsA, productId: product.id }).returning();
    expect(job.outputOptions).toBeNull();
    const [media] = await db
      .insert(sourceMedia)
      .values({ workspaceId: wsA, productId: product.id, r2Key: `ws/${wsA}/src/o2`, sha256: "o2" })
      .returning();
    expect(media.ingest).toBeNull();
  });

  it("accepts an object or null and rejects any other JSON value", async () => {
    for (const { table, column, constraint } of COLUMNS) {
      const id = rowId(table);
      for (const bad of ["[]", '"white"', "3", "true", "null"]) {
        await expect(
          client.query(`update ${table} set ${column} = $1::jsonb where id = $2`, [bad, id]),
          `${table}.${column} = ${bad}`,
        ).rejects.toThrow(constraint);
      }
      await client.query(`update ${table} set ${column} = null where id = $1`, [id]);
      await client.query(`update ${table} set ${column} = '{}'::jsonb where id = $1`, [id]);
    }
    await db.update(generationJobs).set({ outputOptions: options }).where(eq(generationJobs.id, jobA));
    await db.update(products).set({ outputDefaults: defaults }).where(eq(products.id, productA));
    await db.update(sourceMedia).set({ ingest }).where(eq(sourceMedia.id, mediaA));
  });

  it("hides them from another workspace", async () => {
    await actAs(client, OWNER_B);
    for (const { table, column } of COLUMNS) {
      const res = await client.query(`select ${column} from ${table} where id = $1`, [rowId(table)]);
      expect(res.rows, table).toHaveLength(0);
    }
  });

  it("keeps another workspace from changing them", async () => {
    await actAs(client, OWNER_B);
    for (const { table, column } of COLUMNS) {
      await client.query(`update ${table} set ${column} = '{"x": 1}'::jsonb where id = $1`, [rowId(table)]).catch(() => undefined);
    }
    await actAsSuperuser(client);
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobA));
    expect(job.outputOptions).toEqual(options);
    const [product] = await db.select().from(products).where(eq(products.id, productA));
    expect(product.outputDefaults).toEqual(defaults);
    const [media] = await db.select().from(sourceMedia).where(eq(sourceMedia.id, mediaA));
    expect(media.ingest).toEqual(ingest);
  });
});
