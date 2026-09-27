import { describe, expect, it } from "vitest";
import {
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

  it("derives dimension bounds", () => {
    const bounds = dimensionBounds(getSpec("shopify.product"));
    expect(bounds.maxWidth).toBe(5000);
    expect(bounds.maxHeight).toBe(5000);
    const amazon = dimensionBounds(getSpec("amazon.main"));
    expect(amazon.minLongSide).toBe(1600);
    expect(amazon.maxLongSide).toBe(10000);
  });

  it("classifies marketplace versus social specs", () => {
    expect(isMarketplaceSpec("amazon.main")).toBe(true);
    expect(isMarketplaceSpec("walmart.main")).toBe(true);
    expect(isMarketplaceSpec("meta.feed_1x1")).toBe(false);
    expect(isMarketplaceSpec("pinterest.pin")).toBe(false);
  });
});
