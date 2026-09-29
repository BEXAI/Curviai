/**
 * PHASE_16 workstream 3 in the web app: the Pins, carousels and ads row in
 * Extra images (off by default, only in Everything), the estimate lines and
 * credits (one scene per carousel, founder decision 4), the skipped copy,
 * the job page's carousel and ads sections, and rule 9 on every new line.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeOutputOptions,
  planFlagsOf,
  resolveOutputOptions,
  type OutputOptionsInput,
} from "@curvi/pipeline/output-options";
import {
  AD_PLACEMENT_SHORT_REASON,
  ADS_NO_COPY_REASON,
  CAROUSEL_INCOMPLETE_REASON,
  CAROUSEL_TOO_SHORT_REASON,
} from "@curvi/pipeline/ads";
import { rule9Problems } from "@curvi/pipeline";
import { creditCosts } from "@curvi/pipeline/seed";
import { outputOptionsSummary, skippedCopy } from "@/lib/job-copy";
import { EXTRA_FAMILY_NAMES } from "@/lib/output-options-copy";
import {
  extraInBundle,
  extraRows,
  extrasOffCount,
  initialOutputForm,
  isResizeOnly,
  outputFormReducer,
} from "@/lib/output-options-form";
import { boardSections } from "@/lib/output-preview";
import { estimatePackCredits, referencePackShots } from "@/lib/pack-estimate";
import type { JobShotView } from "@/lib/services/types";

const SNAPSHOT = { colorHex: "#FFFFFF", brandSweepHex: "#3A4556", keepMediaIds: [] };

function flags(input: OutputOptionsInput) {
  return planFlagsOf(resolveOutputOptions(normalizeOutputOptions(input), SNAPSHOT), []);
}

describe("the ads row in Extra images", () => {
  it("is listed, plain spoken, and off by default", () => {
    const row = extraRows().find((r) => r.family === "ads");
    expect(row).toBeDefined();
    expect(rule9Problems(row!.title)).toEqual([]);
    expect(rule9Problems(row!.line)).toEqual([]);
    expect(row!.line).not.toMatch(/ - /);
    const state = initialOutputForm();
    expect(state.choices.extras.ads).toBeUndefined();
    expect(extrasOffCount(state.choices.extras)).toBe(0);
    expect(rule9Problems(EXTRA_FAMILY_NAMES.ads)).toEqual([]);
  });

  it("turns on only in Everything, and off again leaves the options as before", () => {
    const state = initialOutputForm();
    expect(extraInBundle(state, "ads")).toBe(true);
    const on = outputFormReducer(state, { type: "extra", family: "ads", on: true });
    expect(on.choices.extras.ads).toBe(true);
    const off = outputFormReducer(on, { type: "extra", family: "ads", on: false });
    expect(off.choices.extras).toEqual(state.choices.extras);
    const listing = outputFormReducer(state, { type: "bundle", bundle: "listing" });
    expect(extraInBundle(listing, "ads")).toBe(false);
    expect(outputFormReducer(listing, { type: "extra", family: "ads", on: true })).toBe(listing);
  });

  it("is not Resize only while the ads are on", () => {
    const keep = { background: "keep" as const, extras: { scenes: false, backdrops: false, transparentPng: false, graphics: false, cards: false } };
    expect(isResizeOnly(keep)).toBe(true);
    expect(isResizeOnly({ ...keep, extras: { ...keep.extras, ads: true } })).toBe(false);
  });
});

describe("the estimate with the ads formats", () => {
  const channels = ["meta", "pinterest", "tiktok"];

  it("adds nothing while the ads are off", () => {
    const off = estimatePackCredits(channels, "listing", "growth", { output: flags({}) });
    expect(off.lines.some((l) => /Carousel|Ads|Moodboard/.test(l.label))).toBe(false);
  });

  it("shows the carousel as one line and charges one scene for it with scenes on", () => {
    const scenes = estimatePackCredits(channels, "listing", "growth", { output: flags({ extras: { ads: true, scenes: true } }) });
    const carousel = scenes.lines.find((l) => l.label.startsWith("Carousel"));
    expect(carousel?.credits).toBe(creditCosts.generativeStill);
    expect(scenes.lines.some((l) => l.label.startsWith("Ads,"))).toBe(true);
    expect(scenes.lines.some((l) => l.label === "Moodboard pin")).toBe(true);
    const flat = estimatePackCredits(channels, "listing", "growth", { output: flags({ extras: { ads: true, scenes: false } }) });
    const slides = referencePackShots(channels, "listing", "growth", undefined, {
      output: flags({ extras: { ads: true, scenes: false } }),
    }).filter((s) => s.type === "carousel_slide").length;
    expect(flat.lines.find((l) => l.label.startsWith("Carousel"))?.credits).toBe(slides * creditCosts.deterministic);
    for (const line of scenes.lines) {
      expect(rule9Problems(line.label), line.label).toEqual([]);
    }
  });
});

describe("copy for the ads formats", () => {
  it("names every ads reason plainly and says it was not charged", () => {
    for (const [reason, type] of [
      [ADS_NO_COPY_REASON, "pin_moodboard"],
      [CAROUSEL_TOO_SHORT_REASON, "carousel_slide"],
      [CAROUSEL_INCOMPLETE_REASON, "carousel_slide"],
      [AD_PLACEMENT_SHORT_REASON, "ad_variant:meta.feed_4x5"],
    ] as const) {
      const copy = skippedCopy(reason, type);
      expect(copy.note, reason).toMatch(/No credits were charged/);
      expect(rule9Problems(copy.note)).toEqual([]);
      expect(rule9Problems(copy.label)).toEqual([]);
    }
  });

  it("lists the ads in the choices card only when the seller turned them on", () => {
    const context = { specIds: ["meta.feed_4x5"], photoCount: 1 };
    const off = outputOptionsSummary(resolveOutputOptions(normalizeOutputOptions({}), SNAPSHOT), context);
    expect(off.lines.join(" ")).not.toContain(EXTRA_FAMILY_NAMES.ads);
    const on = outputOptionsSummary(resolveOutputOptions(normalizeOutputOptions({ extras: { ads: true } }), SNAPSHOT), context);
    expect(on.lines).toContain(`Added: ${EXTRA_FAMILY_NAMES.ads}.`);
  });
});

describe("the job page sections", () => {
  const view = (shotId: string, shotType: string, status: JobShotView["status"] = "done"): JobShotView => ({
    shotId,
    shotType,
    providerStage: "",
    status,
    channels: [],
    credits: 0,
    compliance: null,
  });

  it("groups the carousel's slides and the ads, in plan order, and keeps the rest in the grid", () => {
    const sections = boardSections([
      view("s01", "amazon_main"),
      view("s20", "carousel_slide"),
      view("s21", "carousel_slide"),
      view("s30", "ad_variant"),
      view("s31", "ad_variant"),
      view("s40", "carousel_slide", "skipped"),
    ]);
    expect(sections.shots.map((s) => s.shotId)).toEqual(["s01", "s40"]);
    expect(sections.carousel.map((c) => [c.shot.shotId, c.title])).toEqual([
      ["s20", "Slide 1"],
      ["s21", "Slide 2"],
    ]);
    expect(sections.ads.map((c) => c.title)).toEqual(["Ad 1", "Ad 2"]);
  });
});
