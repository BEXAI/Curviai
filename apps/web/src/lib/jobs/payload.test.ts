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
      { id: "m1", kind: "image" as const },
      { id: "m2", kind: "video" as const },
      { id: "m3", kind: null },
    ],
  };

  it("passes ids through and derives sku, slug and video flag", () => {
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
      media: [{ id: "m1", kind: "image" }],
    });
    expect(input.sku).toBeUndefined();
    expect(input.hasVideoSource).toBe(false);
  });
});
