/**
 * PHASE_16 workstream 3: the ads Extra images family is off unless the
 * seller turns it on, and while off it leaves every options key, look and
 * plan flag exactly as before it existed.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_OPTIONS,
  LOOK_PRESETS,
  OutputOptionsInput,
  ResolvedOutputOptions,
  bundleExtrasFor,
  compactExtras,
  extraOn,
  lookOf,
  normalizeOutputOptions,
  outputOptionsKey,
  planFlagsOf,
  resolveOutputOptions,
} from "./output-options";

const SNAPSHOT = { colorHex: "#FFFFFF", brandSweepHex: "#3A4556", keepMediaIds: [] };

describe("the ads extra family", () => {
  it("keeps today's key for absent and explicit off", () => {
    const before = outputOptionsKey({});
    expect(before).not.toContain("ads");
    expect(outputOptionsKey({ extras: { ads: false } })).toBe(before);
    expect(outputOptionsKey(DEFAULT_OUTPUT_OPTIONS)).toBe(before);
    expect(outputOptionsKey({ extras: { ads: true } })).not.toBe(before);
    expect(outputOptionsKey({ extras: { ads: true } })).toContain('"ads":true');
  });

  it("reads absent as off everywhere", () => {
    expect(extraOn(DEFAULT_OUTPUT_OPTIONS.extras, "ads")).toBe(false);
    expect(extraOn({ ads: true }, "ads")).toBe(true);
    expect(compactExtras({ scenes: true, backdrops: true, transparentPng: true, graphics: true, cards: true, ads: false })).not.toHaveProperty(
      "ads",
    );
    expect(bundleExtrasFor("everything", "remove")).not.toHaveProperty("ads");
    for (const look of Object.values(LOOK_PRESETS)) {
      expect(look.extras).not.toHaveProperty("ads");
    }
  });

  it("makes the look custom when the seller turns ads on, and marketplace again when off", () => {
    expect(lookOf(normalizeOutputOptions({}))).toBe("marketplace");
    expect(lookOf(normalizeOutputOptions({ extras: { ads: true } }))).toBe("custom");
    expect(lookOf(normalizeOutputOptions({ extras: { ads: false } }))).toBe("marketplace");
  });

  it("carries ads through the resolved row and the plan flags only when on", () => {
    const on = resolveOutputOptions(normalizeOutputOptions({ extras: { ads: true } }), SNAPSHOT);
    expect(ResolvedOutputOptions.parse(on).extras.ads).toBe(true);
    expect(planFlagsOf(on, []).extras.ads).toBe(true);
    const off = resolveOutputOptions(normalizeOutputOptions({}), SNAPSHOT);
    expect(off.extras).not.toHaveProperty("ads");
    expect(planFlagsOf({ ...off, extras: { ...off.extras, ads: false } }, []).extras).not.toHaveProperty("ads");
  });

  it("stays strict: an unknown extra is refused", () => {
    expect(OutputOptionsInput.safeParse({ extras: { ads: true } }).success).toBe(true);
    expect(OutputOptionsInput.safeParse({ extras: { reels: true } }).success).toBe(false);
  });
});
