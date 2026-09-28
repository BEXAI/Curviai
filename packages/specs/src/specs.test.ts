import { describe, expect, it } from "vitest";
import {
  Registry,
  channelFileLimit,
  dimensionBounds,
  filenameFor,
  getSpec,
  hasSpec,
  isMarketplaceSpec,
  listSpecs,
  loadRegistry,
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

  it("classifies marketplace versus social specs", () => {
    expect(isMarketplaceSpec("amazon.main")).toBe(true);
    expect(isMarketplaceSpec("walmart.main")).toBe(true);
    expect(isMarketplaceSpec("meta.feed_1x1")).toBe(false);
    expect(isMarketplaceSpec("pinterest.pin")).toBe(false);
  });
});
