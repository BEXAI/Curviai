import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_OPTIONS,
  EXTRA_FAMILY_KEYS,
  LOOK_PRESETS,
  outputOptionsKey,
  type OutputPlanFlags,
} from "@curvi/pipeline/output-options";
import { backgroundSwatches, creditCosts, stillStyle } from "@curvi/pipeline/seed";
import { getSpec, listSpecs, requiresWhiteBackground } from "@curvi/specs";
import { intentFor } from "@/lib/submit-intent";
import { DARK_COLOR_EDGE_NOTE, leftOutAfterPauseLine } from "@/lib/output-options-copy";
import {
  CUSTOM_COLOR_ERROR,
  LOOK_CARD_COPY,
  PHOTO_SHAPE_OPTIONS,
  RECENT_CUSTOM_STORAGE_KEY,
  addedSpaceSpecIds,
  backgroundSummaryLine,
  brandLookAvailability,
  colorChoiceFromValue,
  colorOptions,
  colorValue,
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
    expect(EXTRA_FAMILY_KEYS.every((f) => on.choices.extras[f])).toBe(true);
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
    expect(outputOptionsKey(body)).toBe(optionsIntentKey(state.choices));
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
    });
    expect(JSON.stringify(props)).not.toMatch(/#[0-9A-F]{6}/i);
    expect(packCreatedOutputProps("marketplace", LOOK_PRESETS.marketplace, 3).kept_photos).toBe(0);
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
});
