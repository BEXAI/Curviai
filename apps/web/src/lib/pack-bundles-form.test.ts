/**
 * Pack bundles in the new pack form and the job page copy
 * (docs/phases/PHASE_16.md workstream 1): the bundle action, the Extra
 * images interplay with the Custom chip, the POST body and its idempotency
 * key, the card figures and the copy for BUNDLE_OFF_REASON.
 */
import { describe, expect, it } from "vitest";
import {
  BUNDLE_KEYS,
  BUNDLE_OFF_REASON,
  LOOK_PRESETS,
  compactExtras,
  normalizeOutputOptions,
  outputOptionsKey,
  resolveOutputOptions,
} from "@curvi/pipeline/output-options";
import { packBundles } from "@curvi/pipeline/seed";
import { BUNDLE_OFF_COPY, outputOptionsSummary, skippedCopy } from "@/lib/job-copy";
import { estimatePackCredits } from "@/lib/pack-estimate";
import {
  BUNDLE_CARD_COPY,
  EXTRA_OUTSIDE_BUNDLE_NOTE,
  bundleEstimates,
  bundleTitle,
  currentBundle,
  customChipText,
  effectiveChoices,
  extraInBundle,
  initialOutputForm,
  moreOptionsVisibility,
  nextLook,
  optionsIntentKey,
  outputFormReducer,
  outputOptionsBody,
  packCreatedOutputProps,
  planningPhotos,
  rememberedFormState,
  resolveFormOutput,
  type OutputFormState,
} from "@/lib/output-options-form";
import { outputEstimateInputs } from "@/lib/services/output-options";

const CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];
const RULE_9 = /[–—←-⇿]| - |\p{Extended_Pictographic}/u;

function picked(bundle: (typeof BUNDLE_KEYS)[number], state: OutputFormState = initialOutputForm()): OutputFormState {
  return outputFormReducer(state, { type: "bundle", bundle });
}

describe("the bundle action", () => {
  it("starts on today's pack", () => {
    expect(currentBundle(initialOutputForm())).toBe("everything");
  });

  it("moves the Extra images switches to the bundle's start and keeps the look", () => {
    const listing = picked("listing");
    expect(listing.lookBase).toBe("marketplace");
    expect(listing.choices.bundle).toBe("listing");
    expect(listing.choices.extras).toEqual(compactExtras(packBundles.listing.extras));
    expect(customChipText(listing)).toBeNull();
    const back = picked("everything", listing);
    expect(back.choices).toEqual(initialOutputForm().choices);
    expect("bundle" in back.choices).toBe(false);
  });

  it("keeps the color, the photo shape and the More options", () => {
    let state = outputFormReducer(initialOutputForm(), { type: "color", color: { kind: "swatch", key: "sand" } });
    state = outputFormReducer(state, { type: "more", patch: { productSize: "larger" } });
    state = picked("main", state);
    expect(state.choices.color).toEqual({ kind: "swatch", key: "sand" });
    expect(state.more.productSize).toBe("larger");
  });

  it("keeps every extra off with Keep my photo", () => {
    const keep = outputFormReducer(initialOutputForm(), { type: "look", look: "keep_photo" });
    for (const bundle of BUNDLE_KEYS) {
      const state = picked(bundle, keep);
      expect(Object.values(state.choices.extras).every((on) => !on), bundle).toBe(true);
      expect(customChipText(state), bundle).toBeNull();
    }
  });

  it("shows the Custom chip once an extra leaves the bundle's start, and Reset returns to it", () => {
    const listing = picked("listing");
    const custom = outputFormReducer(listing, { type: "extra", family: "scenes", on: false });
    expect(customChipText(custom)).toBe("Custom, started from Marketplace ready");
    const reset = outputFormReducer(custom, { type: "reset" });
    expect(reset.choices).toEqual(listing.choices);
    expect(customChipText(reset)).toBeNull();
  });

  it("keeps the bundle when the look or the switch changes", () => {
    const listing = picked("listing");
    const keep = outputFormReducer(listing, { type: "look", look: "keep_photo" });
    expect(keep.choices.bundle).toBe("listing");
    const removed = outputFormReducer(keep, { type: "background", background: "remove" });
    expect(removed.choices.extras).toEqual(compactExtras(packBundles.listing.extras));
    const instead = outputFormReducer(listing, { type: "keep_instead" });
    expect(instead.choices.bundle).toBe("listing");
    expect(instead.lookBase).toBe("keep_photo");
  });

  it("never turns on a family the bundle holds nothing of", () => {
    const main = picked("main");
    expect(extraInBundle(main, "scenes")).toBe(false);
    expect(outputFormReducer(main, { type: "extra", family: "scenes", on: true })).toBe(main);
    expect(outputFormReducer(main, { type: "scenes", count: 2 })).toBe(main);
    expect(moreOptionsVisibility(main.choices).sceneCount).toBe(false);
    const listing = picked("listing");
    expect(extraInBundle(listing, "cards")).toBe(false);
    expect(extraInBundle(listing, "scenes")).toBe(true);
    expect(moreOptionsVisibility(listing.choices).sceneCount).toBe(true);
  });
});

describe("the POST body with a bundle", () => {
  it("sends no bundle for today's pack, so the body and key stay as before", () => {
    const today = initialOutputForm();
    const body = outputOptionsBody(today.lookBase, today.choices, today.more);
    expect("bundle" in body).toBe(false);
    expect(optionsIntentKey(today.choices, today.more)).toBe(outputOptionsKey(null));
  });

  it("sends the picked bundle, and the key matches the server's for it", () => {
    for (const bundle of BUNDLE_KEYS.filter((key) => key !== "everything")) {
      const state = picked(bundle);
      const body = outputOptionsBody(state.lookBase, state.choices, state.more);
      expect(body.bundle).toBe(bundle);
      expect(optionsIntentKey(state.choices, state.more)).toBe(outputOptionsKey({ bundle }));
    }
  });

  it("carries the bundle in pack_created", () => {
    const state = picked("aplus");
    expect(packCreatedOutputProps(state.lookBase, state.choices, 0).bundle).toBe("aplus");
    expect(packCreatedOutputProps("marketplace", LOOK_PRESETS.marketplace, 0).bundle).toBe("everything");
  });

  it("prefills a remembered bundle", () => {
    const stored = { ...normalizeOutputOptions({ bundle: "listing" }) };
    const state = rememberedFormState(stored, { brandColorCount: 0 });
    expect(state?.choices.bundle).toBe("listing");
    expect(state && customChipText(state)).toBeNull();
    expect(rememberedFormState({ ...normalizeOutputOptions({}) }, { brandColorCount: 0 })).toBeNull();
    expect(rememberedFormState({ bundle: "most" }, { brandColorCount: 0 })).toBeNull();
  });
});

describe("bundle card figures", () => {
  const photos = planningPhotos([]);
  const seller = { angles: [], hasBoxContents: false, hasComparisonFacts: false };
  const args = (state: OutputFormState) => ({
    channels: CHANNELS,
    mode: "listing" as const,
    tier: "growth" as const,
    seller,
    state,
    brandColors: [],
    brandKitsAllowed: false,
    photos: [],
    planned: photos,
  });

  function packTotal(state: OutputFormState): number {
    const { resolved } = resolveFormOutput({
      choices: effectiveChoices(state.choices),
      lookBase: state.lookBase,
      brandColors: [],
      brandKitsAllowed: false,
      photos,
      more: state.more,
    });
    return estimatePackCredits(CHANNELS, "listing", "growth", { ...seller, ...outputEstimateInputs(resolved, []) }).total;
  }

  it("shows today's figure on Everything and the pack's figure on the picked card", () => {
    const today = initialOutputForm();
    const figures = bundleEstimates(args(today));
    expect(figures.everything).toBe(estimatePackCredits(CHANNELS, "listing", "growth", seller).total);
    const custom = outputFormReducer(picked("listing"), { type: "extra", family: "scenes", on: false });
    expect(bundleEstimates(args(custom)).listing).toBe(packTotal(custom));
  });

  it("orders the figures from the smallest set to the largest", () => {
    const figures = bundleEstimates(args(initialOutputForm()));
    expect(figures.main).toBeGreaterThan(0);
    expect(figures.main).toBeLessThanOrEqual(figures.aplus);
    expect(figures.main).toBeLessThan(figures.listing);
    expect(figures.listing).toBeLessThanOrEqual(figures.everything);
  });
});

describe("bundle copy", () => {
  it("titles each card with the seeded label and writes rule 9 copy", () => {
    for (const bundle of BUNDLE_KEYS) {
      expect(bundleTitle(bundle)).toBe(packBundles[bundle].label);
      expect(BUNDLE_CARD_COPY[bundle]).not.toMatch(RULE_9);
    }
    expect(EXTRA_OUTSIDE_BUNDLE_NOTE).not.toMatch(RULE_9);
  });

  it("moves through the cards with the arrow keys", () => {
    expect(nextLook("main", "ArrowRight", BUNDLE_KEYS)).toBe("listing");
    expect(nextLook("main", "ArrowLeft", BUNDLE_KEYS)).toBe("everything");
  });

  it("explains a shot outside the set", () => {
    expect(skippedCopy(BUNDLE_OFF_REASON, "lifestyle")).toEqual(BUNDLE_OFF_COPY);
    expect(BUNDLE_OFF_COPY.note).toBe("Not in the set you picked. Not charged.");
    expect(BUNDLE_OFF_COPY.label).not.toMatch(RULE_9);
  });

  it("names the set on the job page and lists only the extras the set holds as turned off", () => {
    const stored = resolveOutputOptions(normalizeOutputOptions({ bundle: "listing", extras: { scenes: false } }), {
      colorHex: "#FFFFFF",
      brandSweepHex: "#FFFFFF",
      keepMediaIds: [],
    });
    const { lines } = outputOptionsSummary(stored, { specIds: CHANNELS });
    expect(lines).toContain("Set: Listing set.");
    expect(lines).toContain("Turned off: lifestyle scenes.");
    const today = outputOptionsSummary(null, { specIds: CHANNELS });
    expect(today.lines.some((line) => line.startsWith("Set:"))).toBe(false);
  });
});
