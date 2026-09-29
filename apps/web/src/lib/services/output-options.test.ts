import { describe, expect, it } from "vitest";
import { DEFAULT_OUTPUT_OPTIONS, outputOptionsKey } from "@curvi/pipeline/output-options";
import { backgroundSwatches, stillStyle } from "@curvi/pipeline/seed";
import {
  BRAND_COLOR_MISSING_MESSAGE,
  BRAND_COLOR_UPGRADE_MESSAGE,
  brandSweepHexFor,
  hasPhotoBackgroundOverride,
  INVALID_OPTIONS_MESSAGE,
  OPTIONS_UNAVAILABLE_MESSAGE,
  outputEstimateInputs,
  parseStoredOutputOptions,
  photoBackgroundsOf,
  readStoredOutputOptions,
  resolveJobOutput,
  type ResolveJobOutputArgs,
} from "./output-options";

const PHOTOS = [
  { id: "ws/a/src/front.jpg", angle: "front" as const, width: 4032, height: 3024 },
  { id: "ws/a/src/back.jpg", angle: "back" as const, width: null, height: null },
];

function args(overrides: Partial<ResolveJobOutputArgs> = {}): ResolveJobOutputArgs {
  return {
    input: undefined,
    mode: "listing",
    enabled: true,
    brandColors: ["#1f2a44", "#FD7F11"],
    brandKitsAllowed: true,
    photos: PHOTOS,
    ...overrides,
  };
}

/** Plain spoken copy (CLAUDE.md rule 9): no emoji, no arrows, no en or em dashes, no " - ". */
function passesRule9(text: string): boolean {
  return !/[–—←-⇿\u{1F300}-\u{1FAFF}]/u.test(text) && !text.includes(" - ") && !text.includes("->");
}

describe("resolveJobOutput", () => {
  it("resolves no options to today's pack on white with nothing kept", () => {
    const result = resolveJobOutput(args());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved).toMatchObject({
      look: "marketplace",
      background: "remove",
      colorHex: stillStyle.whiteHex,
      keepMediaIds: [],
    });
    expect(outputOptionsKey(result.resolved)).toBe(outputOptionsKey(DEFAULT_OUTPUT_OPTIONS));
    expect(result.flags.photos).toEqual([
      { id: PHOTOS[0].id, angle: "front", width: 4032, height: 3024 },
      { id: PHOTOS[1].id, angle: "back" },
    ]);
  });

  it("keeps every photo by id with Keep and snapshots the brand hexes upper case", () => {
    const result = resolveJobOutput(args({ input: { background: "keep", color: { kind: "brand", index: 1 } } }));
    expect(result.ok && result.resolved).toMatchObject({
      background: "keep",
      colorHex: "#FD7F11",
      brandSweepHex: "#1F2A44",
      keepMediaIds: PHOTOS.map((p) => p.id),
    });
  });

  it("normalizes concept packs to today's pack, even while options are off", () => {
    const result = resolveJobOutput(args({ mode: "concept", enabled: false, input: { background: "keep" } }));
    expect(result.ok && result.resolved.background).toBe("remove");
    expect(result.ok && result.resolved.keepMediaIds).toEqual([]);
  });

  it("refuses non default options while the gate is off, but not defaults", () => {
    expect(resolveJobOutput(args({ enabled: false, input: { color: { kind: "swatch", key: "sand" } } }))).toEqual({
      ok: false,
      reason: "feature_unavailable",
      message: OPTIONS_UNAVAILABLE_MESSAGE,
    });
    expect(resolveJobOutput(args({ enabled: false, input: { lookBase: "marketplace", fit: "auto" } })).ok).toBe(true);
  });

  it("answers upgrade_required for a brand color without brand kits and invalid_options for a missing index", () => {
    expect(resolveJobOutput(args({ brandKitsAllowed: false, input: { color: { kind: "brand", index: 0 } } }))).toMatchObject({
      reason: "upgrade_required",
      message: BRAND_COLOR_UPGRADE_MESSAGE,
    });
    expect(resolveJobOutput(args({ input: { color: { kind: "brand", index: 4 } } }))).toMatchObject({
      reason: "invalid_options",
      message: BRAND_COLOR_MISSING_MESSAGE,
    });
    expect(resolveJobOutput(args({ brandColors: ["not a hex"], input: { color: { kind: "brand", index: 0 } } }))).toMatchObject({
      reason: "invalid_options",
    });
  });

  it("answers invalid_options for anything the schema refuses", () => {
    for (const input of [
      { color: { kind: "custom", hex: "#FFF" } },
      { fit: "stretch" },
      { color: { kind: "edge_match", hex: "#FFFFFF" } },
      { sceneCount: 9 },
      { scenePreset: "neon" },
    ]) {
      expect(resolveJobOutput(args({ input: input as never }))).toEqual({
        ok: false,
        reason: "invalid_options",
        message: INVALID_OPTIONS_MESSAGE,
      });
    }
  });

  it("keeps a photo by its own choice (P1 background per photo) and refuses it while the gate is off", () => {
    const [front, back] = PHOTOS.map((p) => p.id);
    const mixed = resolveJobOutput(args({ photoBackgrounds: { [back]: "keep" } }));
    expect(mixed.ok && mixed.resolved.keepMediaIds).toEqual([back]);
    expect(mixed.ok && mixed.flags.keepMediaIds).toEqual([back]);
    const removeOne = resolveJobOutput(args({ input: { background: "keep" }, photoBackgrounds: { [front]: "remove", [back]: "pack" } }));
    expect(removeOne.ok && removeOne.resolved.keepMediaIds).toEqual([back]);
    expect(resolveJobOutput(args({ enabled: false, photoBackgrounds: { [back]: "keep" } }))).toMatchObject({
      ok: false,
      reason: "feature_unavailable",
    });
    // A choice equal to the pack's is no override, so it passes a closed gate.
    expect(resolveJobOutput(args({ enabled: false, photoBackgrounds: { [back]: "remove", [front]: "pack" } })).ok).toBe(true);
    // Concept packs keep nothing.
    const concept = resolveJobOutput(args({ mode: "concept", photoBackgrounds: { [back]: "keep" } }));
    expect(concept.ok && concept.resolved.keepMediaIds).toEqual([]);
    expect(photoBackgroundsOf([{ key: "a", background: "keep" }, { key: "b" }])).toEqual({ a: "keep" });
    expect(hasPhotoBackgroundOverride({ background: "keep" }, { a: "keep" })).toBe(false);
    expect(hasPhotoBackgroundOverride(undefined, { a: "keep" })).toBe(true);
  });

  it("estimates a mixed pack and every P1 choice with the plan flags", () => {
    const [, back] = PHOTOS.map((p) => p.id);
    const mixed = resolveJobOutput(args({ photoBackgrounds: { [back]: "keep" } }));
    expect(mixed.ok && outputEstimateInputs(mixed.resolved, PHOTOS).output?.keepMediaIds).toEqual([back]);
    const scenes = resolveJobOutput(args({ input: { sceneCount: 1 } }));
    expect(scenes.ok && outputEstimateInputs(scenes.resolved, PHOTOS).output?.sceneCount).toBe(1);
    const logo = resolveJobOutput(args({ input: { logo: false } }));
    expect(logo.ok && outputEstimateInputs(logo.resolved, PHOTOS).output).toBeDefined();
    const today = resolveJobOutput(args());
    expect(today.ok && outputEstimateInputs(today.resolved, PHOTOS)).toEqual({});
  });

  it("has refusal copy that passes rule 9", () => {
    for (const text of [INVALID_OPTIONS_MESSAGE, BRAND_COLOR_MISSING_MESSAGE, BRAND_COLOR_UPGRADE_MESSAGE, OPTIONS_UNAVAILABLE_MESSAGE]) {
      expect(passesRule9(text)).toBe(true);
    }
  });
});

describe("brandSweepHexFor", () => {
  it("takes the first valid kit color, else the seeded fallback", () => {
    expect(brandSweepHexFor(["bad", " #abcdef "])).toBe("#ABCDEF");
    expect(brandSweepHexFor([])).toBe(stillStyle.fallbackBrandHex.toUpperCase());
  });
});

describe("stored options", () => {
  it("reads SQL NULL as today's pack and throws on anything the schema refuses", () => {
    expect(parseStoredOutputOptions(null)).toBeNull();
    expect(() => parseStoredOutputOptions({ v: 2 })).toThrow();
    expect(readStoredOutputOptions({ v: 2 })).toBeUndefined();
    const resolved = resolveJobOutput(args({ input: { background: "keep" } }));
    const stored = resolved.ok ? JSON.parse(JSON.stringify(resolved.resolved)) : null;
    expect(parseStoredOutputOptions(stored)).toEqual(resolved.ok ? resolved.resolved : null);
  });
});

describe("outputEstimateInputs", () => {
  it("adds nothing for today's pack, so its hold stays exactly as before", () => {
    const result = resolveJobOutput(args({ input: { lookBase: "marketplace" } }));
    expect(outputEstimateInputs(result.ok ? result.resolved : null, PHOTOS)).toEqual({});
    expect(outputEstimateInputs(null, PHOTOS)).toEqual({});
  });

  it("passes the flags, the photos and the color for any other choice", () => {
    const result = resolveJobOutput(args({ input: { color: { kind: "swatch", key: "sage" } } }));
    const inputs = outputEstimateInputs(result.ok ? result.resolved : null, PHOTOS);
    expect(inputs.colorHex).toBe(backgroundSwatches.sage.hex);
    expect(inputs.photos).toEqual([{ angle: "front", width: 4032, height: 3024 }, { angle: "back" }]);
    expect(inputs.output?.photos.map((p) => p.id)).toEqual(PHOTOS.map((p) => p.id));
  });
});
