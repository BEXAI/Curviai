import { describe, expect, it } from "vitest";
import { normalizeOutputOptions, resolveOutputOptions } from "@curvi/pipeline/output-options";
import { brandStyleFor, buildGeneratePackInput, payloadOutputOf, seoSlugFor } from "./payload";

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

describe("buildGeneratePackInput social badge", () => {
  const base = {
    jobId: "job1",
    workspaceId: "ws1",
    channels: ["meta.feed_1x1"],
    mode: "listing" as const,
    creditBudget: 5,
    product: { id: "p1", title: "Mug", mode: "listing" as const, amazonSku: null },
    media: [{ r2Key: "m1", kind: "image" as const }],
  };

  it("asks for the Made with Curvi badge on free packs only", () => {
    expect(buildGeneratePackInput({ ...base, tier: "free" }).socialBadge).toBe(true);
    expect(buildGeneratePackInput({ ...base, tier: "starter" }).socialBadge).toBe(false);
    expect(buildGeneratePackInput({ ...base, tier: "agency" }).socialBadge).toBe(false);
  });
});

describe("buildGeneratePackInput output options (PHASE_15 item 27)", () => {
  const base = {
    jobId: "job1",
    workspaceId: "ws1",
    tier: "starter" as const,
    channels: ["amazon.main", "shopify.product"],
    mode: "listing" as const,
    creditBudget: 4,
    product: { id: "p1", title: "Mug", mode: "listing" as const, amazonSku: null },
    media: [
      { r2Key: "ws/ws1/src/back.jpg", kind: "image" as const, angle: "back", width: 3000, height: 2000, reencoded: false },
      { r2Key: "ws/ws1/src/front.jpg", kind: "image" as const, angle: "front", width: 4032, height: 3024, reencoded: true },
      { r2Key: "ws/ws1/src/old.jpg", kind: "image" as const, width: null, height: 500, reencoded: null },
    ],
  };
  const stored = resolveOutputOptions(normalizeOutputOptions({ background: "keep" }), {
    colorHex: "#FFFFFF",
    brandSweepHex: "#3A4556",
    keepMediaIds: ["ws/ws1/src/front.jpg", "ws/ws1/src/back.jpg"],
  });

  it("passes each photo's size and re-encode flag through, and leaves out what is unknown", () => {
    const input = buildGeneratePackInput(base);
    expect(input.images).toEqual([
      { mediaId: "ws/ws1/src/front.jpg", angle: "front", width: 4032, height: 3024, reencoded: true },
      { mediaId: "ws/ws1/src/back.jpg", angle: "back", width: 3000, height: 2000, reencoded: false },
      { mediaId: "ws/ws1/src/old.jpg" },
    ]);
  });

  it("parses the stored options again and attaches them as output", () => {
    const input = buildGeneratePackInput({ ...base, outputOptions: JSON.parse(JSON.stringify(stored)) });
    expect(input.output).toEqual(stored);
    expect(payloadOutputOf(null)).toBeUndefined();
    expect(buildGeneratePackInput(base).output).toBeUndefined();
  });

  it("passes the preflight's product box for the crop fit, and drops one outside the photo", () => {
    const box = { x: 0.2, y: 0.1, width: 0.5, height: 0.6 };
    const input = buildGeneratePackInput({
      ...base,
      media: [
        { ...base.media[1], productBox: box },
        { ...base.media[0], productBox: { x: 0.8, y: 0, width: 0.5, height: 0.5 } },
      ],
    });
    expect(input.images[0].productBox).toEqual(box);
    expect(input.images[1].productBox).toBeUndefined();
  });

  it("throws on stored options the schema refuses", () => {
    expect(() => buildGeneratePackInput({ ...base, outputOptions: { ...stored, v: 2 } })).toThrow();
    expect(() => buildGeneratePackInput({ ...base, outputOptions: { ...stored, colorHex: "red" } })).toThrow();
    expect(() => buildGeneratePackInput({ ...base, outputOptions: { ...stored, extra: true } })).toThrow();
    expect(() => payloadOutputOf("keep")).toThrow();
  });
});
