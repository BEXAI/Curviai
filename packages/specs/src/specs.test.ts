import { describe, expect, it } from "vitest";
import {
  Registry,
  allowsAddedBorders,
  channelFileLimit,
  dimensionBounds,
  filenameFor,
  getSpec,
  hasSpec,
  isMarketplaceChannel,
  isMarketplaceSpec,
  isExactSize,
  isSpecSelected,
  adTextLimit,
  listSpecs,
  loadRegistry,
  refusesOverlays,
  requiresWhiteBackground,
  safeArea,
  selectedSpecIds,
} from "./index.js";

describe("channel spec registry", () => {
  it("parses and validates the bundled registry", () => {
    const registry = loadRegistry();
    expect(registry.version).toBe(2);
    expect(registry.specs.length).toBe(24);
  });

  it("contains the launch critical specs", () => {
    for (const id of [
      "amazon.main",
      "amazon.secondary",
      "shopify.product",
      "google.merchant.main",
      "meta.feed_1x1",
      "meta.story_9x16",
      "video.social_9x16",
    ]) {
      expect(hasSpec(id)).toBe(true);
    }
  });

  it("enforces amazon.main hard rules", () => {
    const main = getSpec("amazon.main");
    expect(main.background?.type).toBe("solid");
    expect(main.background?.rgb).toEqual([255, 255, 255]);
    expect(main.background?.tolerance).toBe(0);
    expect(main.fill?.min).toBe(0.85);
    expect(main.textAllowed).toBe(false);
    expect(main.propsAllowed).toBe(false);
    expect(main.minLongSide).toBe(1600);
  });

  it("never allows badges on marketplace bound specs", () => {
    for (const spec of listSpecs()) {
      if (isMarketplaceSpec(spec.id)) {
        expect(spec.badgeAllowed ?? false).toBe(false);
      }
    }
  });

  it("requires IPTC DigitalSourceType on google merchant specs", () => {
    expect(getSpec("google.merchant.main").iptcDigitalSourceTypeRequiredIfAI).toBe(true);
    expect(getSpec("google.merchant.lifestyle").iptcDigitalSourceTypeRequiredIfAI).toBe(true);
  });

  it("renders amazon filename conventions", () => {
    expect(filenameFor(getSpec("amazon.main"), { sku: "ABC123" })).toBe("ABC123.MAIN.jpg");
    expect(filenameFor(getSpec("amazon.secondary"), { sku: "ABC123", n: 1 })).toBe("ABC123.PT01.jpg");
    expect(filenameFor(getSpec("amazon.secondary"), { sku: "ABC123", n: 8 })).toBe("ABC123.PT08.jpg");
  });

  it("renders shopify seo filenames", () => {
    expect(filenameFor(getSpec("shopify.product"), { seoSlug: "walnut-desk-organizer", n: 2 })).toBe(
      "walnut-desk-organizer-2.jpg",
    );
  });

  it("throws on unknown specs and missing naming vars", () => {
    expect(() => getSpec("nope.main")).toThrow("Unknown channel spec");
    expect(() => filenameFor(getSpec("amazon.main"), {})).toThrow("requires sku");
  });

  it("sanitizes naming vars against path traversal and zip slip", () => {
    expect(filenameFor(getSpec("amazon.main"), { sku: "../../evil" })).toBe("evil.MAIN.jpg");
    expect(filenameFor(getSpec("amazon.main"), { sku: "AB C/12\\3" })).toBe("ABC123.MAIN.jpg");
    expect(() => filenameFor(getSpec("amazon.main"), { sku: "../.." })).toThrow("empty after sanitization");
    expect(filenameFor(getSpec("shopify.product"), { seoSlug: "walnut-desk", n: 1 })).toBe("walnut-desk-1.jpg");
  });

  it("derives dimension bounds", () => {
    const bounds = dimensionBounds(getSpec("shopify.product"));
    expect(bounds.maxWidth).toBe(5000);
    expect(bounds.maxHeight).toBe(5000);
    const amazon = dimensionBounds(getSpec("amazon.main"));
    expect(amazon.minLongSide).toBe(1600);
    expect(amazon.maxLongSide).toBe(10000);
  });

  it("requires the exact size on social and banner specs (Update.md 2.8)", () => {
    const feed = dimensionBounds(getSpec("meta.feed_4x5"));
    expect(feed).toMatchObject({ minWidth: 1080, maxWidth: 1080, minHeight: 1350, maxHeight: 1350 });
    // A square file is not a 4x5 feed asset.
    const fits = (b: ReturnType<typeof dimensionBounds>, w: number, h: number): boolean =>
      w >= b.minWidth && w <= b.maxWidth && h >= b.minHeight && h <= b.maxHeight;
    expect(fits(feed, 1080, 1080)).toBe(false);
    expect(fits(feed, 1080, 1350)).toBe(true);
    for (const id of [
      "meta.feed_1x1",
      "meta.feed_4x5",
      "meta.story_9x16",
      "pinterest.pin",
      "amazon.aplus.basic_header",
      "amazon.aplus.premium_full",
      "amazon.aplus.wide_banner",
      "amazon.aplus.single_image",
      "amazon.aplus.four_images",
      "amazon.aplus.quadrant_image",
      "shopify.hero_banner",
    ]) {
      expect(getSpec(id).exactSize).toBe(true);
    }
  });

  it("keeps ranges where the width is only the size we render at", () => {
    // amazon.main renders at 2000 but accepts a 1600 long side.
    const main = getSpec("amazon.main");
    expect(main.exactSize ?? false).toBe(false);
    const bounds = dimensionBounds(main);
    expect(bounds.minWidth).toBe(1);
    expect(bounds.maxWidth).toBe(2000);
    expect(bounds.minLongSide).toBe(1600);
    expect(getSpec("amazon.secondary").exactSize ?? false).toBe(false);
    expect(getSpec("shopify.product").exactSize ?? false).toBe(false);
  });

  it("keeps every spec's own render size inside its bounds", () => {
    for (const spec of listSpecs()) {
      if (spec.width === undefined || spec.height === undefined) {
        continue;
      }
      const b = dimensionBounds(spec);
      const long = Math.max(spec.width, spec.height);
      expect(spec.width, spec.id).toBeGreaterThanOrEqual(b.minWidth);
      expect(spec.width, spec.id).toBeLessThanOrEqual(b.maxWidth);
      expect(spec.height, spec.id).toBeGreaterThanOrEqual(b.minHeight);
      expect(spec.height, spec.id).toBeLessThanOrEqual(b.maxHeight);
      expect(long, spec.id).toBeGreaterThanOrEqual(b.minLongSide);
      expect(long, spec.id).toBeLessThanOrEqual(b.maxLongSide);
    }
  });

  it("rejects an exactSize spec without both dimensions", () => {
    const parsed = Registry.safeParse({
      version: 1,
      specs: [{ id: "bad.spec", verified: false, width: 1000, exactSize: true }],
    });
    expect(parsed.success).toBe(false);
  });

  it("limits files per product from maxCount or a naming template without a slot", () => {
    expect(channelFileLimit(getSpec("amazon.secondary"))).toBe(8);
    // {sku}.MAIN.jpg can name only one file.
    expect(channelFileLimit(getSpec("amazon.main"))).toBe(1);
    // {seoSlug}-{n}.jpg numbers its files and declares no maxCount.
    expect(channelFileLimit(getSpec("shopify.product"))).toBeNull();
    // No naming template: the packager numbers generic names.
    expect(channelFileLimit(getSpec("amazon.aplus.basic_header"))).toBeNull();
  });

  it("carries the listing photo limits checked on 2026-09-28", () => {
    // Etsy Help: up to 20 photos. eBay Help: up to 24 pictures. TikTok Shop
    // US listing policy: up to 9 square images.
    expect(channelFileLimit(getSpec("etsy.listing"))).toBe(20);
    expect(channelFileLimit(getSpec("ebay.listing"))).toBe(24);
    expect(channelFileLimit(getSpec("tiktokshop.main"))).toBe(9);
    // Walmart's limit is not verified yet, so none is enforced.
    expect(channelFileLimit(getSpec("walmart.main"))).toBeNull();
    // Each spec with a checked count says where it came from.
    for (const id of ["etsy.listing", "ebay.listing", "tiktokshop.main"]) {
      expect(getSpec(id).source, id).toMatch(/checked 2026-09-28/);
    }
  });

  it("keeps the rules the planner reads for the newer marketplaces", () => {
    // White only listings: the planner sends them white images and nothing else.
    expect(getSpec("walmart.main").background).toEqual({ type: "solid", rgb: [255, 255, 255] });
    expect(getSpec("tiktokshop.main").background?.type).toBe("white_preferred");
    // No added text on eBay, Walmart or TikTok Shop images.
    for (const id of ["ebay.listing", "walmart.main", "tiktokshop.main"]) {
      expect(getSpec(id).textAllowed, id).toBe(false);
    }
    expect(getSpec("etsy.listing").textAllowed).toBe(true);
    // The Pinterest pin is an exact 2:3 crop.
    expect(dimensionBounds(getSpec("pinterest.pin"))).toMatchObject({
      minWidth: 1000,
      maxWidth: 1000,
      minHeight: 1500,
      maxHeight: 1500,
    });
  });

  it("classifies marketplace versus social specs", () => {
    expect(isMarketplaceSpec("amazon.main")).toBe(true);
    expect(isMarketplaceSpec("walmart.main")).toBe(true);
    expect(isMarketplaceSpec("meta.feed_1x1")).toBe(false);
    expect(isMarketplaceSpec("pinterest.pin")).toBe(false);
  });
});

describe("isSpecSelected, the one channel selection rule (Update.md 2.11)", () => {
  it("selects a spec id only by itself", () => {
    const picked = ["amazon.main", "meta.feed_1x1"];
    expect(isSpecSelected(picked, "amazon.main")).toBe(true);
    expect(isSpecSelected(picked, "meta.feed_1x1")).toBe(true);
    expect(isSpecSelected(picked, "amazon.secondary")).toBe(false);
    expect(isSpecSelected(picked, "amazon.aplus.basic_header")).toBe(false);
    expect(isSpecSelected(picked, "meta.feed_4x5")).toBe(false);
  });

  it("selects every spec under a bare family or a group prefix", () => {
    expect(selectedSpecIds(["meta"])).toEqual(["meta.feed_1x1", "meta.feed_4x5", "meta.story_9x16", "meta.reels_9x16"]);
    expect(selectedSpecIds(["amazon.aplus"])).toEqual([
      "amazon.aplus.basic_header",
      "amazon.aplus.premium_full",
      "amazon.aplus.wide_banner",
      "amazon.aplus.single_image",
      "amazon.aplus.four_images",
      "amazon.aplus.quadrant_image",
    ]);
    // A partial name is not a prefix of whole segments, so it selects nothing.
    expect(isSpecSelected(["amazon.ma"], "amazon.main")).toBe(false);
    expect(isSpecSelected(["amaz"], "amazon.main")).toBe(false);
  });

  it("never selects a spec the registry does not know", () => {
    expect(isSpecSelected(["myspace"], "myspace.main")).toBe(false);
    expect(isSpecSelected(["myspace.main"], "myspace.main")).toBe(false);
    expect(selectedSpecIds([])).toEqual([]);
  });

  it("lists the picked specs in registry order", () => {
    const order = listSpecs().map((spec) => spec.id);
    const picked = selectedSpecIds(["pinterest.pin", "etsy", "amazon.main"]);
    expect(picked).toEqual(["amazon.main", "etsy.listing", "pinterest.pin"]);
    expect([...picked].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(picked);
  });

  it("classifies selected channel strings as marketplace bound", () => {
    expect(isMarketplaceChannel("amazon")).toBe(true);
    expect(isMarketplaceChannel("amazon.main")).toBe(true);
    expect(isMarketplaceChannel("amazon.aplus")).toBe(true);
    expect(isMarketplaceChannel("walmart")).toBe(true);
    expect(isMarketplaceChannel("meta")).toBe(false);
    expect(isMarketplaceChannel("meta.feed_1x1")).toBe(false);
    expect(isMarketplaceChannel("pinterest.pin")).toBe(false);
    expect(isMarketplaceChannel("myspace")).toBe(false);
  });
});

describe("A+ module sizes (PHASE_16 workstream 2, docs/verification.md 2026-09-29)", () => {
  it("carries the standard A+ image slots at their exact sizes, JPG or PNG up to 2 MB", () => {
    const sizes = Object.fromEntries(
      listSpecs()
        .filter((spec) => spec.id.startsWith("amazon.aplus."))
        .map((spec) => [spec.id, `${spec.width}x${spec.height}`]),
    );
    expect(sizes).toEqual({
      "amazon.aplus.basic_header": "970x600",
      "amazon.aplus.premium_full": "1464x600",
      "amazon.aplus.wide_banner": "970x300",
      "amazon.aplus.single_image": "300x300",
      "amazon.aplus.four_images": "220x220",
      "amazon.aplus.quadrant_image": "135x135",
    });
    for (const spec of listSpecs().filter((s) => s.id.startsWith("amazon.aplus."))) {
      expect(spec.exactSize).toBe(true);
      expect(spec.maxBytes).toBe(2000000);
      expect(spec.formats).toEqual(["jpg", "png"]);
      expect(spec.textAllowed).toBe(true);
      expect(isMarketplaceSpec(spec.id)).toBe(true);
    }
  });
});

describe("background and layout helpers", () => {
  it("requires white on exactly the four white rule specs", () => {
    const white = listSpecs()
      .filter(requiresWhiteBackground)
      .map((spec) => spec.id);
    expect(white).toEqual(["amazon.main", "google.merchant.main", "walmart.main", "tiktokshop.main"]);
  });

  it("reads white from the background rule, not the spec id", () => {
    const base = { id: "test.spec", verified: false };
    expect(requiresWhiteBackground({ ...base, background: { type: "solid", rgb: [255, 255, 255] } })).toBe(true);
    expect(requiresWhiteBackground({ ...base, background: { type: "solid", rgb: [250, 250, 250] } })).toBe(false);
    expect(requiresWhiteBackground({ ...base, background: { type: "solid" } })).toBe(false);
    expect(requiresWhiteBackground({ ...base, background: { type: "white_or_transparent" } })).toBe(true);
    expect(requiresWhiteBackground({ ...base, background: { type: "white_preferred" } })).toBe(true);
    expect(requiresWhiteBackground({ ...base, background: { type: "any" } })).toBe(false);
    expect(requiresWhiteBackground({ ...base, background: { type: "consistent" } })).toBe(false);
    expect(requiresWhiteBackground(base)).toBe(false);
  });

  it("matches isExactSize to the registry's exactSize specs", () => {
    const exact = listSpecs()
      .filter(isExactSize)
      .map((spec) => spec.id);
    expect(exact).toEqual(listSpecs().filter((spec) => spec.exactSize === true).map((spec) => spec.id));
    expect(exact).toEqual([
      "amazon.aplus.basic_header",
      "amazon.aplus.premium_full",
      "amazon.aplus.wide_banner",
      "amazon.aplus.single_image",
      "amazon.aplus.four_images",
      "amazon.aplus.quadrant_image",
      "shopify.hero_banner",
      "meta.feed_1x1",
      "meta.feed_4x5",
      "meta.story_9x16",
      "meta.reels_9x16",
      "pinterest.pin",
      "tiktok.ad_9x16",
    ]);
  });

  it("parses the added border and overlay flags", () => {
    expect(getSpec("ebay.listing").bordersAllowed).toBe(false);
    expect(getSpec("tiktokshop.main").bordersAllowed).toBe(false);
    expect(getSpec("ebay.listing").overlaysAllowed).toBe(false);
    expect(getSpec("google.merchant.lifestyle").overlaysAllowed).toBe(false);
    expect(getSpec("google.merchant.main").bordersAllowed).toBe(false);
    expect(getSpec("google.merchant.lifestyle").bordersAllowed).toBe(false);
    expect(
      listSpecs()
        .filter((spec) => !allowsAddedBorders(spec))
        .map((spec) => spec.id),
    ).toEqual(["google.merchant.main", "google.merchant.lifestyle", "ebay.listing", "tiktokshop.main"]);
    expect(() => Registry.parse({ version: 1, specs: [{ id: "x.y", verified: false, bordersAllowed: "no" }] })).toThrow();
  });

  it("carries the published Google Merchant image limits on both google specs", () => {
    for (const id of ["google.merchant.main", "google.merchant.lifestyle"]) {
      const spec = getSpec(id);
      expect(spec.maxMegapixels, id).toBe(64);
      expect(spec.maxBytes, id).toBe(16000000);
      expect(spec.maxWidth, id).toBeUndefined();
      expect(spec.maxHeight, id).toBeUndefined();
    }
  });

  it("refuses overlays where text or overlays are not allowed", () => {
    for (const id of ["amazon.main", "google.merchant.main", "google.merchant.lifestyle", "ebay.listing", "walmart.main", "tiktokshop.main"]) {
      expect(refusesOverlays(getSpec(id)), id).toBe(true);
    }
    for (const id of ["amazon.secondary", "shopify.product", "etsy.listing", "meta.feed_1x1", "pinterest.pin"]) {
      expect(refusesOverlays(getSpec(id)), id).toBe(false);
    }
  });
});

describe("ad placements (PHASE_16 workstream 3, docs/verification.md 2026-09-29)", () => {
  it("adds tiktok.ad_9x16 at 1080 by 1920 with the stricter union safe zone and 100 characters of ad text", () => {
    const spec = getSpec("tiktok.ad_9x16");
    expect(spec).toMatchObject({ width: 1080, height: 1920, exactSize: true, formats: ["jpg", "png"], textAllowed: true });
    expect(spec.safeZone).toEqual({ top: 269, bottom: 484, left: 65, right: 140 });
    expect(spec.textLimits).toEqual({ adText: 100 });
    expect(adTextLimit(spec)).toBe(100);
    expect(isMarketplaceSpec(spec.id)).toBe(false);
    expect(isMarketplaceChannel("tiktok")).toBe(false);
    // tiktok does not select TikTok Shop, and TikTok Shop does not select the ad.
    expect(selectedSpecIds(["tiktok"])).toEqual(["tiktok.ad_9x16"]);
    expect(isSpecSelected(["tiktokshop"], "tiktok.ad_9x16")).toBe(false);
  });

  it("adds meta.reels_9x16 and widens the story safe zone to Meta's 14, 35 and 6 percent", () => {
    for (const id of ["meta.reels_9x16", "meta.story_9x16"]) {
      const spec = getSpec(id);
      expect(spec.safeZone, id).toEqual({ top: 269, bottom: 672, left: 65, right: 65 });
      // 14, 35 and 6 percent of 1080 by 1920, rounded up.
      expect(spec.safeZone!.top).toBe(Math.ceil(1920 * 0.14));
      expect(spec.safeZone!.bottom).toBe(Math.ceil(1920 * 0.35));
      expect(spec.safeZone!.left).toBe(Math.ceil(1080 * 0.06));
    }
    expect(adTextLimit(getSpec("meta.reels_9x16"))).toBe(44);
    expect(adTextLimit(getSpec("meta.story_9x16"))).toBe(40);
    expect(adTextLimit(getSpec("meta.feed_4x5"))).toBe(27);
    expect(adTextLimit(getSpec("pinterest.pin"))).toBe(100);
    expect(adTextLimit(getSpec("amazon.main"))).toBeNull();
  });

  it("computes the safe area inside every edge", () => {
    expect(safeArea(getSpec("tiktok.ad_9x16"), { width: 1080, height: 1920 })).toEqual({
      left: 65,
      top: 269,
      width: 1080 - 65 - 140,
      height: 1920 - 269 - 484,
    });
    expect(safeArea(getSpec("meta.feed_4x5"), { width: 1080, height: 1350 })).toEqual({
      left: 0,
      top: 0,
      width: 1080,
      height: 1350,
    });
  });

  it("refuses an unknown text limit field", () => {
    expect(() =>
      Registry.parse({ version: 1, specs: [{ id: "x.y", verified: false, textLimits: { caption: 10 } }] }),
    ).toThrow();
  });
});
