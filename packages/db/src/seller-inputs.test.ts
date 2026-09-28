import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { actAs, actAsSuperuser, createAppUserRole, createTestDb, type TestDb } from "./test-helpers";
import { products, sourceMedia, workspaces } from "./schema";

// Migration 0014: seller inputs on products (sku, box_contents,
// comparison_facts) and the photo role on source_media (angle). No new
// table, so the 0011 policies must keep covering the new columns: members
// of another workspace never see them, a client seat cannot change them, and
// an editor can. The angle column only takes the six roles.

const OWNER_A = "00000000-0000-4000-8000-0000000014a1";
const EDITOR_A = "00000000-0000-4000-8000-0000000014a2";
const CLIENT_A = "00000000-0000-4000-8000-0000000014a3";
const OWNER_B = "00000000-0000-4000-8000-0000000014b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let productA: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  wsB = b.id;
  await client.query(
    `insert into members (workspace_id, user_id, role) values
       ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'client'), ($5, $6, 'owner')`,
    [wsA, OWNER_A, EDITOR_A, CLIENT_A, wsB, OWNER_B],
  );
  const [p] = await db
    .insert(products)
    .values({
      workspaceId: wsA,
      title: "Mug",
      mode: "listing",
      sku: "MUG-01",
      boxContents: ["Mug", "Pour over cone"],
      comparisonFacts: ["Holds 12 oz, most hold 8 oz"],
    })
    .returning();
  productA = p.id;
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await client.close();
});

describe("0014 seller inputs", () => {
  it("stores the seller inputs on the product", async () => {
    const [row] = await db.select().from(products).where(eq(products.id, productA));
    expect(row.sku).toBe("MUG-01");
    expect(row.boxContents).toEqual(["Mug", "Pour over cone"]);
    expect(row.comparisonFacts).toEqual(["Holds 12 oz, most hold 8 oz"]);
  });

  it("takes only the six photo roles, or none", async () => {
    for (const angle of ["front", "back", "side", "detail", "in_the_box", "scale"] as const) {
      await db.insert(sourceMedia).values({
        workspaceId: wsA,
        productId: productA,
        r2Key: `ws/${wsA}/src/${angle}`,
        sha256: angle,
        angle,
      });
    }
    await db.insert(sourceMedia).values({ workspaceId: wsA, productId: productA, r2Key: `ws/${wsA}/src/none`, sha256: "n" });
    await expect(
      client.query(
        "insert into source_media (workspace_id, product_id, r2_key, sha256, angle) values ($1, $2, $3, 'x', 'top')",
        [wsA, productA, `ws/${wsA}/src/top`],
      ),
    ).rejects.toThrow(/source_media_angle_check/);
  });

  it("hides the seller inputs from another workspace", async () => {
    await actAs(client, OWNER_B);
    const rows = await client.query<{ sku: string | null }>("select sku from products where id = $1", [productA]);
    expect(rows.rows).toHaveLength(0);
    const media = await client.query("select angle from source_media where product_id = $1", [productA]);
    expect(media.rows).toHaveLength(0);
  });

  it("lets an editor change them and keeps a client seat read only", async () => {
    await actAs(client, CLIENT_A);
    const seen = await client.query<{ sku: string }>("select sku from products where id = $1", [productA]);
    expect(seen.rows[0]?.sku).toBe("MUG-01");
    await client.query("update products set sku = 'CLIENT' where id = $1", [productA]);
    await client.query("update source_media set angle = 'back' where product_id = $1", [productA]);
    await actAsSuperuser(client);
    const [afterClient] = await db.select().from(products).where(eq(products.id, productA));
    expect(afterClient.sku).toBe("MUG-01");
    const front = await db.select().from(sourceMedia).where(eq(sourceMedia.r2Key, `ws/${wsA}/src/front`));
    expect(front[0]?.angle).toBe("front");

    await actAs(client, EDITOR_A);
    await client.query("update products set box_contents = '[\"Mug\"]'::jsonb where id = $1", [productA]);
    await actAsSuperuser(client);
    const [afterEditor] = await db.select().from(products).where(eq(products.id, productA));
    expect(afterEditor.boxContents).toEqual(["Mug"]);
  });

  it("keeps owners of workspace A in their own lane", async () => {
    await actAs(client, OWNER_A);
    const rows = await client.query<{ workspace_id: string }>("select workspace_id from products");
    expect(rows.rows.every((r) => r.workspace_id === wsA)).toBe(true);
    expect(rows.rows.some((r) => r.workspace_id === wsB)).toBe(false);
  });
});
