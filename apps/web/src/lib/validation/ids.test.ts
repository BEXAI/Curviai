import { describe, expect, it } from "vitest";
import { isUuid, productIdSchema, uuidSchema } from "./ids";

describe("id validation (Update.md 4.7)", () => {
  it("accepts canonical uuids in either case", () => {
    expect(isUuid("0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d")).toBe(true);
    expect(isUuid("0B7A4D1E-5C3F-4A2B-9E8D-7C6B5A4F3E2D")).toBe(true);
    // The demo store's ids are canonical too.
    expect(isUuid("00000000-0000-4000-8000-900000000001")).toBe(true);
    expect(uuidSchema.safeParse("00000000-0000-4000-8000-0000000000a1").success).toBe(true);
  });

  it("rejects values that would make Postgres raise 22P02", () => {
    for (const value of ["abc", "", "new", "0b7a4d1e5c3f4a2b9e8d7c6b5a4f3e2d", "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2", "' or 1=1 --", 42, null]) {
      expect(isUuid(value)).toBe(false);
    }
    expect(uuidSchema.safeParse("abc").success).toBe(false);
  });

  it("allows the literal new or a uuid as a product id", () => {
    expect(productIdSchema.safeParse("new").success).toBe(true);
    expect(productIdSchema.safeParse("0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d").success).toBe(true);
    expect(productIdSchema.safeParse("anything").success).toBe(false);
    expect(productIdSchema.safeParse("NEW").success).toBe(false);
  });
});
