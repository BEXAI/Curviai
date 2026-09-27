import { describe, expect, it } from "vitest";
import { listSpecs } from "@curvi/specs";
import { categories } from "./categories";
import { imageSpecs, specForSlug, specSlug } from "./spec-slug";

describe("specSlug", () => {
  it("slugifies dots and underscores", () => {
    expect(specSlug("amazon.main")).toBe("amazon-main");
    expect(specSlug("amazon.aplus.basic_header")).toBe("amazon-aplus-basic-header");
    expect(specSlug("meta.feed_1x1")).toBe("meta-feed-1x1");
  });

  it("produces a unique slug per spec", () => {
    const slugs = listSpecs().map((spec) => specSlug(spec.id));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("round trips every image spec through specForSlug", () => {
    for (const spec of imageSpecs()) {
      expect(specForSlug(specSlug(spec.id))?.id).toBe(spec.id);
    }
  });

  it("returns undefined for unknown slugs", () => {
    expect(specForSlug("not-a-channel")).toBeUndefined();
  });
});

describe("imageSpecs", () => {
  it("excludes video specs and keeps amazon.main", () => {
    const ids = imageSpecs().map((spec) => spec.id);
    expect(ids).toContain("amazon.main");
    expect(ids.some((id) => id.startsWith("video."))).toBe(false);
  });
});

describe("categories", () => {
  it("has the eight category pages with unique slugs", () => {
    expect(categories).toHaveLength(8);
    const slugs = categories.map((category) => category.slug);
    expect(new Set(slugs).size).toBe(8);
    for (const expected of ["apparel", "jewelry", "beauty", "food", "electronics", "home", "pet", "sports"]) {
      expect(slugs).toContain(expected);
    }
  });

  it("keeps copy free of emojis, arrows and dash punctuation", () => {
    const text = JSON.stringify(categories);
    expect(text).not.toMatch(/[←-⇿✀-➿–—→]/);
    expect(text).not.toMatch(/ - /);
  });
});
