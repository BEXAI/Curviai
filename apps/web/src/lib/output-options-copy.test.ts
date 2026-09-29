import { describe, expect, it } from "vitest";
import {
  conflictsFor,
  MAX_SOURCE_UPSCALE,
  normalizeOutputOptions,
  resolveOutputOptions,
  type OutputConflictCode,
} from "@curvi/pipeline/output-options";
import { listSpecs, requiresWhiteBackground } from "@curvi/specs";
import { PACKS_PAUSED_COPY } from "@/lib/provider-preflight";
import {
  conflictCopy,
  conflictLines,
  DARK_COLOR_EDGE_NOTE,
  EXTRA_FAMILY_NAMES,
  FORCED_WHITE_NOTE,
  KEEP_PHOTOS_INSTEAD_LABEL,
  KEEP_PHOTOS_PAUSED_COPY,
  leftOutAfterPauseLine,
  LOOK_TITLES,
  OPTIONS_PAUSED_COPY,
  OPTIONS_UNREADABLE_COPY,
  OTHER_ITEMS_KEPT_COPY,
  overlaysRefusedLine,
  SHOPIFY_SOFT_NOTE,
  SIZED_FOR_EACH_CHANNEL_TITLE,
  tooSmallLine,
  whiteChannelsLine,
  whiteRequiredCopy,
} from "./output-options-copy";

// Rule 9: plain spoken, no emojis, no arrows, no dashes as punctuation.
const FORBIDDEN = /[–—→←]| - |->|=>|[\u{1F300}-\u{1FAFF}]/u;

const CODES: OutputConflictCode[] = [
  "white_required",
  "borders_refused",
  "overlays_refused",
  "mixed_consistent",
  "other_items",
  "too_small",
];

function resolved(input: Parameters<typeof normalizeOutputOptions>[0], colorHex: string, keepMediaIds: string[] = []) {
  return resolveOutputOptions(normalizeOutputOptions(input), { colorHex, brandSweepHex: "#1F2A44", keepMediaIds });
}

describe("conflict copy", () => {
  it("has plain copy for every conflict code on every registry spec, in both modes", () => {
    const photos = [{ id: "p1", width: 900, height: 675 }];
    for (const spec of listSpecs()) {
      for (const code of CODES) {
        for (const background of ["remove", "keep"] as const) {
          const line = conflictCopy({ code, specId: spec.id, photoId: "p1" }, { background, photos });
          expect(line.text.length, `${code} ${spec.id}`).toBeGreaterThan(20);
          expect(line.text).not.toMatch(FORBIDDEN);
          expect(line.text).not.toContain(spec.id);
          expect(line.text).not.toContain("undefined");
          if (line.leaveOutLabel !== undefined) {
            expect(line.leaveOutLabel).not.toMatch(FORBIDDEN);
            expect(line.specIds).toEqual([spec.id]);
          }
        }
      }
    }
  });

  it("uses the per channel lines and Leave it out labels of control 4", () => {
    const keep = { background: "keep" as const };
    expect(conflictCopy({ code: "white_required", specId: "amazon.main" }, keep)).toMatchObject({
      text: "Amazon's main image must be pure white, so this one image has its background removed.",
      leaveOutLabel: "Leave it out",
    });
    expect(conflictCopy({ code: "white_required", specId: "walmart.main" }, keep)).toMatchObject({
      text: "Walmart takes white backgrounds only, so your Walmart images have the background removed.",
      leaveOutLabel: "Leave Walmart out",
    });
    expect(conflictCopy({ code: "white_required", specId: "google.merchant.main" }, keep).text).toBe(
      "Google's main image must be white or transparent, so its background is removed.",
    );
    expect(conflictCopy({ code: "white_required", specId: "tiktokshop.main" }, keep).leaveOutLabel).toBe(
      "Leave TikTok Shop out",
    );
  });

  it("gives a white required spec with no line of its own a generic one from specDisplayName", () => {
    expect(whiteRequiredCopy("etsy.listing")).toEqual({
      name: "Etsy listing image",
      line: "Etsy listing image needs a white background, so its background is removed.",
      leaveOut: "Leave it out",
    });
  });

  it("names the white channels in one line with Remove and a color", () => {
    const specIds = listSpecs().map((spec) => spec.id);
    expect(whiteChannelsLine(specIds)).toBe(
      "Amazon main image, Google main image, Walmart and TikTok Shop stay pure white. Your color is used everywhere else.",
    );
    expect(whiteChannelsLine(["amazon.main"])).toBe("Amazon main image stays pure white. Your color is used everywhere else.");
    expect(whiteChannelsLine(["etsy.listing"])).toBeNull();
    const sand = resolved({ color: { kind: "swatch", key: "sand" } }, "#EADFCF");
    const lines = conflictLines(conflictsFor(specIds, sand, [{ id: "p1" }]), { background: "remove" });
    expect(lines.filter((line) => line.code === "white_required")).toHaveLength(1);
    expect(lines.map((line) => line.text)).toContain(SHOPIFY_SOFT_NOTE);
  });

  it("words the other codes with names from the registry and the numbers of the photo", () => {
    expect(conflictCopy({ code: "borders_refused", specId: "ebay.listing" }, { background: "keep" }).text).toBe(
      "eBay does not allow added borders, so eBay images keep your photo's shape.",
    );
    expect(overlaysRefusedLine(["ebay.listing", "google.merchant.lifestyle"])).toBe(
      "eBay and Google do not allow added text, borders or watermarks on photos. If yours has any, leave these channels out or upload a clean photo. Your product's own logo and labels are fine.",
    );
    expect(SHOPIFY_SOFT_NOTE).toBe("Shopify suggests one background style across your store.");
    expect(conflictCopy({ code: "other_items", photoId: "p1" }, { background: "keep" }).text).toBe(OTHER_ITEMS_KEPT_COPY);
    expect(tooSmallLine("amazon.secondary", { width: 900, height: 675 })).toBe(
      `This photo is 900 by 675 pixels, too small for Amazon secondary images without enlarging it more than ${MAX_SOURCE_UPSCALE} times, so it will be left out there. Upload the original from your camera to include it.`,
    );
    expect(tooSmallLine("amazon.secondary")).toContain("This photo is too small for Amazon secondary images");
  });

  it("names Never enlarge my photo instead of the enlarge limit when the cap is 1", () => {
    const line = tooSmallLine("amazon.secondary", { width: 1400, height: 1400 }, 1);
    expect(line).toBe(
      "This photo is 1400 by 1400 pixels, too small for Amazon secondary images without enlarging it, since you chose Never enlarge my photo, so it will be left out there. Upload the original from your camera to include it.",
    );
    expect(line).not.toContain(String(MAX_SOURCE_UPSCALE));
    const conflict = { code: "too_small" as const, specId: "amazon.secondary", photoId: "p1" };
    const photos = [{ id: "p1", width: 1400, height: 1400 }];
    expect(conflictCopy(conflict, { background: "keep", photos, maxUpscale: 1 }).text).toBe(line);
    expect(conflictCopy(conflict, { background: "keep", photos }).text).toContain(
      `more than ${MAX_SOURCE_UPSCALE} times`,
    );
    expect(line).not.toMatch(/[–—→←]| - |->|=>/);
  });

  it("merges a Keep pack's heads up into one line per case", () => {
    const keep = resolved({ background: "keep", fit: "pad" }, "#FFFFFF", ["p1"]);
    const photos = [{ id: "p1", width: 400, height: 300, otherItems: true }];
    const specIds = ["amazon.main", "amazon.secondary", "ebay.listing", "google.merchant.lifestyle", "walmart.main"];
    const lines = conflictLines(conflictsFor(specIds, keep, photos), { background: "keep", photos });
    const codes = lines.map((line) => line.code);
    expect(codes.filter((code) => code === "white_required")).toHaveLength(2);
    expect(codes.filter((code) => code === "overlays_refused")).toHaveLength(1);
    expect(codes).toContain("borders_refused");
    expect(codes).toContain("other_items");
    expect(codes).toContain("too_small");
    const overlays = lines.find((line) => line.code === "overlays_refused");
    expect(overlays?.specIds).toEqual(["ebay.listing", "google.merchant.lifestyle"]);
    expect(overlays?.leaveOutLabel).toBe("Leave them out");
    for (const line of lines) {
      expect(line.text).not.toMatch(FORBIDDEN);
    }
  });
});

describe("color notes and pause copy", () => {
  it("keeps the Copy table rows word for word", () => {
    expect(FORCED_WHITE_NOTE).toBe("This channel needs pure white, so this file uses white instead of your color.");
    expect(KEEP_PHOTOS_PAUSED_COPY).toContain("Nothing will be charged.");
    expect(KEEP_PHOTOS_INSTEAD_LABEL).toBe("Keep my photos instead");
    expect(leftOutAfterPauseLine(["amazon.main", "walmart.main"])).toBe(
      "We left out Amazon main image and Walmart because they need the background removed.",
    );
    expect(leftOutAfterPauseLine(["google.merchant.main"])).toBe(
      "We left out Google main image because it needs the background removed.",
    );
    expect(leftOutAfterPauseLine([])).toBeNull();
    expect(OPTIONS_UNREADABLE_COPY).toBe("This pack's image choices could not be read, so nothing was charged. Please try again.");
    expect(OPTIONS_PAUSED_COPY).toBe("Image choices are paused right now, so this pack uses Marketplace ready.");
    // The pause banner keeps the promise the old one made.
    expect(PACKS_PAUSED_COPY).toContain("Nothing will be charged.");
  });

  it("keeps every string in the module plain spoken (rule 9)", () => {
    const strings = [
      FORCED_WHITE_NOTE,
      DARK_COLOR_EDGE_NOTE,
      SHOPIFY_SOFT_NOTE,
      KEEP_PHOTOS_PAUSED_COPY,
      KEEP_PHOTOS_INSTEAD_LABEL,
      OPTIONS_UNREADABLE_COPY,
      OPTIONS_PAUSED_COPY,
      OTHER_ITEMS_KEPT_COPY,
      SIZED_FOR_EACH_CHANNEL_TITLE,
      ...Object.values(LOOK_TITLES),
      ...Object.values(EXTRA_FAMILY_NAMES),
      leftOutAfterPauseLine(listSpecs().filter(requiresWhiteBackground).map((spec) => spec.id)) ?? "",
      whiteChannelsLine(listSpecs().map((spec) => spec.id)) ?? "",
    ];
    for (const text of strings) {
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(FORBIDDEN);
    }
  });
});
