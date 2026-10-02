import type { PGlite } from "@electric-sql/pglite";
import { createTestDb } from "@curvi/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRecipientKey, normalizedEmailAddress, normalizedEmailKey } from "./keys";

// The recipient key must match normalized_email_key (migration 0012) exactly,
// so the same inbox has one key everywhere.

let client: PGlite;

beforeAll(async () => {
  client = (await createTestDb()).client;
});

afterAll(async () => {
  await client.close();
});

const SAMPLES = [
  "seller@example.com",
  "  Seller@Example.COM  ",
  "first.last+promo@gmail.com",
  "FirstLast@GoogleMail.com",
  "a.b+c+d@outlook.com",
  "odd@name@example.com",
  "+tag@example.com",
  "no-at-sign",
  "",
  "@example.com",
];

describe("normalizedEmailKey", () => {
  it("matches the SQL normalized_email_key for every sample", async () => {
    for (const sample of SAMPLES) {
      const sql = await client.query<{ key: string | null }>("select normalized_email_key($1) as key", [sample]);
      expect(normalizedEmailKey(sample), sample).toBe(sql.rows[0].key);
    }
  });

  it("folds case, plus tags and Gmail dots into one inbox", () => {
    expect(normalizedEmailAddress(" First.Last+x@GoogleMail.com ")).toBe("firstlast@gmail.com");
    expect(normalizedEmailKey("first.last@gmail.com")).toBe(normalizedEmailKey("FirstLast+news@googlemail.com"));
    expect(normalizedEmailKey("a.b@example.com")).not.toBe(normalizedEmailKey("ab@example.com"));
  });

  it("gives null for something that is not an address and a 64 hex key otherwise", () => {
    expect(normalizedEmailKey("not an email")).toBeNull();
    expect(normalizedEmailKey(null)).toBeNull();
    const key = normalizedEmailKey("seller@example.com");
    expect(isRecipientKey(key)).toBe(true);
    expect(isRecipientKey("seller@example.com")).toBe(false);
  });
});
