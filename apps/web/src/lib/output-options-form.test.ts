import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_OPTIONS,
  EXTRA_FAMILY_KEYS,
  LOOK_PRESETS,
  MAX_SOURCE_UPSCALE,
  OutputOptionsInput,
  outputOptionsKey,
  type OutputPlanFlags,
} from "@curvi/pipeline/output-options";
import {
  backgroundSwatches,
  creditCosts,
  keepBackgroundPhrases,
  presets,
  sceneCountOptions,
  stillStyle,
} from "@curvi/pipeline/seed";
import { getSpec, listSpecs, requiresWhiteBackground } from "@curvi/specs";
import { intentFor } from "@/lib/submit-intent";
import { DARK_COLOR_EDGE_NOTE, leftOutAfterPauseLine } from "@/lib/output-options-copy";
import {
  CUSTOM_COLOR_ERROR,
  DEFAULT_MORE_CHOICES,
  EDGE_MATCH_CHIP,
  EDGE_MATCH_LABEL,
  EDGE_MATCH_PREVIEW_NOTE,
  GRAPHICS_COLOR_HELPER,
  GRAPHICS_COLOR_LABEL,
  KEEP_BACKGROUND_HINT,
  KEEP_BACKGROUND_HINT_ACTION,
  LOGO_LABEL,
  LOOK_CARD_COPY,
  NEVER_ENLARGE_HELPER,
  NEVER_ENLARGE_LABEL,
  PHOTO_BACKGROUND_OPTIONS,
  PHOTO_SHAPE_OPTIONS,
  PRODUCT_SIZE_LABEL,
  PRODUCT_SIZE_OPTIONS,
  RECENT_CUSTOM_STORAGE_KEY,
  REMEMBERED_RESET_LABEL,
  SCENES_OFF,
  SCENE_COUNT_LABEL,
  SCENE_STYLE_LABEL,
  TRIM_SHAPE_OPTION,
  formFit,
  framePicture,
  isPhotoBackground,
  isScenePresetChoice,
  keepBackgroundHint,
  moreOptionsVisibility,
  noteAsksToKeepBackground,
  p1OutputFields,
  photoBackgroundLabel,
  rememberedFormState,
  rememberedLine,
  sceneCountFromValue,
  sceneCountSelectOptions,
  sceneCountValue,
  sceneStyleOptions,
  uploadBackgroundField,
  addedSpaceSpecIds,
  backgroundSummaryLine,
  brandLookAvailability,
  colorChoiceFromValue,
  colorOptions,
  colorValue,
  EDGE_MATCH_VALUE,
  conflictContextOf,
  customChipText,
  darkColorNote,
  effectiveChoices,
  extraRows,
  extrasOffCount,
  formConflicts,
  formPhotos,
  holdLine,
  initialOutputForm,
  isResizeOnly,
  leaveOut,
  lookDifferenceLine,
  moreOptionsChanged,
  moreOptionsSummary,
  nextLook,
  optionsIntentKey,
  outputFormReducer,
  outputOptionsBody,
  packCreatedOutputProps,
  packLookChangedProps,
  parseCustomHex,
  pauseBlocksSubmit,
  planningPhotos,
  previewFrames,
  readRecentCustomColors,
  rememberCustomColor,
  resolveFormOutput,
  rowConflicts,
  switchHelper,
  totalLine,
  usableBrandColors,
  withoutWhiteRequired,
  writeRecentCustomColors,
  type OutputFormState,
} from "./output-options-form";

const RULE_9 = /[‒-―←-⇿➔➡]| - |->|\p{Extended_Pictographic}/u;
const DEFAULT_CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];

function reduce(...actions: Parameters<typeof outputFormReducer>[1][]): OutputFormState {
  return actions.reduce(outputFormReducer, initialOutputForm());
}

function flagsFor(state: OutputFormState, photoIds: string[] = ["p1"]): OutputPlanFlags {
  return resolveFormOutput({
    choices: state.choices,
    brandColors: [],
    brandKitsAllowed: false,
    photos: photoIds.map((id, i) => ({ id, ...(i === 0 ? { angle: "front" as const } : {}) })),
  }).flags;
}

describe("the output options reducer", () => {
  it("starts on Marketplace ready, today's pack", () => {
    const state = initialOutputForm();
    expect(state.lookBase).toBe("marketplace");
    expect(outputOptionsKey(state.choices)).toBe(outputOptionsKey(DEFAULT_OUTPUT_OPTIONS));
    expect(customChipText(state)).toBeNull();
  });

  it("applies a look card's preset exactly", () => {
    for (const look of ["marketplace", "keep_photo", "brand"] as const) {
      const state = reduce({ type: "look", look });
      expect(state.lookBase).toBe(look);
      expect(state.choices).toEqual(LOOK_PRESETS[look]);
      expect(customChipText(state)).toBeNull();
    }
  });

  it("resets the extras to the switch's side when the switch flips, and keeps the color", () => {
    const sand = { kind: "swatch", key: "sand" } as const;
    const off = reduce({ type: "color", color: sand }, { type: "background", background: "keep" });
    expect(off.choices.background).toBe("keep");
    expect(EXTRA_FAMILY_KEYS.every((f) => !off.choices.extras[f])).toBe(true);
    expect(off.choices.color).toEqual(sand);
    const on = reduce({ type: "look", look: "keep_photo" }, { type: "extra", family: "scenes", on: true }, {
      type: "background",
      background: "remove",
    });
    // Every family but ads, which starts off in every look (PHASE_16 workstream 3).
    expect(EXTRA_FAMILY_KEYS.filter((f) => f !== "ads").every((f) => on.choices.extras[f])).toBe(true);
    expect(on.choices.extras.ads).toBeUndefined();
    // Flipping to the side it is already on changes nothing.
    const same = initialOutputForm();
    expect(outputFormReducer(same, { type: "background", background: "remove" })).toBe(same);
  });

  it("shows the Custom chip once a choice leaves the card, and Reset goes back", () => {
    const custom = reduce({ type: "look", look: "keep_photo" }, { type: "extra", family: "scenes", on: true });
    expect(customChipText(custom)).toBe("Custom, started from Keep my photo");
    const reset = outputFormReducer(custom, { type: "reset" });
    expect(reset.choices).toEqual(LOOK_PRESETS.keep_photo);
    expect(customChipText(reset)).toBeNull();
  });

  it("switches to Keep with every extra off for Keep my photos instead", () => {
    const state = reduce({ type: "color", color: { kind: "swatch", key: "sage" } }, { type: "keep_instead" });
    expect(state.lookBase).toBe("keep_photo");
    expect(state.choices).toEqual(LOOK_PRESETS.keep_photo);
  });

  it("sets the photo shape and counts it under More options", () => {
    const keep = reduce({ type: "look", look: "keep_photo" });
    expect(moreOptionsChanged(keep)).toBe(0);
    expect(moreOptionsSummary(0)).toBe("More options");
    const pad = outputFormReducer(keep, { type: "fit", fit: "pad" });
    expect(pad.choices.fit).toBe("pad");
    expect(moreOptionsChanged(pad)).toBe(1);
    expect(moreOptionsSummary(1)).toBe("More options, 1 changed");
    expect(PHOTO_SHAPE_OPTIONS.map((o) => o.value)).toEqual(["auto", "pad"]);
  });

  it("does not count a scene count the body leaves out while scenes are paused", () => {
    const state = reduce({ type: "scenes", count: 2 });
    expect(moreOptionsChanged(state)).toBe(1);
    expect(moreOptionsChanged(state, { scenesPaused: true })).toBe(0);
    const body = outputOptionsBody(state.lookBase, effectiveChoices(state.choices, { scenesPaused: true }), state.more);
    expect(body.sceneCount).toBeUndefined();
  });

  it("gives the conflict copy the enlarge cap of the resolved options", () => {
    expect(conflictContextOf("keep", [], { enlarge: false }).maxUpscale).toBe(1);
    expect(conflictContextOf("keep", []).maxUpscale).toBe(MAX_SOURCE_UPSCALE);
  });
});

describe("effective choices", () => {
  it("forces scenes off while scenes are paused, without touching the seller's pick", () => {
    const state = initialOutputForm();
    const effective = effectiveChoices(state.choices, { scenesPaused: true });
    expect(effective.extras.scenes).toBe(false);
    expect(state.choices.extras.scenes).toBe(true);
  });

  it("uses today's pack in concept mode", () => {
    const keep = reduce({ type: "look", look: "keep_photo" });
    expect(outputOptionsKey(effectiveChoices(keep.choices, { conceptMode: true }))).toBe(
      outputOptionsKey(DEFAULT_OUTPUT_OPTIONS),
    );
  });
});

describe("the idempotency intent", () => {
  const fields = (details: string) => ({
    productId: "new",
    channels: DEFAULT_CHANNELS,
    mode: "listing",
    uploadKey: null,
    newProductTitle: "",
    description: "",
    details,
  });
  let n = 0;
  const key = () => `key_${++n}`;

  it("changes with the switch and with the color, and not with the look card alone", () => {
    const base = initialOutputForm();
    const first = intentFor(null, fields(optionsIntentKey(base.choices)), key);
    const keep = outputFormReducer(base, { type: "background", background: "keep" });
    expect(intentFor(first, fields(optionsIntentKey(keep.choices)), key).key).not.toBe(first.key);
    const sand = outputFormReducer(base, { type: "color", color: { kind: "swatch", key: "sand" } });
    expect(intentFor(first, fields(optionsIntentKey(sand.choices)), key).key).not.toBe(first.key);
    const custom = outputFormReducer(base, { type: "color", color: { kind: "custom", hex: "#1F2A44" } });
    const custom2 = outputFormReducer(base, { type: "color", color: { kind: "custom", hex: "#1F2A45" } });
    expect(optionsIntentKey(custom.choices)).not.toBe(optionsIntentKey(custom2.choices));
    // Picking Marketplace ready again is the same pack, so the same key.
    const again = outputFormReducer(base, { type: "look", look: "marketplace" });
    expect(intentFor(first, fields(optionsIntentKey(again.choices)), key).key).toBe(first.key);
  });

  it("sends the choices with the card they started from", () => {
    const state = reduce({ type: "look", look: "keep_photo" }, { type: "fit", fit: "pad" });
    const body = outputOptionsBody(state.lookBase, state.choices);
    expect(body).toMatchObject({ v: 1, lookBase: "keep_photo", background: "keep", fit: "pad" });
    // With every P1 control at its default the body is a P0 body.
    expect(outputOptionsKey(body as OutputOptionsInput)).toBe(optionsIntentKey(state.choices));
  });
});

describe("Leave it out and the cutout pause", () => {
  it("unticks exactly the named channels", () => {
    expect(leaveOut(DEFAULT_CHANNELS, ["amazon.main"])).toEqual(["amazon.secondary", "shopify.product", "meta.feed_1x1"]);
    expect(leaveOut(DEFAULT_CHANNELS, [])).toEqual(DEFAULT_CHANNELS);
  });

  it("leaves out every white required channel for Keep my photos instead, and names them", () => {
    const picked = [...DEFAULT_CHANNELS, "walmart.main", "etsy.listing"];
    const { selected, leftOut } = withoutWhiteRequired(picked);
    expect(leftOut).toEqual(picked.filter((id) => requiresWhiteBackground(getSpec(id))));
    expect(selected.some((id) => requiresWhiteBackground(getSpec(id)))).toBe(false);
    expect(leftOutAfterPauseLine(leftOut)).toBe(
      "We left out Amazon main image and Walmart because they need the background removed.",
    );
  });

  it("blocks submit while paused only when the pack needs a cutout", () => {
    const remove = initialOutputForm();
    const keep = reduce({ type: "look", look: "keep_photo" });
    expect(pauseBlocksSubmit(false, DEFAULT_CHANNELS, flagsFor(remove))).toBe(false);
    expect(pauseBlocksSubmit(true, DEFAULT_CHANNELS, flagsFor(remove))).toBe(true);
    // Keep with Amazon main picked still needs a made white file.
    expect(pauseBlocksSubmit(true, DEFAULT_CHANNELS, flagsFor(keep))).toBe(true);
    const noWhite = withoutWhiteRequired(DEFAULT_CHANNELS).selected;
    expect(pauseBlocksSubmit(true, noWhite, flagsFor(keep))).toBe(false);
    // Any extra needs a cut out copy.
    const keepScenes = outputFormReducer(keep, { type: "extra", family: "scenes", on: true });
    expect(pauseBlocksSubmit(true, noWhite, flagsFor(keepScenes))).toBe(true);
    // With no photo yet, the first photo is judged as the front one.
    expect(pauseBlocksSubmit(true, noWhite, { ...flagsFor(keep), photos: [], keepMediaIds: [] })).toBe(false);
    expect(pauseBlocksSubmit(true, DEFAULT_CHANNELS, { ...flagsFor(keep), photos: [], keepMediaIds: [] })).toBe(true);
  });

  it("lets a paused pack start when every photo it cuts out already has its upload cutout", () => {
    const remove = flagsFor(initialOutputForm(), ["p1", "p2"]);
    expect(pauseBlocksSubmit(true, DEFAULT_CHANNELS, remove, new Set(["p1", "p2"]))).toBe(false);
    expect(pauseBlocksSubmit(true, DEFAULT_CHANNELS, remove, new Set(["p1"]))).toBe(true);
    expect(pauseBlocksSubmit(true, DEFAULT_CHANNELS, remove, new Set())).toBe(true);
  });
});

describe("photos and conflicts", () => {
  it("counts the uploads, else the stored photos", () => {
    expect(formPhotos([{ id: "a" }, { id: "b" }], 5, 6).map((p) => p.id)).toEqual(["a", "b"]);
    expect(formPhotos([], 2, 6).map((p) => p.id)).toEqual(["stored_photo_1", "stored_photo_2"]);
    expect(formPhotos([], 9, 6)).toHaveLength(6);
    expect(formPhotos([], 0, 6)).toEqual([]);
    expect(planningPhotos([])).toHaveLength(1);
  });

  it("finds conflicts only for real ones", () => {
    const photos = planningPhotos([]);
    const today = resolveFormOutput({ choices: initialOutputForm().choices, brandColors: [], brandKitsAllowed: false, photos });
    expect(formConflicts(DEFAULT_CHANNELS, today.resolved, photos)).toEqual([]);
    const keep = resolveFormOutput({
      choices: reduce({ type: "look", look: "keep_photo" }).choices,
      brandColors: [],
      brandKitsAllowed: false,
      photos,
    });
    const conflicts = formConflicts(DEFAULT_CHANNELS, keep.resolved, photos);
    expect(conflicts).toEqual([{ code: "white_required", specId: "amazon.main" }]);
    expect(rowConflicts(conflicts, "amazon.main")).toHaveLength(1);
    expect(rowConflicts(conflicts, "shopify.product")).toHaveLength(0);
    expect(conflictContextOf("keep", [{ id: "x", width: 900, height: null }])).toEqual({
      background: "keep",
      maxUpscale: MAX_SOURCE_UPSCALE,
      photos: [{ id: "x", width: 900 }],
    });
  });

  it("reports a kept photo too small for a channel from its preflight size", () => {
    const photos = [{ id: "p1", angle: "front" as const, width: 400, height: 300 }];
    const keep = resolveFormOutput({
      choices: reduce({ type: "look", look: "keep_photo" }).choices,
      brandColors: [],
      brandKitsAllowed: false,
      photos,
    });
    const codes = formConflicts(["amazon.secondary"], keep.resolved, photos).map((c) => c.code);
    expect(codes).toContain("too_small");
  });

  it("falls back to white when a brand color cannot be given", () => {
    const brand = reduce({ type: "look", look: "brand" });
    const photos = planningPhotos([]);
    const missing = resolveFormOutput({ choices: brand.choices, brandColors: [], brandKitsAllowed: true, photos });
    expect(missing.resolved.colorHex).toBe(stillStyle.whiteHex);
    const given = resolveFormOutput({ choices: brand.choices, brandColors: ["#1f2a44"], brandKitsAllowed: true, photos });
    expect(given.resolved.colorHex).toBe("#1F2A44");
  });

  it("knows where a kept photo gets added space", () => {
    const keep = reduce({ type: "look", look: "keep_photo" }).choices;
    expect(addedSpaceSpecIds(["amazon.secondary", "shopify.product"], keep)).toEqual([]);
    expect(addedSpaceSpecIds(["meta.story_9x16"], keep)).toEqual(["meta.story_9x16"]);
    expect(addedSpaceSpecIds(["shopify.product"], { ...keep, fit: "pad" })).toEqual(["shopify.product"]);
    // eBay refuses added borders, so pad keeps the photo's shape there.
    expect(addedSpaceSpecIds(["ebay.listing"], { ...keep, fit: "pad" })).toEqual([]);
    expect(addedSpaceSpecIds(["meta.story_9x16"], initialOutputForm().choices)).toEqual([]);
  });
});

describe("colors", () => {
  it("round trips the Select values", () => {
    for (const key of Object.keys(backgroundSwatches) as (keyof typeof backgroundSwatches)[]) {
      expect(colorChoiceFromValue(colorValue({ kind: "swatch", key }))).toEqual({ kind: "swatch", key });
    }
    expect(colorChoiceFromValue(colorValue({ kind: "brand", index: 2 }))).toEqual({ kind: "brand", index: 2 });
    expect(colorValue({ kind: "custom", hex: "#1F2A44" })).toBe("custom");
    expect(colorChoiceFromValue("custom")).toBeNull();
    expect(colorChoiceFromValue("brand:6")).toBeNull();
    expect(colorChoiceFromValue("swatch:slate")).toBeNull();
  });

  it("lists the seeded colors, then brand colors only when the plan includes kits", () => {
    const groups = colorOptions(["#1f2a44", "nope"], true);
    expect(groups.swatches.map((o) => o.label)).toEqual(Object.values(backgroundSwatches).map((s) => s.label));
    expect(groups.brand).toEqual([{ value: "brand:0", label: "Brand color 1, #1F2A44", hex: "#1F2A44" }]);
    expect(colorOptions(["#1f2a44"], false).brand).toEqual([]);
    expect(usableBrandColors(["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777"])).toHaveLength(6);
  });

  it("validates the custom hex with the plan's error line", () => {
    expect(parseCustomHex("#1f2a44")).toEqual({ ok: true, hex: "#1F2A44" });
    expect(parseCustomHex(" 1F2A44 ")).toEqual({ ok: true, hex: "#1F2A44" });
    for (const bad of ["#FFF", "red", "#GGGGGG", "", "#1F2A445"]) {
      expect(parseCustomHex(bad)).toEqual({ ok: false, error: CUSTOM_COLOR_ERROR });
    }
    expect(CUSTOM_COLOR_ERROR).toBe("Use a color code like #1F2A44.");
  });

  it("remembers the last three custom colors, each once", () => {
    let recent: string[] = [];
    for (const hex of ["#111111", "#222222", "#111111", "#333333", "#444444"]) {
      recent = rememberCustomColor(recent, hex);
    }
    expect(recent).toEqual(["#444444", "#333333", "#111111"]);
  });

  it("reads and writes storage inside try and catch", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    writeRecentCustomColors(storage, ["#111111", "#222222"]);
    expect(readRecentCustomColors(storage)).toEqual(["#111111", "#222222"]);
    store.set(RECENT_CUSTOM_STORAGE_KEY, "not json");
    expect(readRecentCustomColors(storage)).toEqual([]);
    store.set(RECENT_CUSTOM_STORAGE_KEY, JSON.stringify(["#111111", 5, "red"]));
    expect(readRecentCustomColors(storage)).toEqual(["#111111"]);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readRecentCustomColors(throwing)).toEqual([]);
    expect(() => writeRecentCustomColors(throwing, ["#111111"])).not.toThrow();
    expect(readRecentCustomColors(null)).toEqual([]);
  });

  it("warns about a light edge only for a dark custom or brand color with Remove", () => {
    expect(darkColorNote({ kind: "custom", hex: "#1B1F24" }, "#1B1F24", "remove")).toBe(DARK_COLOR_EDGE_NOTE);
    expect(darkColorNote({ kind: "brand", index: 0 }, "#1B1F24", "remove")).toBe(DARK_COLOR_EDGE_NOTE);
    expect(darkColorNote({ kind: "custom", hex: "#F3F1ED" }, "#F3F1ED", "remove")).toBeNull();
    expect(darkColorNote({ kind: "custom", hex: "#1B1F24" }, "#1B1F24", "keep")).toBeNull();
    expect(darkColorNote({ kind: "swatch", key: "white" }, "#FFFFFF", "remove")).toBeNull();
  });
});

describe("looks, extras and the summary", () => {
  it("disables Brand look with a reason from the seed", () => {
    expect(brandLookAvailability("growth", ["#1F2A44"])).toEqual({ available: true });
    expect(brandLookAvailability("free", ["#1F2A44"])).toMatchObject({
      available: false,
      text: "Brand kits come with the Starter plan.",
      href: "/app/billing",
    });
    expect(brandLookAvailability("growth", [])).toMatchObject({
      available: false,
      text: "Add a brand color first.",
      href: "/app/brand",
    });
  });

  it("moves the look with the arrow keys, skipping disabled cards", () => {
    const all = ["marketplace", "keep_photo", "brand"] as const;
    expect(nextLook("marketplace", "ArrowRight", all)).toBe("keep_photo");
    expect(nextLook("brand", "ArrowDown", all)).toBe("marketplace");
    expect(nextLook("marketplace", "ArrowLeft", all)).toBe("brand");
    expect(nextLook("keep_photo", "ArrowRight", ["marketplace", "keep_photo"])).toBe("marketplace");
    expect(nextLook("keep_photo", "Home", all)).toBe("marketplace");
    expect(nextLook("keep_photo", "End", all)).toBe("brand");
    expect(nextLook("keep_photo", "a", all)).toBeNull();
  });

  it("prices the extra rows from creditCosts", () => {
    const rows = extraRows();
    expect(rows.map((r) => r.family)).toEqual([...EXTRA_FAMILY_KEYS]);
    const one = (n: number) => `${n} ${n === 1 ? "credit" : "credits"}`;
    expect(rows[0].line).toContain(`About ${one(creditCosts.generativeStill)} each`);
    expect(rows[1].line).toContain(`${one(creditCosts.deterministic)} each`);
  });

  it("counts extras off and spots Resize only", () => {
    const keep = LOOK_PRESETS.keep_photo;
    expect(extrasOffCount(keep.extras)).toBe(5);
    expect(isResizeOnly(keep)).toBe(true);
    expect(isResizeOnly({ ...keep, extras: { ...keep.extras, cards: true } })).toBe(false);
    expect(isResizeOnly(LOOK_PRESETS.marketplace)).toBe(false);
  });

  it("writes the summary lines", () => {
    expect(backgroundSummaryLine(LOOK_PRESETS.keep_photo, "#FFFFFF")).toBe("Background: kept as you took it");
    expect(backgroundSummaryLine({ ...LOOK_PRESETS.marketplace, color: { kind: "swatch", key: "warm_white" } }, "#F3F1ED")).toBe(
      "Background: removed, on warm white",
    );
    expect(holdLine(2)).toBe("We hold 2 credits and give back what is not used.");
    expect(holdLine(0)).toBeNull();
    expect(totalLine(1)).toBe("About 1 credit");
    expect(lookDifferenceLine(2, 7)).toBe("Keep my photo uses 5 fewer credits than Marketplace ready for this pack.");
    expect(lookDifferenceLine(7, 7)).toBeNull();
    expect(lookDifferenceLine(8, 7)).toBeNull();
  });

  it("builds the preview frames from the pick", () => {
    const frames = previewFrames([...DEFAULT_CHANNELS, "meta.story_9x16"]);
    expect(frames.map((f) => f.specId)).toEqual(["amazon.main", "amazon.secondary", "meta.story_9x16"]);
    expect(frames[0]).toMatchObject({ label: "Stays white", white: true });
    expect(frames[2]).toMatchObject({ label: "Meta story, 1080 by 1920", width: 1080, height: 1920 });
    expect(previewFrames([])).toEqual([]);
  });
});

describe("analytics", () => {
  it("sends enums and counts only, never a hex", () => {
    const state = reduce({ type: "look", look: "keep_photo" }, { type: "color", color: { kind: "custom", hex: "#1F2A44" } });
    const props = packCreatedOutputProps(state.lookBase, state.choices, 3);
    expect(props).toEqual({
      look: "custom",
      look_base: "keep_photo",
      background: "keep",
      color_kind: "custom",
      extras_off: 5,
      kept_photos: 3,
      fit: "auto",
      bundle: "everything",
    });
    expect(JSON.stringify(props)).not.toMatch(/#[0-9A-F]{6}/i);
    // The caller counts kept photos after each photo's own background, so a
    // Remove pack can keep one (P1 per photo Background Select).
    expect(packCreatedOutputProps("marketplace", LOOK_PRESETS.marketplace, 0).kept_photos).toBe(0);
    expect(packCreatedOutputProps("marketplace", LOOK_PRESETS.marketplace, 1).kept_photos).toBe(1);
    expect(packLookChangedProps("marketplace", "keep_photo")).toEqual({ from: "marketplace", to: "keep_photo" });
    expect(packLookChangedProps("brand", "brand")).toBeNull();
  });
});

describe("copy (rule 9)", () => {
  it("has no emoji, arrows, en or em dashes, or spaced hyphens", () => {
    const lines = [
      ...Object.values(LOOK_CARD_COPY),
      switchHelper("remove"),
      switchHelper("keep"),
      ...extraRows().flatMap((r) => [r.title, r.line]),
      ...PHOTO_SHAPE_OPTIONS.map((o) => o.label),
      ...previewFrames(listSpecs().map((s) => s.id)).map((f) => f.label),
      CUSTOM_COLOR_ERROR,
      customChipText(reduce({ type: "look", look: "keep_photo" }, { type: "fit", fit: "pad" })) ?? "",
    ];
    for (const line of lines) {
      expect(line, line).not.toMatch(RULE_9);
    }
  });

  it("keeps the P1 copy plain too", () => {
    const lines = [
      TRIM_SHAPE_OPTION.label,
      TRIM_SHAPE_OPTION.helper,
      SCENE_COUNT_LABEL,
      SCENE_STYLE_LABEL,
      LOGO_LABEL,
      PRODUCT_SIZE_LABEL,
      NEVER_ENLARGE_LABEL,
      NEVER_ENLARGE_HELPER,
      GRAPHICS_COLOR_LABEL,
      GRAPHICS_COLOR_HELPER,
      EDGE_MATCH_LABEL,
      EDGE_MATCH_CHIP,
      EDGE_MATCH_PREVIEW_NOTE,
      KEEP_BACKGROUND_HINT,
      KEEP_BACKGROUND_HINT_ACTION,
      REMEMBERED_RESET_LABEL,
      rememberedLine("Ceramic mug"),
      photoBackgroundLabel(2),
      ...PHOTO_BACKGROUND_OPTIONS.map((o) => o.label),
      ...PRODUCT_SIZE_OPTIONS.map((o) => o.label),
      ...sceneStyleOptions().map((o) => o.label),
      ...sceneCountSelectOptions().map((o) => o.label),
    ];
    for (const line of lines) {
      expect(line, line).not.toMatch(RULE_9);
    }
    expect(KEEP_BACKGROUND_HINT).toBe(
      "It sounds like you want to keep your background. Turn off Remove the background?",
    );
    expect(rememberedLine("Ceramic mug")).toBe("Using your last choices for Ceramic mug.");
    expect(REMEMBERED_RESET_LABEL).toBe("Start from Marketplace ready");
  });
});

describe("P1 controls", () => {
  const keep = () => reduce({ type: "look", look: "keep_photo" });

  it("keeps today's body and key while every P1 control is at its default", () => {
    const state = initialOutputForm();
    expect(state.more).toEqual(DEFAULT_MORE_CHOICES);
    expect(DEFAULT_MORE_CHOICES.sceneCount).toBe(sceneCountOptions.default);
    const body = outputOptionsBody(state.lookBase, state.choices, state.more);
    expect(Object.keys(body).sort()).toEqual(["background", "color", "extras", "fit", "lookBase", "v"]);
    expect(optionsIntentKey(state.choices, state.more)).toBe(outputOptionsKey(DEFAULT_OUTPUT_OPTIONS));
  });

  it("sets and clears Trim, which keeps the P0 fit at auto", () => {
    const trimmed = outputFormReducer(keep(), { type: "fit", fit: "crop" });
    expect(trimmed.more.trim).toBe(true);
    expect(trimmed.choices.fit).toBe("auto");
    expect(formFit(trimmed)).toBe("crop");
    expect(outputOptionsBody(trimmed.lookBase, trimmed.choices, trimmed.more).fit).toBe("crop");
    expect(moreOptionsChanged(trimmed)).toBe(1);
    const pad = outputFormReducer(trimmed, { type: "fit", fit: "pad" });
    expect(pad.more.trim).toBe(false);
    expect(formFit(pad)).toBe("pad");
    // Trim only applies to kept photos: with Remove it never reaches the body.
    const removed = outputFormReducer(trimmed, { type: "background", background: "remove" });
    expect(outputOptionsBody(removed.lookBase, removed.choices, removed.more).fit).toBe("auto");
  });

  it("picks Match my photo's edges as a color with Keep only", () => {
    const edges = outputFormReducer(keep(), { type: "color", color: { kind: "edge_match" } });
    expect(edges.more.edgeMatch).toBe(true);
    expect(outputOptionsBody(edges.lookBase, edges.choices, edges.more).color).toEqual({ kind: "edge_match" });
    expect(optionsIntentKey(edges.choices, edges.more)).not.toBe(optionsIntentKey(edges.choices));
    const sand = outputFormReducer(edges, { type: "color", color: { kind: "swatch", key: "sand" } });
    expect(sand.more.edgeMatch).toBe(false);
    const removed = outputFormReducer(edges, { type: "background", background: "remove" });
    expect(outputOptionsBody(removed.lookBase, removed.choices, removed.more).color).toEqual({ kind: "swatch", key: "white" });
    expect(packCreatedOutputProps(edges.lookBase, edges.choices, 1, edges.more).color_kind).toBe("edge_match");
  });

  it("drives the scenes family and the count from one Select", () => {
    expect(sceneCountSelectOptions().map((o) => o.label)).toEqual(["Off", "1", "2", "3", "4"]);
    const off = reduce({ type: "scenes", count: SCENES_OFF });
    expect(off.choices.extras.scenes).toBe(false);
    expect(sceneCountValue(off)).toBe("off");
    const two = outputFormReducer(off, { type: "scenes", count: 2 });
    expect(two.choices.extras.scenes).toBe(true);
    expect(sceneCountValue(two)).toBe("2");
    expect(outputOptionsBody(two.lookBase, two.choices, two.more).sceneCount).toBe(2);
    expect(outputFormReducer(off, { type: "scenes", count: 99 }).more.sceneCount).toBe(sceneCountOptions.max);
    expect(sceneCountFromValue("0")).toBeNull();
    expect(sceneCountFromValue("off")).toBe(SCENES_OFF);
    // A count with scenes off never reaches the body.
    const hidden = outputFormReducer(two, { type: "scenes", count: SCENES_OFF });
    expect(outputOptionsBody(hidden.lookBase, hidden.choices, hidden.more).sceneCount).toBeUndefined();
  });

  it("lists every seeded scene preset after Auto", () => {
    const options = sceneStyleOptions();
    expect(options[0]).toEqual({ value: "auto", label: "Auto, picked for your product" });
    expect(options.slice(1).map((o) => o.value)).toEqual(Object.keys(presets));
    expect(isScenePresetChoice("holiday")).toBe(true);
    expect(isScenePresetChoice("space")).toBe(false);
  });

  it("sends each P1 field only where it applies", () => {
    const more = { ...DEFAULT_MORE_CHOICES, productSize: "larger" as const, enlarge: false, logo: false, graphicsColor: true };
    const removed = p1OutputFields(LOOK_PRESETS.marketplace, more);
    expect(removed).toEqual({ productSize: "larger", logo: false, graphicsColor: true });
    const kept = p1OutputFields(LOOK_PRESETS.keep_photo, more);
    // Keep turns graphics and cards off, so neither the logo nor the graphics color applies.
    expect(kept).toEqual({ enlarge: false });
    expect(moreOptionsVisibility(LOOK_PRESETS.keep_photo)).toMatchObject({
      photoShape: true,
      neverEnlarge: true,
      productSize: false,
      graphicsColor: false,
    });
    expect(moreOptionsVisibility(LOOK_PRESETS.marketplace, { hasLogo: true })).toMatchObject({ logo: true, productSize: true });
    expect(moreOptionsVisibility(LOOK_PRESETS.marketplace, { scenesPaused: true }).sceneStyle).toBe(false);
  });

  it("resets the P1 controls with a look card, Reset and Keep my photos instead", () => {
    const changed = reduce({ type: "scenes", count: 1 }, { type: "more", patch: { productSize: "smaller" } });
    expect(outputFormReducer(changed, { type: "look", look: "marketplace" }).more).toEqual(DEFAULT_MORE_CHOICES);
    expect(outputFormReducer(changed, { type: "reset" }).more).toEqual(DEFAULT_MORE_CHOICES);
    expect(outputFormReducer(changed, { type: "keep_instead" }).more).toEqual(DEFAULT_MORE_CHOICES);
  });

  it("sends only what the server schema accepts, and resolves with every P1 field", () => {
    const photos = planningPhotos([]);
    const kept = reduce(
      { type: "look", look: "keep_photo" },
      { type: "fit", fit: "crop" },
      { type: "color", color: { kind: "edge_match" } },
      { type: "more", patch: { enlarge: false } },
    );
    const removed = reduce(
      { type: "scenes", count: 2 },
      { type: "more", patch: { scenePreset: "holiday", productSize: "larger", logo: false, graphicsColor: true } },
    );
    for (const state of [kept, removed]) {
      const body = outputOptionsBody(state.lookBase, state.choices, state.more);
      // The server parses the body with the same strict schema.
      expect(() => OutputOptionsInput.parse(body)).not.toThrow();
      const resolved = resolveFormOutput({
        choices: state.choices,
        lookBase: state.lookBase,
        more: state.more,
        brandColors: [],
        brandKitsAllowed: false,
        photos,
      }).resolved;
      expect(outputOptionsKey(resolved)).toBe(outputOptionsKey(body));
      expect(optionsIntentKey(state.choices, state.more)).toBe(outputOptionsKey(body));
    }
    const keptResolved = resolveFormOutput({ choices: kept.choices, more: kept.more, brandColors: [], brandKitsAllowed: false, photos });
    expect(keptResolved.resolved).toMatchObject({ fit: "crop", color: { kind: "edge_match" }, enlarge: false });
    expect(keptResolved.flags.enlarge).toBe(false);
    const removedResolved = resolveFormOutput({
      choices: removed.choices,
      more: removed.more,
      brandColors: [],
      brandKitsAllowed: false,
      photos,
    });
    expect(removedResolved.resolved).toMatchObject({ sceneCount: 2, scenePreset: "holiday", productSize: "larger", logo: false, graphicsColor: true });
    expect(removedResolved.flags.sceneCount).toBe(2);
  });

  it("parses Match my photo's edges from the color Select", () => {
    expect(colorChoiceFromValue(EDGE_MATCH_VALUE)).toEqual({ kind: "edge_match" });
    expect(colorValue({ kind: "edge_match" })).toBe(EDGE_MATCH_VALUE);
  });
});

describe("background per photo", () => {
  const photos = [
    { id: "front", angle: "front" as const },
    { id: "back", angle: "back" as const },
  ];

  it("resolves the kept photos and plans a mixed pack", () => {
    const mixed = resolveFormOutput({
      choices: initialOutputForm().choices,
      brandColors: [],
      brandKitsAllowed: false,
      photos,
      photoBackgrounds: { back: "keep" },
    });
    expect(mixed.resolved.keepMediaIds).toEqual(["back"]);
    expect(mixed.flags.keepMediaIds).toEqual(["back"]);
    expect(mixed.resolved.background).toBe("remove");
  });

  it("lets a pack whose every photo is kept start while cutouts are paused", () => {
    const keepAll = resolveFormOutput({
      choices: initialOutputForm().choices,
      brandColors: [],
      brandKitsAllowed: false,
      photos,
      photoBackgrounds: { front: "keep", back: "keep" },
    });
    const noWhite = withoutWhiteRequired(DEFAULT_CHANNELS).selected;
    // Remove turns every extra on, so the front photo still feeds a cut out copy.
    expect(pauseBlocksSubmit(true, noWhite, keepAll.flags)).toBe(true);
    const noExtras = { ...keepAll.flags, extras: LOOK_PRESETS.keep_photo.extras };
    expect(pauseBlocksSubmit(true, noWhite, noExtras)).toBe(false);
  });

  it("sends an upload's background only when the photo has its own", () => {
    expect(uploadBackgroundField(undefined)).toEqual({});
    expect(uploadBackgroundField("pack")).toEqual({});
    expect(uploadBackgroundField("keep")).toEqual({ background: "keep" });
    expect(isPhotoBackground("remove")).toBe(true);
    expect(isPhotoBackground("blur")).toBe(false);
  });
});

describe("remembered choices", () => {
  const ctx = { brandColorCount: 1 };

  it("prefills nothing for no record, a broken one, or Marketplace ready", () => {
    expect(rememberedFormState(null, ctx)).toBeNull();
    expect(rememberedFormState([1], ctx)).toBeNull();
    expect(rememberedFormState({ background: "blur" }, ctx)).toBeNull();
    expect(rememberedFormState({ unknown: true }, ctx)).toBeNull();
    expect(rememberedFormState({ v: 1, sceneCount: 9 }, ctx)).toBeNull();
    expect(rememberedFormState({ v: 1 }, ctx)).toBeNull();
    expect(rememberedFormState({ ...DEFAULT_OUTPUT_OPTIONS, lookBase: "marketplace" }, ctx)).toBeNull();
  });

  it("prefills a Keep record with its look and P1 fields", () => {
    const state = rememberedFormState(
      { v: 1, lookBase: "keep_photo", background: "keep", fit: "crop", color: { kind: "edge_match" }, enlarge: false, extras: {} },
      ctx,
    );
    expect(state).not.toBeNull();
    expect(state!.lookBase).toBe("keep_photo");
    expect(state!.choices.background).toBe("keep");
    expect(state!.more).toMatchObject({ trim: true, edgeMatch: true, enlarge: false });
    expect(state!.choices.extras).toEqual(LOOK_PRESETS.keep_photo.extras);
  });

  it("falls back to white when the kit lost the brand color, and derives the look without lookBase", () => {
    const state = rememberedFormState({ v: 1, color: { kind: "brand", index: 2 }, sceneCount: 2 }, ctx);
    expect(state!.choices.color).toEqual({ kind: "swatch", key: "white" });
    expect(state!.more.sceneCount).toBe(2);
    expect(state!.lookBase).toBe("marketplace");
  });

  it("round trips a body the form sent", () => {
    const sent = reduce({ type: "look", look: "keep_photo" }, { type: "fit", fit: "pad" }, { type: "more", patch: { enlarge: false } });
    const body = outputOptionsBody(sent.lookBase, sent.choices, sent.more);
    const back = rememberedFormState(body, ctx);
    expect(back).toEqual(sent);
  });
});

describe("the keep my background hint", () => {
  it("matches the seeded phrases as whole words, in any case and with curly apostrophes", () => {
    expect(keepBackgroundPhrases.length).toBeGreaterThan(0);
    expect(noteAsksToKeepBackground("Please KEEP THE BACKGROUND, it is our shop.")).toBe(true);
    expect(noteAsksToKeepBackground("Don’t remove the background please")).toBe(true);
    expect(noteAsksToKeepBackground("keep backgrounds varied")).toBe(false);
    expect(noteAsksToKeepBackground("Hand made walnut board")).toBe(false);
    expect(noteAsksToKeepBackground("")).toBe(false);
  });

  it("asks only while the switch is on", () => {
    expect(keepBackgroundHint("keep my background", "remove")).toBe(KEEP_BACKGROUND_HINT);
    expect(keepBackgroundHint("keep my background", "keep")).toBeNull();
    expect(keepBackgroundHint("walnut board", "remove")).toBeNull();
  });
});

describe("the cutout preview in the strip", () => {
  const sources = { photoUrl: "blob:photo", cutoutUrl: "https://r2.example/p.png", hasPhoto: true };

  it("shows the cutout on removed and white frames, and the photo on kept ones", () => {
    expect(framePicture({ white: false }, "remove", sources)).toEqual({ kind: "cutout", src: sources.cutoutUrl });
    expect(framePicture({ white: true }, "keep", sources)).toEqual({ kind: "cutout", src: sources.cutoutUrl });
    expect(framePicture({ white: false }, "keep", sources)).toEqual({ kind: "photo", src: sources.photoUrl });
    expect(framePicture({ white: false }, "remove", { hasPhoto: true })).toEqual({ kind: "silhouette" });
    expect(framePicture({ white: false }, "keep", { hasPhoto: false })).toEqual({ kind: "none" });
  });
});
