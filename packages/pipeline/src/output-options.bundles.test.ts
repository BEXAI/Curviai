/**
 * Pack bundles in the options schema (docs/phases/PHASE_16.md workstream 1):
 * the seed's shape, the strict schema, normalization, the idempotency key,
 * looks and the resolved and plan flag carriers.
 */
import { describe, expect, it } from "vitest";
import {
  BUNDLE_KEYS,
  DEFAULT_BUNDLE,
  DEFAULT_OUTPUT_OPTIONS,
  EXTRA_FAMILIES,
  EXTRA_FAMILY_KEYS,
  LOOK_KEYS,
  LOOK_PRESETS,
  OutputOptionsInput,
  ResolvedOutputOptions,
  bundleExtrasFor,
  bundleHoldsFamily,
  bundleMaxSecondary,
  bundleOf,
  bundleShotTypes,
  isSecondaryShot,
  lookOf,
  lookPresetFor,
  normalizeOutputOptions,
  outputOptionsKey,
  planFlagsOf,
  resolveOutputOptions,
} from "./output-options";
import { Shot } from "./schemas";
import { packBundles } from "./seed/templates";

const SNAPSHOT = { colorHex: "#FFFFFF", brandSweepHex: "#FFFFFF", keepMediaIds: [] };
const ALL_OFF = { scenes: false, backdrops: false, transparentPng: false, graphics: false, cards: false };

describe("packBundles seed", () => {
  it("seeds the four bundles in card order, keyed by their own key", () => {
    expect(BUNDLE_KEYS).toEqual(["main", "listing", "aplus", "everything"]);
    for (const key of BUNDLE_KEYS) {
      expect(packBundles[key].key).toBe(key);
    }
  });

  it("gives every bundle a plain label (rule 9)", () => {
    for (const key of BUNDLE_KEYS) {
      const label = packBundles[key].label;
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/[–—←-⇿]| - |\p{Extended_Pictographic}/u);
    }
  });

  it("makes today's pack the default, holding every shot type the schema has", () => {
    expect(DEFAULT_BUNDLE).toBe("everything");
    expect([...bundleShotTypes("everything")].sort()).toEqual([...Shot.shape.type.options].sort());
    expect(bundleMaxSecondary("everything")).toBeNull();
    expect(packBundles.everything.extras).toEqual({
      scenes: true,
      backdrops: true,
      transparentPng: true,
      graphics: true,
      cards: true,
    });
  });

  it("holds the Amazon main image and the white front image in every bundle", () => {
    for (const key of BUNDLE_KEYS) {
      const types = bundleShotTypes(key);
      expect(types.has("amazon_main"), key).toBe(true);
      expect(types.has("alt_angle_white"), key).toBe(true);
      expect(types.has("original_photo"), key).toBe(true);
    }
  });

  it("only seeds an extra on when the bundle holds a shot type of that family", () => {
    for (const key of BUNDLE_KEYS) {
      for (const family of EXTRA_FAMILY_KEYS) {
        if (packBundles[key].extras[family]) {
          expect(bundleHoldsFamily(key, family), `${key} ${family}`).toBe(true);
        }
      }
    }
  });

  it("names only real shot types", () => {
    const known = new Set<string>(Shot.shape.type.options);
    for (const key of BUNDLE_KEYS) {
      for (const type of bundleShotTypes(key)) {
        expect(known.has(type), `${key} ${type}`).toBe(true);
      }
    }
  });

  it("keeps the main and A+ sets to the front image, and the A+ set to its modules", () => {
    expect(bundleMaxSecondary("main")).toBe(0);
    expect(bundleMaxSecondary("aplus")).toBe(0);
    expect(bundleShotTypes("aplus").has("aplus_banner")).toBe(true);
    expect(bundleShotTypes("aplus").has("social_1x1")).toBe(false);
    expect(bundleShotTypes("listing").has("lifestyle")).toBe(true);
    expect(bundleShotTypes("listing").has("social_1x1")).toBe(false);
    expect(bundleShotTypes("listing").has("aplus_banner")).toBe(false);
  });
});

describe("bundle in the options schema", () => {
  it("accepts every seeded key and refuses anything else", () => {
    for (const key of BUNDLE_KEYS) {
      expect(OutputOptionsInput.safeParse({ bundle: key }).success, key).toBe(true);
    }
    expect(OutputOptionsInput.safeParse({ bundle: "all" }).success).toBe(false);
    expect(OutputOptionsInput.safeParse({ bundle: null }).success).toBe(false);
    expect(OutputOptionsInput.safeParse({ bundle: 1 }).success).toBe(false);
    expect(OutputOptionsInput.safeParse({ bundles: "main" }).success).toBe(false);
  });

  it("leaves the default out of the normalized options, so today's pack reads as before", () => {
    expect(normalizeOutputOptions({ bundle: "everything" })).toEqual(normalizeOutputOptions({}));
    expect("bundle" in DEFAULT_OUTPUT_OPTIONS).toBe(false);
    expect(bundleOf(DEFAULT_OUTPUT_OPTIONS)).toBe("everything");
    expect(normalizeOutputOptions({ bundle: "listing" }).bundle).toBe("listing");
  });

  it("starts the extras from the bundle with Remove and all off with Keep", () => {
    expect(normalizeOutputOptions({ bundle: "listing" }).extras).toEqual({
      scenes: true,
      backdrops: true,
      transparentPng: true,
      graphics: true,
      cards: false,
    });
    expect(normalizeOutputOptions({ bundle: "main" }).extras).toEqual(ALL_OFF);
    expect(normalizeOutputOptions({ bundle: "aplus" }).extras).toEqual({ ...ALL_OFF, cards: true });
    expect(normalizeOutputOptions({ bundle: "listing", background: "keep" }).extras).toEqual(ALL_OFF);
  });

  it("keeps a switch the seller changed inside the bundle and turns off a family outside it", () => {
    expect(normalizeOutputOptions({ bundle: "listing", extras: { scenes: false } }).extras.scenes).toBe(false);
    expect(normalizeOutputOptions({ bundle: "listing", extras: { cards: true } }).extras.cards).toBe(false);
    expect(normalizeOutputOptions({ bundle: "main", extras: { scenes: true } }).extras).toEqual(ALL_OFF);
    expect(
      normalizeOutputOptions({ bundle: "listing", background: "keep", extras: { graphics: true } }).extras.graphics,
    ).toBe(true);
  });

  it("bundleExtrasFor is each look's own extras for today's pack", () => {
    for (const look of LOOK_KEYS) {
      expect(bundleExtrasFor("everything", LOOK_PRESETS[look].background)).toEqual(LOOK_PRESETS[look].extras);
    }
  });
});

describe("outputOptionsKey with bundles", () => {
  it("is the same for absent options, an absent bundle and the explicit default", () => {
    const today = outputOptionsKey(null);
    expect(outputOptionsKey({})).toBe(today);
    expect(outputOptionsKey({ bundle: "everything" })).toBe(today);
    expect(outputOptionsKey(DEFAULT_OUTPUT_OPTIONS)).toBe(today);
    expect(today).not.toContain("bundle");
  });

  it("changes with the bundle and ignores extras the bundle already implies", () => {
    const listing = outputOptionsKey({ bundle: "listing" });
    expect(listing).not.toBe(outputOptionsKey(null));
    expect(outputOptionsKey({ bundle: "listing", extras: { cards: false } })).toBe(listing);
    expect(outputOptionsKey({ bundle: "listing", extras: { cards: true } })).toBe(listing);
    expect(outputOptionsKey({ bundle: "main" })).not.toBe(listing);
  });

  it("reads the bundle back from a stored resolved row", () => {
    const stored = resolveOutputOptions(normalizeOutputOptions({ bundle: "aplus" }), SNAPSHOT);
    expect(outputOptionsKey(stored)).toBe(outputOptionsKey({ bundle: "aplus" }));
  });
});

describe("looks with bundles", () => {
  it("reads a look card with a bundle as that look, not custom", () => {
    for (const key of BUNDLE_KEYS) {
      for (const look of LOOK_KEYS) {
        expect(lookOf(lookPresetFor(look, key)), `${look} ${key}`).toBe(look);
        expect(lookOf(normalizeOutputOptions({ bundle: key, background: LOOK_PRESETS[look].background })), key).toBe(
          look === "brand" ? "marketplace" : look,
        );
      }
    }
  });

  it("is the Phase 15 preset exactly for today's pack", () => {
    for (const look of LOOK_KEYS) {
      expect(lookPresetFor(look)).toEqual(LOOK_PRESETS[look]);
    }
  });

  it("reads a switch changed away from the bundle's start as custom", () => {
    expect(lookOf(normalizeOutputOptions({ bundle: "listing", extras: { scenes: false } }))).toBe("custom");
  });
});

describe("resolved options and plan flags carry the bundle", () => {
  it("stores a bundle other than the default and parses it back", () => {
    const resolved = resolveOutputOptions(normalizeOutputOptions({ bundle: "main" }), SNAPSHOT);
    expect(resolved.bundle).toBe("main");
    expect(resolved.look).toBe("marketplace");
    expect(ResolvedOutputOptions.parse(resolved)).toEqual(resolved);
    expect(ResolvedOutputOptions.safeParse({ ...resolved, bundle: "most" }).success).toBe(false);
  });

  it("leaves the default out of the stored row", () => {
    const resolved = resolveOutputOptions(normalizeOutputOptions({ bundle: "everything" }), SNAPSHOT);
    expect("bundle" in resolved).toBe(false);
  });

  it("puts the bundle in the plan flags only when it is not today's pack", () => {
    const main = resolveOutputOptions(normalizeOutputOptions({ bundle: "main" }), SNAPSHOT);
    expect(planFlagsOf(main, []).bundle).toBe("main");
    const today = resolveOutputOptions(DEFAULT_OUTPUT_OPTIONS, SNAPSHOT);
    expect("bundle" in planFlagsOf(today, [])).toBe(false);
  });
});

describe("isSecondaryShot", () => {
  it("counts other angles and other kept photos, never the front image or an extra", () => {
    expect(isSecondaryShot({ type: "alt_angle_white", priority: 2 })).toBe(true);
    expect(isSecondaryShot({ type: "original_photo", priority: 2 })).toBe(true);
    expect(isSecondaryShot({ type: "alt_angle_white", priority: 1 })).toBe(false);
    expect(isSecondaryShot({ type: "original_photo", priority: 1 })).toBe(false);
    expect(isSecondaryShot({ type: "amazon_main", priority: 1 })).toBe(false);
    for (const family of EXTRA_FAMILY_KEYS) {
      for (const type of EXTRA_FAMILIES[family]) {
        expect(isSecondaryShot({ type, priority: 4 })).toBe(false);
      }
    }
  });
});
