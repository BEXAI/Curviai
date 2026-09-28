import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDb, type TestDb } from "./test-helpers";
import { creditLedger, generationJobs, products, workspaces } from "./schema";

let client: PGlite;
let db: TestDb;
let ws: string;
let job: string;

// PGlite returns numeric as text, so coerce before comparing.
async function balance(workspaceId: string): Promise<number> {
  const result = await client.query<{ credit_balance: string | number }>(
    "select credit_balance($1)",
    [workspaceId],
  );
  return Number(result.rows[0].credit_balance);
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;

  const [w] = await db.insert(workspaces).values({ name: "Ledger workspace" }).returning();
  ws = w.id;
  const [p] = await db
    .insert(products)
    .values({ workspaceId: ws, title: "Ceramic mug", mode: "listing" })
    .returning();
  const [j] = await db
    .insert(generationJobs)
    .values({ workspaceId: ws, productId: p.id })
    .returning();
  job = j.id;
});

afterAll(async () => {
  await client.close();
});

describe("credit ledger functions", () => {
  it("sums grants and top ups through credit_balance", async () => {
    expect(await balance(ws)).toBe(0);
    await db.insert(creditLedger).values([
      { workspaceId: ws, delta: 100, reason: "grant", source: "system" },
      { workspaceId: ws, delta: 50, reason: "topup", source: "stripe" },
    ]);
    expect(await balance(ws)).toBe(150);
  });

  it("reserves credits and lowers the balance", async () => {
    await client.query("select reserve_credits($1, $2, $3)", [ws, 60, job]);
    expect(await balance(ws)).toBe(90);
    const [jobRow] = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.id, job));
    expect(jobRow.creditsReserved).toBe(60);
  });

  it("raises on insufficient balance", async () => {
    await expect(
      client.query("select reserve_credits($1, $2, $3)", [ws, 200, job]),
    ).rejects.toThrow(/insufficient credit balance/);
    expect(await balance(ws)).toBe(90);
  });

  it("tags only the insufficient balance failure with SQLSTATE CU402 (Update.md 1.8)", async () => {
    // The app maps this code, and only this code, to 402 Not enough credits.
    await expect(
      client.query("select reserve_credits($1, $2, $3)", [ws, 200, job]),
    ).rejects.toMatchObject({ code: "CU402" });
    const other = await client
      .query("select reserve_credits($1, $2, $3)", ["00000000-0000-4000-8000-0000000000ee", 10, job])
      .then(() => null, (err: { code?: string }) => err);
    expect(other).not.toBeNull();
    expect(other?.code).not.toBe("CU402");
    const nonPositive = await client
      .query("select reserve_credits($1, $2, $3)", [ws, 0, job])
      .then(() => null, (err: { code?: string }) => err);
    expect(nonPositive?.code).not.toBe("CU402");
    expect(await balance(ws)).toBe(90);
  });

  it("rejects non positive reserve amounts", async () => {
    await expect(
      client.query("select reserve_credits($1, $2, $3)", [ws, 0, job]),
    ).rejects.toThrow(/positive/);
  });

  it("charges against the held reservation without double counting", async () => {
    await client.query("select charge_credits($1, $2, $3)", [ws, 40, job]);
    // The reserve already lowered the balance, so charging keeps it at 90.
    expect(await balance(ws)).toBe(90);
    const [jobRow] = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.id, job));
    expect(jobRow.creditsCharged).toBe(40);
  });

  it("refuses to charge more than is held", async () => {
    await expect(
      client.query("select charge_credits($1, $2, $3)", [ws, 30, job]),
    ).rejects.toThrow(/exceeds held credits/);
  });

  it("releases the remaining hold and restores the balance", async () => {
    const result = await client.query<{ release_credits: string | number }>(
      "select release_credits($1, $2)",
      [ws, job],
    );
    expect(Number(result.rows[0].release_credits)).toBe(20);
    // 150 granted minus the 40 actually charged.
    expect(await balance(ws)).toBe(110);
  });

  it("is a no op to release twice", async () => {
    const result = await client.query<{ release_credits: string | number }>(
      "select release_credits($1, $2)",
      [ws, job],
    );
    expect(Number(result.rows[0].release_credits)).toBe(0);
    expect(await balance(ws)).toBe(110);
  });

  it("restores the full balance when a job is released without charges", async () => {
    const [p2] = await db
      .select()
      .from(products)
      .where(eq(products.workspaceId, ws));
    const [j2] = await db
      .insert(generationJobs)
      .values({ workspaceId: ws, productId: p2.id })
      .returning();
    await client.query("select reserve_credits($1, $2, $3)", [ws, 50, j2.id]);
    expect(await balance(ws)).toBe(60);
    await client.query("select release_credits($1, $2)", [ws, j2.id]);
    expect(await balance(ws)).toBe(110);
  });

  it("raises for an unknown workspace", async () => {
    await expect(
      client.query("select reserve_credits($1, $2, $3)", [
        "00000000-0000-4000-8000-0000000000ee",
        10,
        job,
      ]),
    ).rejects.toThrow(/not found/);
  });

  it("handles fractional credits: reserve, charge 0.5 per asset, release the rest", async () => {
    // Plan 9.1 prices deterministic assets at 0.5 credit, so the whole ledger
    // path must carry fractions without rounding.
    const [p] = await db.select().from(products).where(eq(products.workspaceId, ws));
    const [j] = await db
      .insert(generationJobs)
      .values({ workspaceId: ws, productId: p.id })
      .returning();
    const before = await balance(ws);
    await client.query("select reserve_credits($1, $2, $3)", [ws, 10.5, j.id]);
    expect(await balance(ws)).toBe(before - 10.5);
    await client.query("select charge_credits($1, $2, $3, $4)", [ws, 0.5, j.id, "shot-1"]);
    await client.query("select charge_credits($1, $2, $3, $4)", [ws, 0.5, j.id, "shot-2"]);
    const [jobRow] = await db.select().from(generationJobs).where(eq(generationJobs.id, j.id));
    expect(jobRow.creditsCharged).toBe(1);
    const released = await client.query<{ release_credits: string | number }>(
      "select release_credits($1, $2)",
      [ws, j.id],
    );
    expect(Number(released.rows[0].release_credits)).toBe(9.5);
    expect(await balance(ws)).toBe(before - 1);
  });

  it("releases an exact amount per failed shot and refuses to overrelease", async () => {
    const [p] = await db.select().from(products).where(eq(products.workspaceId, ws));
    const [j] = await db
      .insert(generationJobs)
      .values({ workspaceId: ws, productId: p.id })
      .returning();
    const before = await balance(ws);
    await client.query("select reserve_credits($1, $2, $3)", [ws, 5, j.id]);
    const partial = await client.query<{ release_credits: string | number }>(
      "select release_credits($1, $2, $3)",
      [ws, j.id, 2],
    );
    expect(Number(partial.rows[0].release_credits)).toBe(2);
    expect(await balance(ws)).toBe(before - 3);
    await expect(
      client.query("select release_credits($1, $2, $3)", [ws, j.id, 4]),
    ).rejects.toThrow(/exceeds held credits/);
    await expect(
      client.query("select release_credits($1, $2, $3)", [ws, j.id, 0]),
    ).rejects.toThrow(/positive/);
    await client.query("select release_credits($1, $2)", [ws, j.id]);
    expect(await balance(ws)).toBe(before);
  });
});
