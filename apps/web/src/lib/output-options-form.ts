/**
 * The new pack form's output options (docs/phases/PHASE_15.md, UI section):
 * the state behind section 3 "How your images look", its reducer (look
 * cards, the switch reset, Reset, Keep my photos instead), Leave it out, the
 * custom color row, the preview frames, the summary lines and the analytics
 * properties. Pure and client safe, so the form stays thin and every rule
 * here is tested without a browser.
 *
 * Every figure comes from its source (rule 2): credits from creditCosts, plan
 * names from the seed tiers, sizes and white rules from the registry, color
 * names from backgroundSwatches. Every sentence follows rule 9.
 */

import {
  DEFAULT_OUTPUT_OPTIONS,
  DEFAULT_SWATCH_KEY,
  EXTRA_FAMILY_KEYS,
  GALLERY_SLOTS,
  HEX,
  LOOK_PRESETS,
  SWATCH_KEYS,
  canvasSizeFor,
  conflictsFor,
  cutoutMediaIds,
  keptPhotoSpecIds,
  LOOK_KEYS,
  lookOf,
  keepMediaIdsFor,
  normalizeOutputOptions,
  originalFitFor,
  outputOptionsKey,
  P1_DEFAULTS,
  packNeedsCutout,
  PRODUCT_SIZE_KEYS,
  SCENE_PRESET_AUTO,
  type ColorChoice,
  type ConflictPhoto,
  type ExtraFamily,
  type Look,
  type LookKey,
  type OutputChoices,
  type OutputConflict,
  type OutputExtras,
  type OutputFit,
  type OutputOptionsInput,
  type OutputPlanFlags,
  type PhotoBackgroundChoice,
  type ProductSize as PipelineProductSize,
  type ResolvedOutputOptions,
  type ScenePresetChoice as PipelineScenePresetChoice,
} from "@curvi/pipeline/output-options";
import { showsLightEdge } from "@curvi/pipeline/edge";
import {
  backgroundSwatches,
  creditCosts,
  entitlementsFor,
  keepBackgroundPhrases,
  presets,
  sceneCountOptions,
  stillStyle,
  tiers,
  type PresetKey,
  type TierKey,
} from "@curvi/pipeline/seed";
import type { AngleRole } from "@curvi/pipeline/seller-inputs";
import { getSpec, hasSpec, isExactSize, listSpecs, requiresWhiteBackground, type ChannelSpec } from "@curvi/specs";
import {
  DARK_COLOR_EDGE_NOTE,
  LOOK_TITLES,
  channelName,
  whiteRequiredSpecIds,
  type ConflictCopyContext,
} from "@/lib/output-options-copy";
import { resolveJobOutput, type OutputPhoto } from "@/lib/services/output-options";
import { MAX_BRAND_COLORS } from "@/lib/validation/brand-kit";

// ---------------------------------------------------------------------------
// State and reducer

// ---------------------------------------------------------------------------
// P1 choices (PHASE_15 "P1 (fast follow, same phase)")

// The P1 types are the schema's (@curvi/pipeline/output-options); these
// names are the form's aliases of them, so the form sends exactly what the
// server accepts.

/** "Product size in the frame" (seed canvasDefaults.productSizeFill keys). */
export const PRODUCT_SIZES = PRODUCT_SIZE_KEYS;
export type ProductSize = PipelineProductSize;

/** "Scene style": the planner's pick (auto), or a seeded preset. */
export type ScenePresetChoice = PipelineScenePresetChoice;

/** Photo shape with Trim to the channel's shape (fit crop). */
export type FormFit = OutputFit;

/** A color choice, including Match my photo's edges (Keep only). */
export type FormColorChoice = ColorChoice;

/** The per photo Background Select: the pack's switch, or this photo's own. */
export const PHOTO_BACKGROUNDS = ["pack", "remove", "keep"] as const satisfies readonly PhotoBackgroundChoice[];
export type PhotoBackground = PhotoBackgroundChoice;

/**
 * The P1 controls. They sit next to the P0 choices, so the P0 look presets
 * and lookOf stay exactly as they are, and each one reaches the POST body
 * only when it differs from its default (outputOptionsBody): an unchanged
 * form sends the same body, and the same Idempotency-Key, as before P1.
 */
export interface MoreChoices {
  /** Trim to the channel's shape (fit crop), for kept photos. */
  trim: boolean;
  /** Match my photo's edges (color edge_match), for the space added to kept photos. */
  edgeMatch: boolean;
  /** Number of scenes while the scenes family is on (seed sceneCountOptions). */
  sceneCount: number;
  scenePreset: ScenePresetChoice;
  /** Logo on graphics. */
  logo: boolean;
  productSize: ProductSize;
  /** False is "Never enlarge my photo". */
  enlarge: boolean;
  /** Graphics follow your color. */
  graphicsColor: boolean;
}

export const DEFAULT_MORE_CHOICES: Readonly<MoreChoices> = {
  trim: false,
  edgeMatch: false,
  ...P1_DEFAULTS,
};

function defaultMore(): MoreChoices {
  return { ...DEFAULT_MORE_CHOICES };
}

/** What the seller has picked in section 3. */
export interface OutputFormState {
  /** The look card the choices started from (the Custom chip and analytics). */
  lookBase: LookKey;
  /** The choices themselves; they may drift from the card (Custom). */
  choices: OutputChoices;
  /** The P1 controls under More options, and the edge color. */
  more: MoreChoices;
}

export type OutputFormAction =
  /** A look card: its preset replaces every choice. */
  | { type: "look"; look: LookKey }
  /** The switch: extras reset to that side's default (all on with remove,
   * all off with keep); the color and photo shape stay. */
  | { type: "background"; background: OutputChoices["background"] }
  /** A color, or Match my photo's edges. */
  | { type: "color"; color: FormColorChoice }
  | { type: "extra"; family: ExtraFamily; on: boolean }
  /** Photo shape; crop is Trim to the channel's shape. */
  | { type: "fit"; fit: FormFit }
  /** Number of scenes: "off" turns the scenes family off, a count turns it on. */
  | { type: "scenes"; count: number | typeof SCENES_OFF }
  /** Any other More options control. */
  | { type: "more"; patch: Partial<Omit<MoreChoices, "trim" | "edgeMatch" | "sceneCount">> }
  /** A product's remembered choices (rememberedFormState). */
  | { type: "prefill"; state: OutputFormState }
  /** The Custom chip's Reset: back to the card's preset. */
  | { type: "reset" }
  /** "Keep my photos instead" while cutouts are paused: the Keep look with
   * every extra off. The form unticks the white required channels itself. */
  | { type: "keep_instead" };

function copyChoices(choices: OutputChoices): OutputChoices {
  return { ...choices, color: { ...choices.color }, extras: { ...choices.extras } };
}

function allExtras(on: boolean): OutputExtras {
  return Object.fromEntries(EXTRA_FAMILY_KEYS.map((family) => [family, on])) as OutputExtras;
}

/** The form's first state: Marketplace ready, today's pack. */
export function initialOutputForm(): OutputFormState {
  return { lookBase: "marketplace", choices: copyChoices(LOOK_PRESETS.marketplace), more: defaultMore() };
}

/** The Number of scenes value that turns the scenes family off. */
export const SCENES_OFF = "off";

function clampSceneCount(count: number): number {
  return Math.min(sceneCountOptions.max, Math.max(sceneCountOptions.min, Math.round(count)));
}

export function outputFormReducer(state: OutputFormState, action: OutputFormAction): OutputFormState {
  switch (action.type) {
    case "look":
      return { lookBase: action.look, choices: copyChoices(LOOK_PRESETS[action.look]), more: defaultMore() };
    case "background":
      if (state.choices.background === action.background) return state;
      return {
        ...state,
        choices: { ...state.choices, background: action.background, extras: allExtras(action.background === "remove") },
      };
    case "color":
      if (action.color.kind === "edge_match") {
        return { ...state, more: { ...state.more, edgeMatch: true } };
      }
      return { ...state, choices: { ...state.choices, color: { ...action.color } }, more: { ...state.more, edgeMatch: false } };
    case "extra":
      return { ...state, choices: { ...state.choices, extras: { ...state.choices.extras, [action.family]: action.on } } };
    case "fit":
      // Trim keeps the P0 fit at auto, so the heads ups and the estimate
      // judge the photo as one that keeps its shape.
      return action.fit === "crop"
        ? { ...state, choices: { ...state.choices, fit: "auto" }, more: { ...state.more, trim: true } }
        : { ...state, choices: { ...state.choices, fit: action.fit }, more: { ...state.more, trim: false } };
    case "scenes":
      return action.count === SCENES_OFF
        ? { ...state, choices: { ...state.choices, extras: { ...state.choices.extras, scenes: false } } }
        : {
            ...state,
            choices: { ...state.choices, extras: { ...state.choices.extras, scenes: true } },
            more: { ...state.more, sceneCount: clampSceneCount(action.count) },
          };
    case "more":
      return { ...state, more: { ...state.more, ...action.patch } };
    case "prefill":
      return { lookBase: action.state.lookBase, choices: copyChoices(action.state.choices), more: { ...action.state.more } };
    case "reset":
      return { ...state, choices: copyChoices(LOOK_PRESETS[state.lookBase]), more: defaultMore() };
    case "keep_instead":
      return { lookBase: "keep_photo", choices: copyChoices(LOOK_PRESETS.keep_photo), more: defaultMore() };
  }
}

/** What the choices amount to: a preset key, or custom. */
export function currentLook(state: OutputFormState): Look {
  return lookOf(state.choices);
}

/** "Custom, started from Keep my photo" once the choices leave their card, else null. */
export function customChipText(state: OutputFormState): string | null {
  return currentLook(state) === state.lookBase ? null : `Custom, started from ${LOOK_TITLES[state.lookBase]}`;
}

export interface EffectiveContext {
  /** Concept packs always remove the background with every extra (PHASE_15 UI item 8). */
  conceptMode?: boolean;
  /** Scenes are paused, so the scenes extra is forced off and not held. */
  scenesPaused?: boolean;
}

/** The choices the pack is sent and estimated with, after the pauses and the mode. */
export function effectiveChoices(choices: OutputChoices, context: EffectiveContext = {}): OutputChoices {
  if (context.conceptMode) {
    return copyChoices(DEFAULT_OUTPUT_OPTIONS);
  }
  const out = copyChoices(choices);
  if (context.scenesPaused) {
    out.extras.scenes = false;
  }
  return out;
}

/**
 * The P1 fields of the POST body (the P1 schema contract): only the ones
 * that differ from their default and matter for these choices, so a hidden
 * control never changes the pack. The scene fields ride only with scenes
 * on, product size only with Remove, enlarge only with Keep, and the logo
 * and graphics color only with graphics or cards on.
 */
export interface P1OutputFields {
  sceneCount?: number;
  scenePreset?: ScenePresetChoice;
  logo?: boolean;
  productSize?: ProductSize;
  enlarge?: boolean;
  graphicsColor?: boolean;
}

export function p1OutputFields(choices: OutputChoices, more: MoreChoices = DEFAULT_MORE_CHOICES): P1OutputFields {
  const keep = choices.background === "keep";
  const graphicsOn = choices.extras.graphics || choices.extras.cards;
  const out: P1OutputFields = {};
  if (choices.extras.scenes && more.sceneCount !== DEFAULT_MORE_CHOICES.sceneCount) out.sceneCount = more.sceneCount;
  if (choices.extras.scenes && more.scenePreset !== DEFAULT_MORE_CHOICES.scenePreset) out.scenePreset = more.scenePreset;
  if (graphicsOn && more.logo !== DEFAULT_MORE_CHOICES.logo) out.logo = more.logo;
  if (!keep && more.productSize !== DEFAULT_MORE_CHOICES.productSize) out.productSize = more.productSize;
  if (keep && more.enlarge !== DEFAULT_MORE_CHOICES.enlarge) out.enlarge = more.enlarge;
  if (graphicsOn && more.graphicsColor !== DEFAULT_MORE_CHOICES.graphicsColor) out.graphicsColor = more.graphicsColor;
  return out;
}

/** The POST body's outputOptions: the P0 fields, crop and edge_match with
 * Keep, and the P1 fields that differ from their defaults. Exactly the
 * schema's request shape (OutputOptionsInput). */
export type FormOutputOptionsBody = OutputOptionsInput;

/** The POST body's outputOptions. */
export function outputOptionsBody(
  lookBase: LookKey,
  choices: OutputChoices,
  more: MoreChoices = DEFAULT_MORE_CHOICES,
): FormOutputOptionsBody {
  const keep = choices.background === "keep";
  return {
    v: 1,
    lookBase,
    background: choices.background,
    color: keep && more.edgeMatch ? { kind: "edge_match" } : { ...choices.color },
    fit: keep && more.trim ? "crop" : choices.fit,
    extras: { ...choices.extras },
    ...p1OutputFields(choices, more),
  };
}

/** The part of the Idempotency-Key fingerprint the options add: the
 * server's outputOptionsKey of the body the form sends, so any choice that
 * changes the pack changes it and lookBase never does. With every P1
 * control at its default it is exactly outputOptionsKey(choices). */
export function optionsIntentKey(choices: OutputChoices, more: MoreChoices = DEFAULT_MORE_CHOICES): string {
  return outputOptionsKey(outputOptionsBody("marketplace", choices, more));
}

// ---------------------------------------------------------------------------
// Channels: Leave it out and the pause reconciliation

/** The pick with these channels unticked. */
export function leaveOut(selected: readonly string[], specIds: readonly string[]): string[] {
  const drop = new Set(specIds);
  return selected.filter((id) => !drop.has(id));
}

/** "Keep my photos instead": the pick without its white required channels, and which those were. */
export function withoutWhiteRequired(
  selected: readonly string[],
  specs: readonly ChannelSpec[] = listSpecs(),
): { selected: string[]; leftOut: string[] } {
  const leftOut = whiteRequiredSpecIds(selected, specs);
  return { selected: leaveOut(selected, leftOut), leftOut };
}

// ---------------------------------------------------------------------------
// Photos, resolution and conflicts

/** One of the form's photos as the options see it. */
export interface FormPhoto extends OutputPhoto {
  /** The preflight found other items in the photo. */
  otherItems?: boolean;
}

/** Synthetic id of a stored photo the form counts but has no key for. */
export function storedPhotoId(position: number): string {
  return `stored_photo_${position}`;
}

/** The id the conflicts use when the form has no photo yet. */
export const PLACEHOLDER_PHOTO_ID = "form_photo_1";

/**
 * The pack's photos in pack order, as createJob merges them: the uploads,
 * or the product's stored photos when there are none (synthetic ids, sizes
 * unknown, capped at maxPhotos).
 */
export function formPhotos(uploads: readonly FormPhoto[], storedPhotoCount: number, maxPhotos: number): FormPhoto[] {
  if (uploads.length > 0) {
    return uploads.slice(0, maxPhotos);
  }
  const count = Math.max(0, Math.min(storedPhotoCount, maxPhotos));
  return Array.from({ length: count }, (_, i) => ({ id: storedPhotoId(i + 1) }));
}

/** The photos to plan heads ups with: one front placeholder while the form has none. */
export function planningPhotos(photos: readonly FormPhoto[]): FormPhoto[] {
  return photos.length > 0 ? [...photos] : [{ id: PLACEHOLDER_PHOTO_ID, angle: "front" as AngleRole }];
}

export interface FormResolveArgs {
  choices: OutputChoices;
  lookBase?: LookKey;
  brandColors: readonly string[];
  brandKitsAllowed: boolean;
  photos: readonly FormPhoto[];
  /** The P1 controls. Resolved with them where the schema knows them. */
  more?: MoreChoices;
  /** Per photo Background Select values by photo id; missing means "pack". */
  photoBackgrounds?: Readonly<Record<string, PhotoBackground>>;
}

export interface FormResolved {
  resolved: ResolvedOutputOptions;
  flags: OutputPlanFlags;
}

/**
 * The photos kept once each photo's own Background Select applies: "keep"
 * and "remove" win over the pack's switch, "pack" follows it. The server
 * resolves uploads[].background into keepMediaIds the same way.
 */
export function keptPhotoIds(
  photos: readonly Pick<FormPhoto, "id">[],
  background: OutputChoices["background"],
  photoBackgrounds: Readonly<Record<string, PhotoBackground>> = {},
): string[] {
  return keepMediaIdsFor(
    { background },
    photos.map((photo) => photo.id),
    photoBackgrounds,
  );
}

/**
 * The options as createJob would resolve them for these photos. A brand
 * color the kit or plan cannot give falls back to white here, so the form
 * keeps working; the brand card and option are disabled in that case and
 * the server refuses it anyway.
 *
 * The options are resolved from exactly the body the form sends
 * (outputOptionsBody, P1 fields, Trim and Match my photo's edges included)
 * and each photo's own Background Select, so the estimate, the heads ups
 * and the server's hold agree.
 */
export function resolveFormOutput(args: FormResolveArgs): FormResolved {
  const { lookBase, ...fields } = outputOptionsBody(args.lookBase ?? "marketplace", args.choices, args.more ?? DEFAULT_MORE_CHOICES);
  const body: OutputOptionsInput = args.lookBase ? { lookBase, ...fields } : fields;
  const run = (input: OutputOptionsInput) =>
    resolveJobOutput({
      input,
      mode: "listing",
      enabled: true,
      brandColors: args.brandColors,
      brandKitsAllowed: args.brandKitsAllowed,
      photos: args.photos,
      ...(args.photoBackgrounds ? { photoBackgrounds: args.photoBackgrounds } : {}),
    });
  const first = run(body);
  if (first.ok) {
    return { resolved: first.resolved, flags: first.flags };
  }
  const fallback = run({ ...body, color: { kind: "swatch", key: DEFAULT_SWATCH_KEY } });
  if (!fallback.ok) {
    throw new Error(`The form's options did not resolve: ${fallback.reason}`);
  }
  return { resolved: fallback.resolved, flags: fallback.flags };
}

/** The heads ups for this pick: conflictsFor over the form's photos. */
export function formConflicts(
  selected: readonly string[],
  resolved: Pick<ResolvedOutputOptions, "colorHex" | "fit" | "keepMediaIds">,
  photos: readonly FormPhoto[],
): OutputConflict[] {
  const conflictPhotos: ConflictPhoto[] = photos.map((photo) => ({
    id: photo.id,
    ...(photo.angle ? { angle: photo.angle } : {}),
    ...(typeof photo.width === "number" ? { width: photo.width } : {}),
    ...(typeof photo.height === "number" ? { height: photo.height } : {}),
    ...(photo.otherItems ? { otherItems: true } : {}),
  }));
  return conflictsFor(selected, resolved, conflictPhotos);
}

/** What the conflict copy needs: the background and the photos' pixel sizes. */
export function conflictContextOf(
  background: OutputChoices["background"],
  photos: readonly FormPhoto[],
): ConflictCopyContext {
  return {
    background,
    photos: photos.map((photo) => ({
      id: photo.id,
      ...(typeof photo.width === "number" ? { width: photo.width } : {}),
      ...(typeof photo.height === "number" ? { height: photo.height } : {}),
    })),
  };
}

/** The conflict codes shown under a channel row in section 2. */
const ROW_CONFLICT_CODES = new Set<OutputConflict["code"]>([
  "white_required",
  "overlays_refused",
  "borders_refused",
  "mixed_consistent",
]);

/** The conflicts about this one channel, for the line under its row. */
export function rowConflicts(conflicts: readonly OutputConflict[], specId: string): OutputConflict[] {
  return conflicts.filter((c) => c.specId === specId && ROW_CONFLICT_CODES.has(c.code));
}

/** Per photo: kept, and whether some planned shot cuts it out (PhotoOutputContext). */
export function photoOutputContext(
  photoId: string,
  selected: readonly string[],
  flags: OutputPlanFlags,
): { kept: boolean; feedsCutout: boolean } {
  return {
    kept: flags.keepMediaIds.includes(photoId),
    feedsCutout: cutoutMediaIds(flags.photos, selected, flags).includes(photoId),
  };
}

/**
 * Whether the cutout pause stops this pack: only a pack that needs a cutout
 * (packNeedsCutout) waits. A pack with no photo yet is judged as if its
 * first photo were the front one.
 */
export function pauseBlocksSubmit(packsPaused: boolean, selected: readonly string[], flags: OutputPlanFlags): boolean {
  if (!packsPaused) return false;
  // With photos, each photo's own background counts (P1 per photo Select).
  if (flags.photos.length > 0) return packNeedsCutout(selected, flags);
  if (flags.background === "remove") return true;
  return packNeedsCutout(selected, {
    ...flags,
    photos: [{ id: PLACEHOLDER_PHOTO_ID, angle: "front" }],
    keepMediaIds: [PLACEHOLDER_PHOTO_ID],
  });
}

/**
 * The picked specs where a kept photo gets flat added space: exact size
 * specs, and every spec that allows borders when the seller picked pad.
 * With Keep, the color control shows only when this is not empty.
 */
export function addedSpaceSpecIds(selected: readonly string[], choices: Pick<OutputChoices, "background" | "fit">): string[] {
  if (choices.background !== "keep") return [];
  const photo = { id: PLACEHOLDER_PHOTO_ID };
  return keptPhotoSpecIds(photo, [photo], selected).filter((id) => originalFitFor(getSpec(id), choices) === "pad");
}

// ---------------------------------------------------------------------------
// Colors

/** The Select's value for a choice: "swatch:white", "brand:0" or "custom". */
export function colorValue(choice: ColorChoice): string {
  switch (choice.kind) {
    case "swatch":
      return `swatch:${choice.key}`;
    case "brand":
      return `brand:${choice.index}`;
    case "custom":
      return "custom";
    case "edge_match":
      return EDGE_MATCH_VALUE;
  }
}

/** The choice for a Select value ("edge_match" included), or null for
 * "custom" (the custom row supplies the hex). */
export function colorChoiceFromValue(value: string): ColorChoice | null {
  const [kind, rest] = value.split(":");
  if (kind === "swatch" && (SWATCH_KEYS as readonly string[]).includes(rest ?? "")) {
    return { kind: "swatch", key: rest as (typeof SWATCH_KEYS)[number] };
  }
  if (value === EDGE_MATCH_VALUE) {
    return { kind: "edge_match" };
  }
  if (kind === "brand") {
    const index = Number(rest);
    if (Number.isInteger(index) && index >= 0 && index < MAX_BRAND_COLORS) {
      return { kind: "brand", index };
    }
  }
  return null;
}

export interface ColorOption {
  value: string;
  label: string;
  hex: string;
}

export interface ColorOptionGroups {
  swatches: ColorOption[];
  /** Empty unless the kit has colors and the plan includes brand kits. */
  brand: ColorOption[];
}

/** The kit's usable colors, upper case, at most MAX_BRAND_COLORS. */
export function usableBrandColors(colors: readonly string[] | null | undefined): string[] {
  return (colors ?? [])
    .map((c) => c.trim())
    .filter((c) => HEX.test(c))
    .map((c) => c.toUpperCase())
    .slice(0, MAX_BRAND_COLORS);
}

/** The dropdown's options in order: the seeded colors, then "Your brand colors". */
export function colorOptions(brandColors: readonly string[], brandKitsAllowed: boolean): ColorOptionGroups {
  const swatches = SWATCH_KEYS.map((key) => ({
    value: `swatch:${key}`,
    label: backgroundSwatches[key].label,
    hex: backgroundSwatches[key].hex.toUpperCase(),
  }));
  const brand = brandKitsAllowed
    ? usableBrandColors(brandColors).map((hex, index) => ({
        value: `brand:${index}`,
        label: `Brand color ${index + 1}, ${hex}`,
        hex,
      }))
    : [];
  return { swatches, brand };
}

/** The color's name next to the swatch chip, so color never shows by the swatch alone. */
export function colorLabel(choice: ColorChoice, hex: string): string {
  switch (choice.kind) {
    case "swatch":
      return backgroundSwatches[choice.key].label;
    case "brand":
      return `Brand color ${choice.index + 1}, ${hex.toUpperCase()}`;
    case "custom":
      return hex.toUpperCase();
    case "edge_match":
      return EDGE_MATCH_LABEL;
  }
}

export const CUSTOM_COLOR_ERROR = "Use a color code like #1F2A44.";

/** The typed hex, trimmed and with a leading # added, or the error line. */
export function parseCustomHex(text: string): { ok: true; hex: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return HEX.test(withHash) ? { ok: true, hex: withHash.toUpperCase() } : { ok: false, error: CUSTOM_COLOR_ERROR };
}

/** How many custom colors the form remembers. */
export const RECENT_CUSTOM_LIMIT = 3;
export const RECENT_CUSTOM_STORAGE_KEY = "curvi.recentCustomColors";

/** The recent list with this hex first, each color once, at most RECENT_CUSTOM_LIMIT. */
export function rememberCustomColor(recent: readonly string[], hex: string): string[] {
  const upper = hex.toUpperCase();
  return [upper, ...recent.filter((c) => c.toUpperCase() !== upper)].slice(0, RECENT_CUSTOM_LIMIT);
}

/** Reads the remembered custom colors. Storage can be missing or throw
 * (private windows, blocked site data), so every access is guarded. */
export function readRecentCustomColors(storage: Pick<Storage, "getItem"> | null | undefined): string[] {
  try {
    const raw = storage?.getItem(RECENT_CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is string => typeof c === "string" && HEX.test(c))
      .map((c) => c.toUpperCase())
      .slice(0, RECENT_CUSTOM_LIMIT);
  } catch {
    return [];
  }
}

export function writeRecentCustomColors(storage: Pick<Storage, "setItem"> | null | undefined, colors: readonly string[]): void {
  try {
    storage?.setItem(RECENT_CUSTOM_STORAGE_KEY, JSON.stringify(colors.slice(0, RECENT_CUSTOM_LIMIT)));
  } catch {
    // A full or blocked storage only loses the shortcut.
  }
}

/** The line under a custom or brand color that can show a light edge, else null. */
export function darkColorNote(choice: ColorChoice, hex: string, background: OutputChoices["background"]): string | null {
  if (background !== "remove" || choice.kind === "swatch" || !HEX.test(hex)) return null;
  return showsLightEdge(hex) ? DARK_COLOR_EDGE_NOTE : null;
}

export interface ColorControlCopy {
  label: string;
  helper: string | null;
}

/** The color Select's value for Match my photo's edges (Keep only). */
export const EDGE_MATCH_VALUE = "edge_match";
export const EDGE_MATCH_LABEL = "Match my photo's edges";
export const EDGE_MATCH_CHIP = "Matches the edges of each photo";

/** "Background color" with Remove; "Color for added space" with Keep. */
export function colorControlCopy(background: OutputChoices["background"]): ColorControlCopy {
  return background === "keep"
    ? {
        label: "Color for added space",
        helper: "Used only where a channel needs a set shape, like Meta and Pinterest.",
      }
    : { label: "Background color", helper: null };
}

// ---------------------------------------------------------------------------
// Looks

export const LOOK_CARD_COPY: Readonly<Record<LookKey, string>> = {
  marketplace:
    "Background removed and your product on clean white, with scenes and graphics. Made to each channel's rules.",
  keep_photo: "We keep your photo and only resize it. Channels that need a white background still get one.",
  brand: "Background removed, with your brand color behind your product and your logo on graphics.",
};

export const SWITCH_LABEL = "Remove the background";

export function switchHelper(background: OutputChoices["background"]): string {
  return background === "remove"
    ? "We cut out your product and place it on the color you pick below."
    : "We keep your photo as it is and only resize it for each channel. Nothing in it is redrawn.";
}

function planTitle(key: TierKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export type BrandLookAvailability =
  | { available: true }
  | { available: false; reason: "upgrade" | "no_colors"; text: string; href: string };

/**
 * Whether the Brand look card can be picked. A plan without brand kits
 * names the first plan with one (from the seed); a kit with no color links
 * to the brand page.
 */
export function brandLookAvailability(tier: TierKey, brandColors: readonly string[]): BrandLookAvailability {
  if (entitlementsFor(tier).brandKits <= 0) {
    const first = tiers.find((t) => entitlementsFor(t.key).brandKits > 0);
    return {
      available: false,
      reason: "upgrade",
      text: first ? `Brand kits come with the ${planTitle(first.key)} plan.` : "Brand kits are not part of your plan.",
      href: "/app/billing",
    };
  }
  if (usableBrandColors(brandColors).length === 0) {
    return { available: false, reason: "no_colors", text: "Add a brand color first.", href: "/app/brand" };
  }
  return { available: true };
}

/** Arrow key movement in the look radiogroup, skipping disabled cards. */
export function nextLook(current: LookKey, key: string, enabled: readonly LookKey[]): LookKey | null {
  if (enabled.length === 0) return null;
  const at = Math.max(0, enabled.indexOf(current));
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return enabled[(at + 1) % enabled.length] ?? null;
    case "ArrowLeft":
    case "ArrowUp":
      return enabled[(at - 1 + enabled.length) % enabled.length] ?? null;
    case "Home":
      return enabled[0] ?? null;
    case "End":
      return enabled[enabled.length - 1] ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Extra images

function creditsText(credits: number): string {
  return `${credits.toLocaleString("en-US")} ${credits === 1 ? "credit" : "credits"}`;
}

export interface ExtraRow {
  family: ExtraFamily;
  title: string;
  line: string;
}

/** The five rows with their typical cost, formatted from creditCosts. */
export function extraRows(): ExtraRow[] {
  const still = creditsText(creditCosts.generativeStill);
  const flat = creditsText(creditCosts.deterministic);
  return [
    { family: "scenes", title: "Lifestyle scenes", line: `Lifestyle scenes made around your real product. About ${still} each.` },
    { family: "backdrops", title: "Studio backdrops", line: `Studio backdrops in gray and your brand color. ${flat} each.` },
    { family: "transparentPng", title: "Transparent PNG", line: `Transparent PNG of your product. ${flat}.` },
    {
      family: "graphics",
      title: "Graphics",
      line: `Graphics with your benefits, sizes, box contents and comparisons. ${flat} each.`,
    },
    { family: "cards", title: "Social posts and banners", line: `Social posts and banners. ${flat} each.` },
  ];
}

export const EXTRAS_WITH_KEEP_NOTE =
  "These are made from a cut out copy of your product. Your own photos stay as they are.";

/** How many extra families are off. */
export function extrasOffCount(extras: OutputExtras): number {
  return EXTRA_FAMILY_KEYS.filter((family) => !extras[family]).length;
}

/** "Resize only": Keep with every extra off. */
export function isResizeOnly(choices: Pick<OutputChoices, "background" | "extras">): boolean {
  return choices.background === "keep" && extrasOffCount(choices.extras) === EXTRA_FAMILY_KEYS.length;
}

// ---------------------------------------------------------------------------
// More options

export const PHOTO_SHAPE_OPTIONS: ReadonlyArray<{ value: Exclude<OutputFit, "crop">; label: string }> = [
  { value: "auto", label: "Keep my photo's shape where the channel allows it" },
  { value: "pad", label: "Match each channel's shape and add space" },
];

/** Trim to the channel's shape, the third Photo shape choice (fit crop). */
export const TRIM_SHAPE_OPTION: { value: "crop"; label: string; helper: string } = {
  value: "crop",
  label: "Trim to each channel's shape",
  helper: "We never trim your product. Without room to trim, we add space instead.",
};

/** The Photo shape radio that is checked. */
export function formFit(state: Pick<OutputFormState, "choices" | "more">): FormFit {
  return state.choices.background === "keep" && state.more.trim ? "crop" : state.choices.fit;
}

export const SCENE_COUNT_LABEL = "Number of scenes";
export const SCENE_STYLE_LABEL = "Scene style";
export const LOGO_LABEL = "Logo on graphics";
export const PRODUCT_SIZE_LABEL = "Product size in the frame";
export const NEVER_ENLARGE_LABEL = "Never enlarge my photo";
export const NEVER_ENLARGE_HELPER = "Your photo is used at its own size or smaller. A channel that needs it bigger is left out.";
export const GRAPHICS_COLOR_LABEL = "Graphics follow your color";
export const GRAPHICS_COLOR_HELPER = "Graphics and cards use your background color instead of their usual one.";

/** "Off, 1, 2, 3, 4", from seed sceneCountOptions. */
export function sceneCountSelectOptions(): Array<{ value: string; label: string }> {
  const counts = Array.from(
    { length: sceneCountOptions.max - sceneCountOptions.min + 1 },
    (_, i) => sceneCountOptions.min + i,
  );
  return [{ value: SCENES_OFF, label: "Off" }, ...counts.map((n) => ({ value: String(n), label: String(n) }))];
}

/** The Number of scenes Select's value. */
export function sceneCountValue(state: Pick<OutputFormState, "choices" | "more">): string {
  return state.choices.extras.scenes ? String(state.more.sceneCount) : SCENES_OFF;
}

/** Parses a Number of scenes Select value. */
export function sceneCountFromValue(value: string): number | typeof SCENES_OFF | null {
  if (value === SCENES_OFF) return SCENES_OFF;
  const n = Number(value);
  return Number.isInteger(n) && n >= sceneCountOptions.min && n <= sceneCountOptions.max ? n : null;
}

/** Plain names for the seeded scene presets; a new preset needs a name here. */
export const SCENE_STYLE_NAMES: Readonly<Record<PresetKey, string>> = {
  minimal_studio: "Minimal studio",
  luxury_marble: "Marble",
  kitchen_lifestyle: "Kitchen",
  outdoor: "Outdoor",
  holiday: "Holiday",
};

/** "Auto, picked for your product", then every seeded preset. */
export function sceneStyleOptions(): Array<{ value: ScenePresetChoice; label: string }> {
  return [
    { value: SCENE_PRESET_AUTO, label: "Auto, picked for your product" },
    ...(Object.keys(presets) as PresetKey[]).map((key) => ({ value: key, label: SCENE_STYLE_NAMES[key] })),
  ];
}

export function isScenePresetChoice(value: string): value is ScenePresetChoice {
  return value === SCENE_PRESET_AUTO || Object.hasOwn(presets, value);
}

export const PRODUCT_SIZE_OPTIONS: ReadonlyArray<{ value: ProductSize; label: string }> = [
  { value: "standard", label: "Standard" },
  { value: "larger", label: "Larger" },
  { value: "smaller", label: "Smaller" },
];

export interface MoreOptionsContext {
  /** The brand kit has a logo, so Logo on graphics shows. */
  hasLogo?: boolean;
  /** Scenes are paused: the scene controls are disabled. */
  scenesPaused?: boolean;
}

/** Which More options controls show for these choices. Hidden controls never reach the body. */
export interface MoreOptionsVisibility {
  photoShape: boolean;
  sceneCount: boolean;
  sceneStyle: boolean;
  logo: boolean;
  productSize: boolean;
  neverEnlarge: boolean;
  graphicsColor: boolean;
}

export function moreOptionsVisibility(choices: OutputChoices, context: MoreOptionsContext = {}): MoreOptionsVisibility {
  const keep = choices.background === "keep";
  const graphicsOn = choices.extras.graphics || choices.extras.cards;
  return {
    photoShape: keep,
    sceneCount: true,
    sceneStyle: choices.extras.scenes && !context.scenesPaused,
    logo: !!context.hasLogo && graphicsOn,
    productSize: !keep,
    neverEnlarge: keep,
    graphicsColor: graphicsOn,
  };
}

/**
 * The More options controls that differ from the card the choices started
 * from: the photo shape (Trim included) and every P1 field the body sends.
 * Number of scenes counts only as a count; Off is an Extra images change.
 */
export function moreOptionsChanged(state: OutputFormState): number {
  const shape = formFit(state) === LOOK_PRESETS[state.lookBase].fit ? 0 : 1;
  return shape + Object.keys(p1OutputFields(state.choices, state.more)).length;
}

/** "More options", or "More options, 2 changed". */
export function moreOptionsSummary(changed: number): string {
  return changed > 0 ? `More options, ${changed} changed` : "More options";
}

// ---------------------------------------------------------------------------
// Preview strip

export interface PreviewFrame {
  specId: string;
  /** "Stays white", "Amazon other images", "Meta story, 1080 by 1920". */
  label: string;
  width: number;
  height: number;
  /** The frame is white whatever the color. */
  white: boolean;
}

/**
 * Two or three frames for the preview strip: the first white required spec
 * picked, the first gallery spec picked, and the tallest exact size spec
 * picked. Each spec appears once.
 */
export function previewFrames(selected: readonly string[], specs: readonly ChannelSpec[] = listSpecs()): PreviewFrame[] {
  const picked = specs.filter((spec) => selected.includes(spec.id));
  const frames: PreviewFrame[] = [];
  const add = (spec: ChannelSpec | undefined, label: (spec: ChannelSpec) => string) => {
    if (!spec || frames.some((f) => f.specId === spec.id)) return;
    const size = canvasSizeFor(spec);
    frames.push({ specId: spec.id, label: label(spec), ...size, white: requiresWhiteBackground(spec) });
  };
  add(
    picked.find((spec) => requiresWhiteBackground(spec)),
    () => "Stays white",
  );
  const gallery = GALLERY_SLOTS.map((slot) => slot.specId)
    .filter((id) => selected.includes(id) && hasSpec(id))
    .map(getSpec)
    .find((spec) => !requiresWhiteBackground(spec));
  add(gallery, (spec) => channelName(spec.id));
  const tallest = picked
    .filter((spec) => isExactSize(spec) && !spec.id.startsWith("video."))
    .sort((a, b) => canvasSizeFor(b).height / canvasSizeFor(b).width - canvasSizeFor(a).height / canvasSizeFor(a).width)[0];
  add(tallest, (spec) => {
    const size = canvasSizeFor(spec);
    return `${channelName(spec.id)}, ${size.width} by ${size.height}`;
  });
  return frames;
}

export const PREVIEW_CAPTION = "A quick preview. Your files are made to each channel's exact size and rules.";
export const PREVIEW_EMPTY = "Add a photo to see it here.";
export const PREVIEW_SILHOUETTE_LABEL = "Your product here";

/** The frame's background: white when the spec requires it, else the chosen color. */
export function frameHex(frame: PreviewFrame, colorHex: string): string {
  return frame.white ? stillStyle.whiteHex : colorHex;
}

// ---------------------------------------------------------------------------
// Pack summary

export const LISTING_MODE_LINE = "Built from your real photo. Your product is never redrawn.";

/** The lg summary card's first line. */
export function backgroundSummaryLine(choices: OutputChoices, hex: string): string {
  if (choices.background === "keep") {
    return "Background: kept as you took it";
  }
  const name = choices.color.kind === "swatch" ? backgroundSwatches[choices.color.key].label.toLowerCase() : colorLabel(choices.color, hex);
  return `Background: removed, on ${name}`;
}

/** "We hold 2 credits and give back what is not used." */
export function holdLine(total: number): string | null {
  if (total <= 0) return null;
  return `We hold ${creditsText(total)} and give back what is not used.`;
}

/** "About 2 credits" on the phone bar. */
export function totalLine(total: number): string {
  return `About ${creditsText(total)}`;
}

/**
 * The difference between looks: "Keep my photo uses 5 fewer credits than
 * Marketplace ready for this pack." Only when the difference is positive.
 */
export function lookDifferenceLine(keepTotal: number, marketplaceTotal: number): string | null {
  const diff = marketplaceTotal - keepTotal;
  if (diff <= 0) return null;
  return `${LOOK_TITLES.keep_photo} uses ${diff.toLocaleString("en-US")} fewer ${diff === 1 ? "credit" : "credits"} than ${LOOK_TITLES.marketplace} for this pack.`;
}

export const RESIZE_ONLY_BADGE = "Resize only";

// ---------------------------------------------------------------------------
// Analytics (enums and counts only, never a hex)

export interface PackCreatedOutputProps {
  [key: string]: string | number;
  look: Look;
  look_base: LookKey;
  background: OutputChoices["background"];
  color_kind: FormColorChoice["kind"];
  extras_off: number;
  kept_photos: number;
  fit: FormFit;
}

/** The pack_created properties the options add. kept_photos counts the
 * photos kept after each photo's own Background Select. */
export function packCreatedOutputProps(
  lookBase: LookKey,
  choices: OutputChoices,
  keptPhotos: number,
  more: MoreChoices = DEFAULT_MORE_CHOICES,
): PackCreatedOutputProps {
  const keep = choices.background === "keep";
  return {
    look: lookOf(choices),
    look_base: lookBase,
    background: choices.background,
    color_kind: keep && more.edgeMatch ? "edge_match" : choices.color.kind,
    extras_off: extrasOffCount(choices.extras),
    kept_photos: keptPhotos,
    fit: formFit({ choices, more }),
  };
}

export interface PackLookChangedProps {
  [key: string]: string;
  from: LookKey;
  to: LookKey;
}

export const PACK_LOOK_CHANGED_EVENT = "pack_look_changed";

/** The pack_look_changed properties, or null when the card did not change. */
export function packLookChangedProps(from: LookKey, to: LookKey): PackLookChangedProps | null {
  return from === to ? null : { from, to };
}

// ---------------------------------------------------------------------------
// Remember choices per product (P1, founder decision 7)

/** "Using your last choices for Ceramic mug." */
export function rememberedLine(title: string): string {
  return `Using your last choices for ${title}.`;
}

export const REMEMBERED_RESET_LABEL = `Start from ${LOOK_TITLES.marketplace}`;

const P1_KEYS = ["sceneCount", "scenePreset", "logo", "productSize", "enlarge", "graphicsColor"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads the P1 fields of stored choices; null when one is out of shape. */
function rememberedMore(raw: Record<string, unknown>): MoreChoices | null {
  const more = defaultMore();
  const { sceneCount, scenePreset, logo, productSize, enlarge, graphicsColor } = raw;
  if (sceneCount !== undefined) {
    if (typeof sceneCount !== "number" || sceneCountFromValue(String(sceneCount)) === null) return null;
    more.sceneCount = sceneCount;
  }
  if (scenePreset !== undefined) {
    if (typeof scenePreset !== "string" || !isScenePresetChoice(scenePreset)) return null;
    more.scenePreset = scenePreset;
  }
  for (const [key, value] of [
    ["logo", logo],
    ["enlarge", enlarge],
    ["graphicsColor", graphicsColor],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "boolean") return null;
    more[key] = value;
  }
  if (productSize !== undefined) {
    if (typeof productSize !== "string" || !(PRODUCT_SIZES as readonly string[]).includes(productSize)) return null;
    more.productSize = productSize as ProductSize;
  }
  if (raw.fit === "crop") more.trim = true;
  if (isPlainObject(raw.color) && raw.color.kind === "edge_match") more.edgeMatch = true;
  return more;
}

export interface RememberedContext {
  /** Brand colors the form can offer (the kit's usable colors, when the plan has kits). */
  brandColorCount: number;
}

/**
 * A product's remembered choices (products.output_defaults) as the form's
 * state, or null when there is nothing to prefill: no record, a record the
 * schema refuses (fail closed), or exactly Marketplace ready. A brand color
 * the kit no longer has falls back to the default swatch. It only ever
 * prefills the form; a request without options is always Marketplace ready.
 */
export function rememberedFormState(raw: unknown, context: RememberedContext): OutputFormState | null {
  if (!isPlainObject(raw)) return null;
  const more = rememberedMore(raw);
  if (!more) return null;
  const p0: Record<string, unknown> = { ...raw };
  for (const key of P1_KEYS) delete p0[key];
  if (p0.fit === "crop") p0.fit = "auto";
  if (isPlainObject(p0.color) && p0.color.kind === "edge_match") delete p0.color;
  let normalized;
  try {
    normalized = normalizeOutputOptions(p0 as OutputOptionsInput);
  } catch {
    return null;
  }
  const { lookBase: storedBase, ...rest } = normalized;
  const choices = copyChoices(rest);
  if (choices.color.kind === "brand" && choices.color.index >= context.brandColorCount) {
    choices.color = { kind: "swatch", key: DEFAULT_SWATCH_KEY };
  }
  if (choices.background !== "keep") {
    more.trim = false;
    more.edgeMatch = false;
  }
  const look = lookOf(choices);
  const lookBase: LookKey =
    storedBase && (LOOK_KEYS as readonly string[]).includes(storedBase) ? storedBase : look === "custom" ? "marketplace" : look;
  const state: OutputFormState = { lookBase, choices, more };
  const today = initialOutputForm();
  const unchanged =
    optionsIntentKey(state.choices, state.more) === optionsIntentKey(today.choices, today.more) &&
    lookBase === today.lookBase;
  return unchanged ? null : state;
}

// ---------------------------------------------------------------------------
// "Keep my background" hint (P1)

export const KEEP_BACKGROUND_HINT = `It sounds like you want to keep your background. Turn off ${SWITCH_LABEL}?`;
export const KEEP_BACKGROUND_HINT_ACTION = "Turn it off";

function normalizedNote(note: string): string {
  return note.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ").trim();
}

/** True when the note uses one of the seeded keep background phrases. */
export function noteAsksToKeepBackground(note: string, phrases: readonly string[] = keepBackgroundPhrases): boolean {
  const text = normalizedNote(note);
  if (!text) return false;
  return phrases.some((phrase) => {
    const p = normalizedNote(phrase);
    const at = text.indexOf(p);
    if (at < 0) return false;
    // Whole words only: "keep background" never matches "keep backgrounds".
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + p.length] ?? "";
    return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
  });
}

/** The hint line while the switch is on and the note asks to keep the background, else null. */
export function keepBackgroundHint(note: string, background: OutputChoices["background"]): string | null {
  return background === "remove" && noteAsksToKeepBackground(note) ? KEEP_BACKGROUND_HINT : null;
}

// ---------------------------------------------------------------------------
// Background per photo (P1)

export const PHOTO_BACKGROUND_OPTIONS: ReadonlyArray<{ value: PhotoBackground; label: string }> = [
  { value: "pack", label: "Pack setting" },
  { value: "remove", label: "Remove" },
  { value: "keep", label: "Keep as is" },
];

export function isPhotoBackground(value: string): value is PhotoBackground {
  return (PHOTO_BACKGROUNDS as readonly string[]).includes(value);
}

/** The accessible name of a photo's Background Select. */
export function photoBackgroundLabel(position: number): string {
  return `Background for photo ${position}`;
}

/** An upload's background field: sent only when the photo has its own. */
export function uploadBackgroundField(background: PhotoBackground | undefined): { background?: "remove" | "keep" } {
  return background === "remove" || background === "keep" ? { background } : {};
}

// ---------------------------------------------------------------------------
// Cutout preview (P1)

/**
 * What a preview frame shows: the seller's photo on a kept frame, the
 * cutout preview on a removed frame when the preflight made one, else the
 * silhouette. A white required frame never shows a kept photo.
 */
export type FramePicture = { kind: "photo"; src: string } | { kind: "cutout"; src: string } | { kind: "silhouette" } | { kind: "none" };

export function framePicture(
  frame: Pick<PreviewFrame, "white">,
  background: OutputChoices["background"],
  sources: { photoUrl?: string | null; cutoutUrl?: string | null; hasPhoto: boolean },
): FramePicture {
  const keptHere = background === "keep" && !frame.white;
  if (keptHere && sources.photoUrl) return { kind: "photo", src: sources.photoUrl };
  if (!keptHere && sources.cutoutUrl) return { kind: "cutout", src: sources.cutoutUrl };
  if (background === "remove" || sources.hasPhoto) return { kind: "silhouette" };
  return { kind: "none" };
}

export const EDGE_MATCH_PREVIEW_NOTE = "Added space takes the color of your photo's edges.";
