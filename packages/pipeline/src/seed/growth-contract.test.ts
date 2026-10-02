import { describe, expect, it } from "vitest";
import { platformSettingSeedRows } from "./credits";
import {
  growthPlatformSettingSeedRows,
  isSignupSourceKey,
  signupSourceKeys,
  signupSourcePrefixes,
} from "./growth";
import * as seed from "./index";

// The Phase 18 contract commit: growth.ts is wired into the seed index and
// its switches reach platformSettingSeedRows. Lanes add their own growth
// tests in their own files (growth-<lane>.test.ts) so merges do not collide.

describe("growth seed contract", () => {
  it("is exported from the seed index", () => {
    expect(seed.signupSourceKeys).toBe(signupSourceKeys);
    expect(seed.growthPlatformSettingSeedRows).toBe(growthPlatformSettingSeedRows);
  });

  it("appends every growth switch to the platform settings, with no duplicate keys", () => {
    for (const row of growthPlatformSettingSeedRows) {
      expect(platformSettingSeedRows).toContainEqual(row);
    }
    const keys = platformSettingSeedRows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps every source key inside the signup source pattern", () => {
    for (const key of signupSourceKeys) {
      expect(isSignupSourceKey(key), key).toBe(true);
    }
    expect(new Set(signupSourceKeys).size).toBe(signupSourceKeys.length);
  });

  it("accepts the seeded families and refuses everything else", () => {
    for (const prefix of signupSourcePrefixes) {
      expect(isSignupSourceKey(`${prefix}google`)).toBe(true);
      expect(isSignupSourceKey(prefix)).toBe(false);
    }
    expect(isSignupSourceKey("pricing")).toBe(true);
    expect(isSignupSourceKey("unknown_page")).toBe(false);
    expect(isSignupSourceKey("Pricing")).toBe(false);
    expect(isSignupSourceKey(`lp_${"a".repeat(40)}`)).toBe(false);
    expect(isSignupSourceKey(null)).toBe(false);
  });
});
