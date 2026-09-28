import { describe, expect, it } from "vitest";
import { buildGeneratePackInput, seoSlugFor } from "./payload";

describe("seoSlugFor", () => {
  it("slugifies titles into lowercase hyphenated names", () => {
    expect(seoSlugFor("Juniper Glass Water Bottle")).toBe("juniper-glass-water-bottle");
    expect(seoSlugFor("  Mug!! 12oz (Blue) ")).toBe("mug-12oz-blue");
  });

  it("falls back to product for empty or null titles", () => {
    expect(seoSlugFor(null)).toBe("product");
    expect(seoSlugFor("!!!")).toBe("product");
  });

  it("stays under 60 characters without a trailing hyphen", () => {
    const slug = seoSlugFor("a".repeat(40) + " " + "b".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("buildGeneratePackInput", () => {
  const base = {
    jobId: "job1",
    workspaceId: "ws1",
    tier: "starter" as const,
    channels: ["amazon.main", "shopify.product"],
    mode: "listing" as const,
    creditBudget: 20,
    product: { id: "p1", title: "Ceramic mug", mode: "listing" as const, amazonSku: "MUG1" },
    media: [
      { r2Key: "m1", kind: "image" as const },
      { r2Key: "m2", kind: "video" as const },
      { r2Key: "m3", kind: null },
    ],
  };

  it("passes media keys through and derives sku, slug and video flag", () => {
    const input = buildGeneratePackInput(base);
    expect(input.jobId).toBe("job1");
    expect(input.mode).toBe("listing");
    expect(input.creditBudget).toBe(20);
    expect(input.sku).toBe("MUG1");
    expect(input.seoSlug).toBe("ceramic-mug");
    expect(input.hasVideoSource).toBe(true);
    // Videos become frames later; only stills feed the image list.
    expect(input.images).toEqual([{ mediaId: "m1" }, { mediaId: "m3" }]);
  });

  it("omits the sku when the product has none", () => {
    const input = buildGeneratePackInput({
      ...base,
      product: { ...base.product, amazonSku: null },
      media: [{ r2Key: "m1", kind: "image" }],
    });
    expect(input.sku).toBeUndefined();
    expect(input.hasVideoSource).toBe(false);
  });

  it("carries photo roles, front first, and the seller's lines and SKU", () => {
    const input = buildGeneratePackInput({
      ...base,
      product: {
        ...base.product,
        sku: "MUG-SELLER",
        boxContents: ["Mug", " ", "Lid"],
        comparisonFacts: ["Holds 12 oz, most hold 8 oz"],
      },
      media: [
        { r2Key: "m_back", kind: "image", angle: "back" },
        { r2Key: "m_front", kind: "image", angle: "front" },
        { r2Key: "m_odd", kind: "image", angle: "top" },
        { r2Key: "m_none", kind: "image" },
      ],
    });
    expect(input.images).toEqual([
      { mediaId: "m_front", angle: "front" },
      { mediaId: "m_back", angle: "back" },
      // A value that is not a role is dropped, never passed to the planner.
      { mediaId: "m_odd" },
      { mediaId: "m_none" },
    ]);
    // The seller's SKU wins over the Amazon one.
    expect(input.sku).toBe("MUG-SELLER");
    expect(input.boxContents).toEqual(["Mug", "Lid"]);
    expect(input.comparisonFacts).toEqual(["Holds 12 oz, most hold 8 oz"]);
  });

  it("sends empty lists when the product has no seller lines", () => {
    const input = buildGeneratePackInput(base);
    expect(input.boxContents).toEqual([]);
    expect(input.comparisonFacts).toEqual([]);
  });
});

describe("buildGeneratePackInput brand colors", () => {
  const base = {
    jobId: "job1",
    workspaceId: "ws1",
    tier: "starter" as const,
    channels: ["amazon.main"],
    mode: "listing" as const,
    creditBudget: 5,
    product: { id: "p1", title: "Mug", mode: "listing" as const, amazonSku: null },
    media: [{ r2Key: "m1", kind: "image" as const }],
  };

  it("passes only valid hex colors", () => {
    const input = buildGeneratePackInput({ ...base, brandColors: ["#1A2B3C", "red", "#abc", "#FFFFFF"] });
    expect(input.brandColors).toEqual(["#1A2B3C", "#FFFFFF"]);
  });

  it("sends an empty list without a brand kit", () => {
    expect(buildGeneratePackInput({ ...base, brandColors: null }).brandColors).toEqual([]);
  });
});
