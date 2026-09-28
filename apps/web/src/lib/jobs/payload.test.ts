import { describe, expect, it } from "vitest";
import { brandStyleFor, buildGeneratePackInput, seoSlugFor } from "./payload";

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

describe("buildGeneratePackInput brand style", () => {
  const WS = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
  const base = {
    jobId: "job1",
    workspaceId: WS,
    tier: "starter" as const,
    channels: ["amazon.main"],
    mode: "listing" as const,
    creditBudget: 5,
    product: { id: "p1", title: "Mug", mode: "listing" as const, amazonSku: null },
    media: [{ r2Key: "m1", kind: "image" as const }],
  };

  it("passes catalog fonts, an own workspace logo key and a seeded preset", () => {
    const input = buildGeneratePackInput({
      ...base,
      brandKit: {
        fonts: { heading: "playfair_display", body: "lora" },
        logoKey: `ws/${WS}/src/logo.png`,
        stylePreset: "luxury_marble",
      },
    });
    expect(input.brand).toEqual({
      fonts: { heading: "playfair_display", body: "lora" },
      logoKey: `ws/${WS}/src/logo.png`,
      stylePreset: "luxury_marble",
    });
  });

  it("drops unknown fonts, foreign logo keys and the automatic preset", () => {
    const style = brandStyleFor(WS, {
      fonts: { heading: "Comic Sans", body: "" },
      logoKey: "ws/00000000-0000-4000-8000-000000000000/src/logo.png",
      stylePreset: "auto",
    });
    expect(style).toBeNull();
    expect(brandStyleFor(WS, { fonts: null, logoKey: `ws/${WS}/src/../x.png`, stylePreset: null })).toBeNull();
    expect(buildGeneratePackInput({ ...base, brandKit: null }).brand).toBeUndefined();
  });

  it("keeps the parts that are valid", () => {
    expect(brandStyleFor(WS, { fonts: { heading: "", body: "montserrat" }, logoKey: null, stylePreset: "auto" })).toEqual({
      fonts: { heading: null, body: "montserrat" },
    });
  });
});
