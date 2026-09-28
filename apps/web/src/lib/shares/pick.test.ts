import { describe, expect, it } from "vitest";
import { isShareSlug, newShareSlug, pickDisplayVariant, pickHeroAsset, shotLabel, SLUG_LENGTH } from "./pick";

describe("share slugs", () => {
  it("are random, well formed and distinct", () => {
    const slugs = new Set(Array.from({ length: 500 }, () => newShareSlug()));
    expect(slugs.size).toBe(500);
    for (const slug of slugs) {
      expect(slug).toHaveLength(SLUG_LENGTH);
      expect(isShareSlug(slug)).toBe(true);
    }
  });

  it("rejects anything a slug could not be before a lookup", () => {
    for (const bad of ["", "example", "ABCDEFGHJK", "abcdefghj0", "abc/../def", "abcdefghjkm", 42, null]) {
      expect(isShareSlug(bad)).toBe(false);
    }
  });
});

describe("pickHeroAsset", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 28, 12, n));

  it("prefers a lifestyle scene, then the main image, then creation order", () => {
    const assets = [
      { id: "a", shotType: "sweep_gray", createdAt: at(1) },
      { id: "b", shotType: "amazon_main", createdAt: at(2) },
      { id: "c", shotType: "lifestyle:2", createdAt: at(4) },
      { id: "d", shotType: "lifestyle:1", createdAt: at(3) },
    ];
    expect(pickHeroAsset(assets)?.id).toBe("d");
    expect(pickHeroAsset(assets.filter((a) => !a.shotType.startsWith("lifestyle")))?.id).toBe("b");
    expect(pickHeroAsset([{ id: "x", shotType: "infographic", createdAt: at(1) }])?.id).toBe("x");
    expect(pickHeroAsset([])).toBeNull();
  });
});

describe("pickDisplayVariant", () => {
  const at = new Date(0);

  it("prefers the most square file, then the largest", () => {
    const variants = [
      { id: "story", width: 1080, height: 1920, createdAt: at },
      { id: "small", width: 1000, height: 1000, createdAt: at },
      { id: "big", width: 2000, height: 2000, createdAt: at },
      { id: "unknown", width: null, height: null, createdAt: at },
    ];
    expect(pickDisplayVariant(variants)?.id).toBe("big");
    expect(pickDisplayVariant([variants[0], variants[3]])?.id).toBe("story");
    expect(pickDisplayVariant([])).toBeNull();
  });
});

describe("shotLabel", () => {
  it("reads like plain words", () => {
    expect(shotLabel("amazon_main")).toBe("Amazon main");
    expect(shotLabel("lifestyle:2")).toBe("Lifestyle");
  });
});
