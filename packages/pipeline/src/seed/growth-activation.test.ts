import { describe, expect, it } from "vitest";
import { platformSettingSeedRows } from "./credits";
import { opsSwitchDefaults } from "./operations";
import { activationSwitches, freePreview, isSellerCategoryKey, sellerCategories } from "./growth";
import * as seed from "./index";

// Lane 8 Activation's growth seed (docs/phases/PHASE_18.md P18-20 and
// P18-12): the "What do you sell?" answers.

const PLAIN_COPY = /^[A-Z][A-Za-z ]+$/;

describe("sellerCategories", () => {
  it("lists the plan's categories, the first target segment first, with unique short keys", () => {
    expect(sellerCategories.map((c) => c.key)).toEqual([
      "beauty",
      "supplements",
      "candles",
      "food",
      "coffee_tea",
      "pet",
      "home",
      "apparel",
      "jewelry",
      "electronics",
      "other",
    ]);
    for (const category of sellerCategories) {
      expect(category.key).toMatch(/^[a-z][a-z_]{1,39}$/);
      expect(category.label, category.key).toMatch(PLAIN_COPY);
    }
    expect(seed.sellerCategories).toBe(sellerCategories);
  });

  it("recognizes only its own keys, which fit the signup link pattern", () => {
    for (const category of sellerCategories) {
      expect(category.key).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/);
    }
    expect(isSellerCategoryKey("candles")).toBe(true);
    expect(isSellerCategoryKey("Candles")).toBe(false);
    expect(isSellerCategoryKey("sports")).toBe(false);
    expect(isSellerCategoryKey(null)).toBe(false);
  });
});

describe("freePreview (P18-12, founder decision 6)", () => {
  it("holds the decision's caps: 3 a connection and 300 a day, about $3 a day of spend", () => {
    expect(freePreview.perIpPerDay).toBe(3);
    expect(freePreview.sitePerDay).toBe(300);
    // About $0.011 a preview (the seeded $0.01 cutout plus intake) times the day's count.
    expect(freePreview.siteSpendPerDayMicros).toBe(freePreview.sitePerDay * 11_000);
    expect(freePreview.previewLongSide).toBe(1000);
    expect(freePreview.maxBytes).toBe(15 * 1024 * 1024);
    expect(freePreview.retentionDays).toBe(2);
    expect(freePreview.fullSizeLinkSeconds).toBeGreaterThan(0);
  });

  it("defaults the runtime switch on, so the env flag and its services are what keep it off", () => {
    // P20-20: an operator switch under its ops: key, never seeded, so no
    // later seed resets it; a missing row reads as the default.
    expect(activationSwitches).toEqual([]);
    expect(platformSettingSeedRows.filter((row) => row.key.endsWith("free_preview_enabled"))).toEqual([]);
    expect(opsSwitchDefaults["ops:free_preview_enabled"]).toMatchObject({ default: true, onReadError: false });
  });
});
