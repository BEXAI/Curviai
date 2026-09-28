import { describe, expect, it } from "vitest";
import {
  Registry,
  channelFileLimit,
  dimensionBounds,
  filenameFor,
  getSpec,
  hasSpec,
  isMarketplaceChannel,
  isMarketplaceSpec,
  isSpecSelected,
  listSpecs,
  loadRegistry,
  selectedSpecIds,
} from "./index.js";

describe("channel spec registry", () => {
  it("parses and validates the bundled registry", () => {
    const registry = loadRegistry();
    expect(registry.version).toBe(1);
    expect(registry.specs.length).toBe(18);
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
    expect(selectedSpecIds(["meta"])).toEqual(["meta.feed_1x1", "meta.feed_4x5", "meta.story_9x16"]);
    expect(selectedSpecIds(["amazon.aplus"])).toEqual(["amazon.aplus.basic_header", "amazon.aplus.premium_full"]);
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
