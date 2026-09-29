import { describe, expect, it } from "vitest";
import { dimensionBounds, getSpec, listSpecs, requiresWhiteBackground } from "@curvi/specs";
import {
  DEFAULT_OUTPUT_OPTIONS,
  EXTRA_FAMILIES,
  EXTRA_FAMILY_KEYS,
  GALLERY_SLOTS,
  HEX,
  LOOK_KEYS,
  LOOK_PRESETS,
  MAX_SOURCE_UPSCALE,
  NEVER_SWITCHABLE_SHOT_TYPES,
  OutputOptionsInput,
  P1_DEFAULTS,
  ResolvedOutputOptions,
  SELLER_OFF_REASON,
  SOURCE_TOO_SMALL_REASON,
  SWATCH_KEYS,
  backgroundFor,
  canvasSizeFor,
  conflictsFor,
  cutoutMediaIds,
  extraFamilyOf,
  graphicsFollowColor,
  hexToRgb,
  keepMediaIdsFor,
  keptMaxUpscale,
  logoOn,
  lookOf,
  normalizeOutputOptions,
  originalFitFor,
  originalScale,
  outputOptionsKey,
  packNeedsCutout,
  planFlagsOf,
  productSizeFillFor,
  relativeLuminance,
  resolveColorHex,
  resolveOutputOptions,
  rgbToHex,
  sceneCountOf,
  scenePresetOf,
  specAcceptsImage,
  templateCardColors,
  whiteRequiredGallerySpecIds,
  type OutputPlanFlags,
  type PlanPhoto,
  type ResolvedOutputOptions as Resolved,
} from "./output-options";
import { minLongSideFor } from "./qc/pixelChecks";
import { MAX_SOURCE_UPSCALE as SIZE_GATE_UPSCALE } from "./size-gate";
import { MAX_BRAND_COLORS } from "./seed/brand";
import { backgroundSwatches, canvasDefaults, originalFit, sceneCountOptions, stillStyle } from "./seed/templates";
import { Shot } from "./schemas";

const WHITE_SPECS = ["amazon.main", "google.merchant.main", "walmart.main", "tiktokshop.main"];
const ALL_ON = { scenes: true, backdrops: true, transparentPng: true, graphics: true, cards: true };
const ALL_OFF = { scenes: false, backdrops: false, transparentPng: false, graphics: false, cards: false };

function resolved(input: Parameters<typeof normalizeOutputOptions>[0], snapshot: Partial<Resolved> = {}): Resolved {
  const options = normalizeOutputOptions(input);
  return resolveOutputOptions(options, {
    colorHex: snapshot.colorHex ?? resolveColorHex(options.color, ["#1F2A44"]) ?? stillStyle.whiteHex,
    brandSweepHex: snapshot.brandSweepHex ?? "#1F2A44",
    keepMediaIds: snapshot.keepMediaIds ?? [],
  });
}

describe("normalizeOutputOptions", () => {
  it("normalizes an empty object and an absent one to today's pack", () => {
    const expected = {
      v: 1,
      background: "remove",
      color: { kind: "swatch", key: "white" },
      fit: "auto",
      extras: ALL_ON,
      sceneCount: 3,
      scenePreset: "auto",
      logo: true,
      productSize: "standard",
      enlarge: true,
      graphicsColor: false,
    };
    expect(normalizeOutputOptions({})).toEqual(expected);
    expect(normalizeOutputOptions(undefined)).toEqual(expected);
    expect(normalizeOutputOptions(null)).toEqual(expected);
    expect(DEFAULT_OUTPUT_OPTIONS).toEqual(expected);
  });

  it("turns every extra off with Keep, and keeps the ones the seller set", () => {
    expect(normalizeOutputOptions({ background: "keep" }).extras).toEqual(ALL_OFF);
    expect(normalizeOutputOptions({ background: "keep", extras: { scenes: true } }).extras).toEqual({
      ...ALL_OFF,
      scenes: true,
    });
    expect(normalizeOutputOptions({ extras: { cards: false } }).extras).toEqual({ ...ALL_ON, cards: false });
  });

  it("keeps lookBase for analytics", () => {
    expect(normalizeOutputOptions({ lookBase: "keep_photo" }).lookBase).toBe("keep_photo");
  });

  it("accepts every P1 field, with the seeded bounds, and absent equals explicit defaults", () => {
    const p1 = {
      fit: "crop",
      color: { kind: "edge_match" },
      sceneCount: 1,
      scenePreset: "outdoor",
      logo: false,
      productSize: "larger",
      enlarge: false,
      graphicsColor: true,
    } as const;
    const normalized = normalizeOutputOptions({ background: "keep", ...p1 });
    expect(normalized).toMatchObject(p1);
    expect(OutputOptionsInput.safeParse({ sceneCount: sceneCountOptions.max }).success).toBe(true);
    expect(OutputOptionsInput.safeParse({ sceneCount: sceneCountOptions.min }).success).toBe(true);
    expect(outputOptionsKey({})).toBe(outputOptionsKey({ ...P1_DEFAULTS }));
    expect(outputOptionsKey({ sceneCount: 3 })).toBe(outputOptionsKey(undefined));
    for (const [key, value] of Object.entries(p1)) {
      expect(outputOptionsKey({ [key]: value }), key).not.toBe(outputOptionsKey({}));
      expect(lookOf(normalizeOutputOptions({ [key]: value })), key).toBe("custom");
    }
  });

  it("refuses bad colors, out of range P1 values and unknown keys", () => {
    const bad: unknown[] = [
      { color: { kind: "custom", hex: "#FFF" } },
      { color: { kind: "custom", hex: "red" } },
      { color: { kind: "custom", hex: "#GGGGGG" } },
      { color: { kind: "brand", index: MAX_BRAND_COLORS } },
      { color: { kind: "brand", index: 6 } },
      { color: { kind: "brand", index: -1 } },
      { color: { kind: "brand", index: 1.5 } },
      { color: { kind: "swatch", key: "neon" } },
      { color: { kind: "swatch", key: "white", extra: 1 } },
      { color: { kind: "edge_match", hex: "#FFFFFF" } },
      { fit: "stretch" },
      { background: "blur" },
      { v: 2 },
      { sceneCount: sceneCountOptions.min - 1 },
      { sceneCount: sceneCountOptions.max + 1 },
      { sceneCount: 2.5 },
      { scenePreset: "neon" },
      { productSize: "huge" },
      { logo: "yes" },
      { enlarge: 0 },
      { extras: { video: true } },
      { lookBase: "custom" },
    ];
    for (const input of bad) {
      expect(OutputOptionsInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
      expect(() => normalizeOutputOptions(input as never)).toThrow();
    }
    expect(OutputOptionsInput.safeParse({ color: { kind: "brand", index: MAX_BRAND_COLORS - 1 } }).success).toBe(true);
    expect(OutputOptionsInput.safeParse({ color: { kind: "custom", hex: "#1f2a44" } }).success).toBe(true);
  });

  it("offers every seeded swatch and nothing else", () => {
    expect(SWATCH_KEYS).toEqual(Object.keys(backgroundSwatches));
    for (const key of SWATCH_KEYS) {
      expect(OutputOptionsInput.safeParse({ color: { kind: "swatch", key } }).success).toBe(true);
    }
  });
});

describe("looks", () => {
  it("round trips every preset through lookOf", () => {
    for (const look of LOOK_KEYS) {
      expect(lookOf(LOOK_PRESETS[look])).toBe(look);
      expect(lookOf(normalizeOutputOptions({ ...LOOK_PRESETS[look], lookBase: look }))).toBe(look);
    }
    expect(lookOf(DEFAULT_OUTPUT_OPTIONS)).toBe("marketplace");
  });

  it("reads custom for any difference from a preset", () => {
    expect(lookOf(normalizeOutputOptions({ extras: { scenes: false } }))).toBe("custom");
    expect(lookOf(normalizeOutputOptions({ color: { kind: "swatch", key: "sand" } }))).toBe("custom");
    expect(lookOf(normalizeOutputOptions({ background: "keep", fit: "pad" }))).toBe("custom");
    expect(lookOf(normalizeOutputOptions({ background: "keep", extras: { scenes: true } }))).toBe("custom");
    expect(lookOf(normalizeOutputOptions({ color: { kind: "brand", index: 1 } }))).toBe("custom");
    // The card the seller started from never changes the derived look.
    expect(lookOf(normalizeOutputOptions({ lookBase: "brand" }))).toBe("marketplace");
  });
});

describe("outputOptionsKey", () => {
  it("is stable under key order and equal for absent and explicit defaults", () => {
    const a = outputOptionsKey({ background: "keep", fit: "pad", extras: { scenes: true, cards: false } });
    const b = outputOptionsKey({ extras: { cards: false, scenes: true }, fit: "pad", background: "keep" });
    expect(a).toBe(b);
    expect(outputOptionsKey(undefined)).toBe(outputOptionsKey({}));
    expect(outputOptionsKey(null)).toBe(outputOptionsKey(DEFAULT_OUTPUT_OPTIONS));
    expect(outputOptionsKey({})).toBe(
      outputOptionsKey({ v: 1, background: "remove", color: { kind: "swatch", key: "white" }, fit: "auto", extras: ALL_ON }),
    );
  });

  it("ignores lookBase and every resolved field", () => {
    const base = outputOptionsKey({ background: "keep" });
    expect(outputOptionsKey({ background: "keep", lookBase: "keep_photo" })).toBe(base);
    expect(outputOptionsKey(resolved({ background: "keep" }, { keepMediaIds: ["ws/a/src/1.jpg"] }))).toBe(base);
    expect(outputOptionsKey(resolved({ background: "keep" }, { colorHex: "#123456", brandSweepHex: "#654321" }))).toBe(base);
  });

  it("changes with any choice", () => {
    const keys = new Set([
      outputOptionsKey({}),
      outputOptionsKey({ background: "keep" }),
      outputOptionsKey({ color: { kind: "swatch", key: "sand" } }),
      outputOptionsKey({ color: { kind: "custom", hex: "#1F2A44" } }),
      outputOptionsKey({ fit: "pad" }),
      outputOptionsKey({ extras: { scenes: false } }),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe("ResolvedOutputOptions", () => {
  it("parses what resolveOutputOptions builds, with the derived look", () => {
    const value = resolved({ background: "keep" }, { keepMediaIds: ["ws/a/src/1.jpg"] });
    expect(ResolvedOutputOptions.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(value.look).toBe("keep_photo");
    expect(value.colorHex).toBe(stillStyle.whiteHex);
    expect(resolved({ color: { kind: "swatch", key: "sand" } }).look).toBe("custom");
  });

  it("fails closed on an unknown version, a missing field, a bad hex or an unknown key", () => {
    const value = resolved({});
    for (const bad of [
      { ...value, v: 2 },
      { ...value, colorHex: "white" },
      { ...value, brandSweepHex: "#12345" },
      { ...value, extras: { scenes: true } },
      { ...value, look: "fancy" },
      { ...value, keepMediaIds: [""] },
      { ...value, sceneCount: sceneCountOptions.max + 1 },
      { ...value, scenePreset: "neon" },
      (({ colorHex: _drop, ...rest }) => rest)(value),
    ]) {
      expect(ResolvedOutputOptions.safeParse(bad).success).toBe(false);
    }
  });
});

describe("resolveColorHex", () => {
  it("resolves swatches from the seed, brand colors by index and custom values, upper case", () => {
    expect(resolveColorHex({ kind: "swatch", key: "white" }, [])).toBe(stillStyle.whiteHex);
    expect(resolveColorHex({ kind: "swatch", key: "sand" }, [])).toBe(backgroundSwatches.sand.hex);
    expect(resolveColorHex({ kind: "brand", index: 1 }, ["#000000", "#1f2a44"])).toBe("#1F2A44");
    expect(resolveColorHex({ kind: "brand", index: 2 }, ["#000000"])).toBeNull();
    expect(resolveColorHex({ kind: "custom", hex: "#abcdef" }, [])).toBe("#ABCDEF");
  });
});

describe("extra families", () => {
  it("puts every shot type in at most one family, and never a never switchable one", () => {
    const seen = new Map<string, string>();
    for (const family of EXTRA_FAMILY_KEYS) {
      for (const type of EXTRA_FAMILIES[family]) {
        expect(seen.has(type), type).toBe(false);
        seen.set(type, family);
        expect(extraFamilyOf(type)).toBe(family);
      }
    }
    for (const type of NEVER_SWITCHABLE_SHOT_TYPES) {
      expect(extraFamilyOf(type)).toBeNull();
    }
    for (const type of Shot.shape.type.options) {
      expect(seen.has(type) || extraFamilyOf(type) === null).toBe(true);
    }
  });

  it("keeps the control 5 table", () => {
    expect(EXTRA_FAMILIES).toEqual({
      scenes: ["lifestyle", "shopify_hero"],
      backdrops: ["sweep_gray", "sweep_brand"],
      transparentPng: ["cutout_png"],
      graphics: ["infographic", "dimensions", "in_the_box", "comparison"],
      cards: ["social_1x1", "social_4x5", "social_9x16", "social_2x3", "aplus_banner"],
    });
    expect(SELLER_OFF_REASON).toBe("turned off by the seller");
    expect(SOURCE_TOO_SMALL_REASON).toBe("source too small for this channel");
  });
});

describe("planFlagsOf", () => {
  it("holds no hex and no free text", () => {
    const value = resolved(
      { background: "keep", color: { kind: "custom", hex: "#1F2A44" } },
      { keepMediaIds: ["ws/a/src/1.jpg", "ws/a/src/2.jpg"] },
    );
    const flags = planFlagsOf(value, [
      { id: "ws/a/src/1.jpg", angle: "front", width: 3000, height: 2000 },
      { id: "ws/a/src/2.jpg" },
    ]);
    const json = JSON.stringify(flags);
    expect(json).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(Object.keys(flags).sort()).toEqual([
      "background",
      "enlarge",
      "extras",
      "fit",
      "keepMediaIds",
      "photos",
      "sceneCount",
    ]);
    expect(flags.photos[1]).toEqual({ id: "ws/a/src/2.jpg" });
    expect(flags.keepMediaIds).toEqual(["ws/a/src/1.jpg", "ws/a/src/2.jpg"]);
  });

  it("keeps every photo with Keep and none with Remove", () => {
    expect(keepMediaIdsFor({ background: "keep" }, ["a", "b"])).toEqual(["a", "b"]);
    expect(keepMediaIdsFor({ background: "remove" }, ["a", "b"])).toEqual([]);
  });

  it("lets each photo override the pack (P1 background per photo)", () => {
    const ids = ["a", "b", "c"];
    expect(keepMediaIdsFor({ background: "remove" }, ids, { b: "keep" })).toEqual(["b"]);
    expect(keepMediaIdsFor({ background: "keep" }, ids, { a: "remove", b: "pack" })).toEqual(["b", "c"]);
    expect(keepMediaIdsFor({ background: "keep" }, ids, {})).toEqual(ids);
  });

  it("carries the scene count and the enlarge cap, with defaults for rows stored before P1", () => {
    const old = resolved({});
    const { sceneCount: _s, enlarge: _e, ...stored } = old;
    expect(ResolvedOutputOptions.safeParse(stored).success).toBe(true);
    expect(planFlagsOf(ResolvedOutputOptions.parse(stored), []).sceneCount).toBe(sceneCountOptions.default);
    expect(planFlagsOf(resolved({ sceneCount: 1, enlarge: false }), [])).toMatchObject({ sceneCount: 1, enlarge: false });
  });
});

describe("P1 accessors", () => {
  it("fill the defaults for options without P1 fields", () => {
    expect(sceneCountOf(null)).toBe(sceneCountOptions.default);
    expect(scenePresetOf(null)).toBeNull();
    expect(scenePresetOf({ scenePreset: "holiday" })).toBe("holiday");
    expect(logoOn(undefined)).toBe(true);
    expect(logoOn({ logo: false })).toBe(false);
    expect(graphicsFollowColor(undefined)).toBe(false);
    expect(keptMaxUpscale(undefined)).toBe(MAX_SOURCE_UPSCALE);
    expect(keptMaxUpscale({ enlarge: false })).toBe(1);
  });

  it("resolves edge match to seed white for removed photos and extras", () => {
    expect(resolveColorHex({ kind: "edge_match" }, [])).toBe(stillStyle.whiteHex);
  });

  it("clamps the product size into spec.fill, so amazon.main stays within 0.85 to 0.9", () => {
    const main = getSpec("amazon.main");
    for (const size of ["standard", "larger", "smaller"] as const) {
      const fill = productSizeFillFor(main, { productSize: size });
      expect(fill).toBeGreaterThanOrEqual(0.85);
      expect(fill).toBeLessThanOrEqual(0.9);
      const google = productSizeFillFor(getSpec("google.merchant.main"), { productSize: size });
      expect(google).toBeGreaterThanOrEqual(getSpec("google.merchant.main").fill!.min);
      expect(google).toBeLessThanOrEqual(getSpec("google.merchant.main").fill!.max);
    }
    const open = getSpec("amazon.secondary");
    expect(productSizeFillFor(open, { productSize: "larger" })).toBe(canvasDefaults.productSizeFill.larger);
    expect(productSizeFillFor(open, { productSize: "smaller" })).toBe(canvasDefaults.productSizeFill.smaller);
    expect(productSizeFillFor(open, null)).toBe(canvasDefaults.productSizeFill.standard);
  });

  it("puts template cards on the preset color, or the seller's with text flipped below the seeded luminance", () => {
    const spec = getSpec("meta.feed_1x1");
    const off = templateCardColors(spec, "outdoor", { colorHex: "#1B1F24" });
    expect(off).toEqual({ backgroundHex: stillStyle.presetBackgroundHex.outdoor, textHex: stillStyle.textHex });
    expect(templateCardColors(spec, "none", null).backgroundHex).toBe(stillStyle.defaultBackgroundHex);
    const dark = templateCardColors(spec, "outdoor", { colorHex: "#1B1F24", graphicsColor: true });
    expect(dark).toEqual({ backgroundHex: "#1B1F24", textHex: stillStyle.textOnDarkHex });
    const light = templateCardColors(spec, "outdoor", { colorHex: backgroundSwatches.sand.hex, graphicsColor: true });
    expect(light).toEqual({ backgroundHex: backgroundSwatches.sand.hex, textHex: stillStyle.textHex });
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
    // Every seeded swatch keeps dark text; a white required spec stays white.
    for (const swatch of Object.values(backgroundSwatches)) {
      expect(relativeLuminance(swatch.hex)).toBeGreaterThanOrEqual(stillStyle.darkBackgroundLuminance);
    }
    expect(templateCardColors(getSpec("amazon.main"), "outdoor", { colorHex: "#1B1F24", graphicsColor: true }).backgroundHex).toBe(
      stillStyle.whiteHex,
    );
  });

  it("maps crop to crop on every spec, and plans it as its fallback", () => {
    for (const spec of listSpecs()) {
      expect(originalFitFor(spec, { fit: "crop" })).toBe("crop");
    }
    // Planned without a box, a crop never skips where it falls back to pad.
    expect(originalScale({ width: 400, height: 400 }, getSpec("meta.feed_4x5"), { fit: "crop" }).skip).toBeUndefined();
  });
});

describe("cutoutMediaIds and packNeedsCutout", () => {
  const photos: PlanPhoto[] = [
    { id: "back", angle: "back" },
    { id: "front", angle: "front" },
    { id: "box", angle: "packaging" },
  ];
  const flags = (over: Partial<OutputPlanFlags>): OutputPlanFlags => ({
    background: "keep",
    keepMediaIds: photos.map((p) => p.id),
    extras: ALL_OFF,
    fit: "auto",
    photos,
    ...over,
  });

  const cases: Array<[string, readonly string[], Partial<OutputPlanFlags>, string[]]> = [
    ["remove cuts out every photo", ["amazon.secondary"], { background: "remove", keepMediaIds: [], extras: ALL_ON }, ["back", "front", "box"]],
    ["keep, no white spec, no extra needs none", ["amazon.secondary", "etsy.listing", "meta.feed_1x1"], {}, []],
    ["keep with amazon.main needs the front photo", ["amazon.main", "amazon.secondary"], {}, ["front"]],
    ["keep with google main needs the front photo", ["google.merchant.main"], {}, ["front"]],
    ["keep with any extra needs the front photo", ["amazon.secondary"], { extras: { ...ALL_OFF, scenes: true } }, ["front"]],
    ["keep with graphics needs the in the box photo too", ["amazon.secondary"], { extras: { ...ALL_OFF, graphics: true } }, ["front", "box"]],
    ["keep with a white gallery spec needs every photo", ["walmart.main"], {}, ["back", "front", "box"]],
    ["keep with TikTok Shop needs every photo", ["tiktokshop.main", "etsy.listing"], {}, ["back", "front", "box"]],
    ["a removed photo in a kept pack", ["etsy.listing"], { keepMediaIds: ["front", "box"] }, ["back"]],
    ["unknown specs are ignored", ["myspace.main"], {}, []],
  ];

  for (const [name, specIds, over, expected] of cases) {
    it(name, () => {
      const f = flags(over);
      expect(cutoutMediaIds(photos, specIds, f)).toEqual(expected);
      expect(packNeedsCutout(specIds, f)).toBe(expected.length > 0);
    });
  }

  it("takes the first photo as the front when none is tagged", () => {
    const untagged = [{ id: "a" }, { id: "b" }];
    expect(cutoutMediaIds(untagged, ["amazon.main"], flags({ photos: untagged, keepMediaIds: ["a", "b"] }))).toEqual(["a"]);
  });

  it("reads the white required gallery specs from the registry", () => {
    expect(whiteRequiredGallerySpecIds()).toEqual(["walmart.main", "tiktokshop.main"]);
    expect(GALLERY_SLOTS.map((slot) => slot.specId).every((id) => getSpec(id).id === id)).toBe(true);
  });
});

describe("backgroundFor", () => {
  const colors = [
    ...Object.values(backgroundSwatches).map((swatch) => swatch.hex),
    "#1F2A44",
    "#000000",
    "#FEFEFE",
  ];

  it("returns white for exactly the four white specs under every color (property over listSpecs)", () => {
    for (const hex of colors) {
      const value = resolved({ color: { kind: "custom", hex } });
      for (const spec of listSpecs()) {
        const bg = backgroundFor(spec, value);
        const white = WHITE_SPECS.includes(spec.id);
        expect(requiresWhiteBackground(spec)).toBe(white);
        if (white) {
          expect(bg.rgb, `${spec.id} ${hex}`).toEqual([255, 255, 255]);
          expect(bg.forcedWhite).toBe(hex.toUpperCase() !== stillStyle.whiteHex);
        } else {
          expect(bg.rgb, `${spec.id} ${hex}`).toEqual(hexToRgb(hex));
          expect(bg.forcedWhite).toBe(false);
        }
      }
    }
  });

  it("uses seed white when there are no options", () => {
    expect(backgroundFor(getSpec("etsy.listing"), null).rgb).toEqual(hexToRgb(stillStyle.whiteHex));
    expect(rgbToHex(hexToRgb("#1f2a44"))).toBe("#1F2A44");
    expect(() => hexToRgb("#FFF")).toThrow();
    expect(HEX.test("#1F2A44")).toBe(true);
  });
});

describe("specAcceptsImage with original", () => {
  it("accepts a kept photo only where white is not required and the rule is absent, any or consistent", () => {
    for (const spec of listSpecs()) {
      const rule = spec.background?.type;
      const expected = !requiresWhiteBackground(spec) && (rule === undefined || rule === "any" || rule === "consistent");
      expect(specAcceptsImage(spec, "original"), spec.id).toBe(expected);
    }
    for (const id of WHITE_SPECS) {
      expect(specAcceptsImage(getSpec(id), "original")).toBe(false);
    }
    for (const id of ["amazon.secondary", "shopify.product", "etsy.listing", "ebay.listing", "google.merchant.lifestyle", "meta.feed_4x5"]) {
      expect(specAcceptsImage(getSpec(id), "original"), id).toBe(true);
    }
  });
});

describe("originalFitFor", () => {
  it("maps pad to auto on specs that refuse added borders", () => {
    for (const spec of listSpecs()) {
      const fit = originalFitFor(spec, { fit: "pad" });
      if (spec.bordersAllowed === false) {
        expect(fit, spec.id).toBe("auto");
      } else {
        expect(fit, spec.id).toBe("pad");
      }
    }
    expect(originalFitFor(getSpec("ebay.listing"), { fit: "pad" })).toBe("auto");
  });

  it("pads exact size specs and keeps the shape elsewhere with auto", () => {
    expect(originalFitFor(getSpec("meta.feed_4x5"), { fit: "auto" })).toBe("pad");
    expect(originalFitFor(getSpec("amazon.secondary"), { fit: "auto" })).toBe("auto");
    expect(originalFitFor(getSpec("amazon.secondary"), null)).toBe("auto");
  });
});

describe("originalScale", () => {
  it("shares the size gate's enlarge cap", () => {
    expect(MAX_SOURCE_UPSCALE).toBe(SIZE_GATE_UPSCALE);
  });

  it("uses the QC minimum long side on every spec that takes a kept photo", () => {
    for (const spec of listSpecs().filter((s) => specAcceptsImage(s, "original"))) {
      const photo = { width: 100, height: 100 };
      const out = originalScale(photo, spec, { fit: "auto" });
      if (originalFitFor(spec, { fit: "auto" }) === "auto") {
        const need = Math.max(minLongSideFor(spec), dimensionBounds(spec).minWidth, dimensionBounds(spec).minHeight) / 100;
        expect(out.skip !== undefined, spec.id).toBe(need > MAX_SOURCE_UPSCALE);
      }
    }
  });

  it("shrinks a large photo to the spec maximum, keeping its shape", () => {
    const out = originalScale({ width: 4032, height: 3024 }, getSpec("amazon.secondary"), { fit: "auto" });
    expect(out.skip).toBeUndefined();
    expect(out.width).toBe(2000);
    expect(out.height).toBe(1500);
  });

  it("never resamples a photo that already fits", () => {
    expect(originalScale({ width: 1500, height: 1500 }, getSpec("etsy.listing"), null)).toEqual({
      scale: 1,
      width: 1500,
      height: 1500,
    });
  });

  it("caps kept outputs at the seeded megapixels", () => {
    const out = originalScale({ width: 10328, height: 7760 }, getSpec("google.merchant.lifestyle"), null);
    expect(out.skip).toBeUndefined();
    expect((out.width * out.height) / 1_000_000).toBeLessThanOrEqual(originalFit.maxMegapixels + 0.01);
  });

  it("raises a photo to the minimum long side within the cap, or skips it", () => {
    const secondary = getSpec("amazon.secondary");
    const raised = originalScale({ width: 1200, height: 900 }, secondary, null);
    expect(raised.skip).toBeUndefined();
    expect(raised.width).toBe(1600);
    expect(raised.scale).toBeLessThanOrEqual(MAX_SOURCE_UPSCALE);
    // 1600 / 1.5 is 1066.7, so a 1066 px long side cannot reach it.
    expect(originalScale({ width: 1066, height: 800 }, secondary, null).skip).toBe(SOURCE_TOO_SMALL_REASON);
    expect(originalScale({ width: 1067, height: 800 }, secondary, null).skip).toBeUndefined();
  });

  it("meets minWidth and minHeight, raising a panorama or skipping it", () => {
    const lifestyle = getSpec("google.merchant.lifestyle");
    const pano = originalScale({ width: 3000, height: 400 }, lifestyle, null);
    expect(pano.skip).toBeUndefined();
    expect(pano.height).toBe(500);
    expect(pano.scale).toBeCloseTo(1.25);
    expect(originalScale({ width: 600, height: 300 }, lifestyle, null).skip).toBe(SOURCE_TOO_SMALL_REASON);
    const small = originalScale({ width: 400, height: 400 }, lifestyle, null);
    expect(small.skip).toBeUndefined();
    expect(small.width).toBe(500);
  });

  it("never enlarges with pad and never skips", () => {
    const feed = getSpec("meta.feed_4x5");
    const tiny = originalScale({ width: 300, height: 200 }, feed, { fit: "pad" });
    expect(tiny).toEqual({ scale: 1, width: 300, height: 200 });
    const big = originalScale({ width: 4000, height: 3000 }, feed, { fit: "auto" });
    expect(big.skip).toBeUndefined();
    expect(big.width).toBeLessThanOrEqual(1080);
    expect(big.height).toBeLessThanOrEqual(1350);
  });

  it("keeps the photo inside the story safe zone", () => {
    const story = getSpec("meta.story_9x16");
    const out = originalScale({ width: 1000, height: 3000 }, story, { fit: "pad" });
    const safe = 1920 - (story.safeZone?.top ?? 0) - (story.safeZone?.bottom ?? 0);
    expect(out.height).toBeLessThanOrEqual(safe);
    expect(canvasSizeFor(story)).toEqual({ width: 1080, height: 1920 });
  });
});

describe("conflictsFor", () => {
  const photos = [
    { id: "front", angle: "front", width: 3000, height: 3000 },
    { id: "back", angle: "back", width: 900, height: 700, otherItems: true },
  ];
  const keep = resolved({ background: "keep", fit: "pad" }, { keepMediaIds: ["front", "back"] });

  it("reports each code with the spec or photo it is about", () => {
    const codes = conflictsFor(
      ["amazon.main", "amazon.secondary", "ebay.listing", "google.merchant.lifestyle", "tiktokshop.main"],
      keep,
      photos,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        { code: "white_required", specId: "amazon.main" },
        { code: "white_required", specId: "tiktokshop.main" },
        { code: "borders_refused", specId: "ebay.listing" },
        { code: "overlays_refused", specId: "ebay.listing" },
        { code: "overlays_refused", specId: "google.merchant.lifestyle" },
        { code: "other_items", photoId: "back" },
      ]),
    );
    expect(codes.some((c) => c.code === "mixed_consistent")).toBe(false);
    // Pad never fails for size; auto leaves a small photo out of a spec.
    expect(codes.some((c) => c.code === "too_small")).toBe(false);
    const auto = resolved({ background: "keep" }, { keepMediaIds: ["front", "back"] });
    const autoCodes = conflictsFor(["amazon.secondary", "ebay.listing"], auto, photos);
    expect(autoCodes).toContainEqual({ code: "too_small", specId: "amazon.secondary", photoId: "back" });
    expect(autoCodes.some((c) => c.code === "borders_refused")).toBe(false);
  });

  it("reports nothing for today's pack", () => {
    expect(conflictsFor(["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"], resolved({}), photos)).toEqual([]);
  });

  it("names white required specs and the consistent store when the color is not white", () => {
    const sand = resolved({ color: { kind: "swatch", key: "sand" } });
    expect(conflictsFor(["amazon.main", "shopify.product", "etsy.listing"], sand, photos)).toEqual([
      { code: "white_required", specId: "amazon.main" },
      { code: "mixed_consistent", specId: "shopify.product" },
    ]);
  });
});
