import { describe, expect, it } from "vitest";
import { brandPaletteOutcomeOf } from "./palette";
import { confirmedColors } from "./confirm";
import type { BrandKitSuggestion } from "./types";

// PHASE_16 workstream 7: the seller confirms before anything is saved, and
// only suggested colors can be confirmed.

const pair = (bg: string) => ({ backgroundHex: bg, textHex: "#FFFFFF", ratio: 10, passes: true });
const suggestion: BrandKitSuggestion = {
  colors: ["#1B2A4A", "#D7263D", "#F4B400"].map((hex, i) => ({ hex, name: "c", share: 0.3 - i * 0.1, text: pair(hex) })),
  background: { hex: "#EEF1F7", text: pair("#EEF1F7") },
  source: "pixels",
  ambiguous: false,
};

describe("confirmedColors", () => {
  it("keeps the picked colors, then the background", () => {
    expect(confirmedColors(suggestion, ["#1B2A4A", "#F4B400"], true, 6)).toEqual(["#1B2A4A", "#F4B400", "#EEF1F7"]);
    expect(confirmedColors(suggestion, ["#1b2a4a"], false, 6)).toEqual(["#1B2A4A"]);
  });

  it("drops colors that were never suggested and repeats, and caps the count", () => {
    expect(confirmedColors(suggestion, ["#000000", "#D7263D", "#D7263D"], false, 6)).toEqual(["#D7263D"]);
    expect(confirmedColors(suggestion, ["#1B2A4A", "#D7263D", "#F4B400"], true, 2)).toEqual(["#1B2A4A", "#D7263D"]);
  });
});

describe("brandPaletteOutcomeOf", () => {
  const base = { missing: false, unreadable: false, askedVision: false, costMicros: 0 };
  it("maps each run to a plain outcome", () => {
    expect(brandPaletteOutcomeOf({ ...base, suggestion })).toEqual({ ok: true, suggestion });
    expect(brandPaletteOutcomeOf({ ...base, missing: true, suggestion: null })).toMatchObject({ reason: "foreign_key" });
    expect(brandPaletteOutcomeOf({ ...base, unreadable: true, suggestion: null })).toMatchObject({ reason: "invalid_upload" });
    expect(brandPaletteOutcomeOf({ ...base, suggestion: { ...suggestion, colors: [] } })).toMatchObject({ reason: "no_colors" });
  });
});
