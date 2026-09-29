/**
 * Prompt compiler templates and style presets, verbatim from
 * CURVI_BUILD_PLAN.md section 5.4. Negative constraints are expressed as
 * positive instructions because FLUX.2 has no negative prompt field.
 */

import { Shot } from "../schemas";

export const presets = {
  minimal_studio: { surface: "clean matte light gray tabletop in front of a smooth, evenly lit pale gray wall" },
  luxury_marble: { surface: "white Carrara marble slab with soft window light" },
  kitchen_lifestyle: { surface: "warm oak kitchen counter, blurred modern kitchen background" },
  outdoor: { surface: "natural stone ledge in late afternoon sun, shallow depth of field" },
  holiday: { surface: "cream linen with out of focus warm string lights" },
} as const;

export type PresetKey = keyof typeof presets;

export const templates = {
  /** Scene plate prompt. A repair hint from the QC judge is appended on
   * retries so the next plate fixes what the previous attempt got wrong. */
  lifestyle_plate_flux2: ({ scene, preset, repairHint }: { scene: string; preset: PresetKey; repairHint?: string }) => {
    // The light is described by its look, never by its equipment: naming
    // softboxes or fill cards made the image model draw them into the frame.
    // Secondary images follow the marketplace norm of a real setting where
    // the product is used, with nothing in the frame that reveals a studio.
    const base = `Editorial lifestyle photograph of a real ${scene}, ${presets[preset].surface}, with an empty clear spot at the center of the surface where a product will stand. Soft, even, natural looking light from the upper left with gentle shadows and a subtle highlight along edges, true to life color, shallow depth of field so the background falls into a soft blur, eye level camera. The whole frame shows only the setting itself: no photography equipment, lights, stands, tripods, reflectors, cables, backdrop paper or backdrop edges anywhere in the picture, and no checkerboard or transparency pattern. No text, no people, no other products.`;
    const hint = repairHint?.trim();
    return hint ? `${base} Repair instruction from the previous attempt: ${hint}` : base;
  },
  harmonize_nano_banana2: () =>
    `Keep the product exactly as it is: do not change its label, logo, text, shape, color or size. Only adjust the surrounding light so the scene matches the product, and add a soft realistic contact shadow beneath it.`,
  /** Scene used when a composite shot arrives without one, e.g. "lifestyle setting". */
  scene_fallback: ({ shotLabel }: { shotLabel: string }) => `${shotLabel} setting`,
};

/** Defaults the scene plate compiler falls back to (CLAUDE.md rule 2). */
export const sceneDefaults = {
  /** Style preset when a shot names none or an unknown one. */
  preset: "minimal_studio",
} as const satisfies { preset: PresetKey };

/**
 * Canvas and placement defaults for live renders when a channel spec leaves
 * them open (for example Google Merchant sets only a minimum size). Seed data
 * per CLAUDE.md rule 2, so no renderer carries its own layout literals.
 */
export const canvasDefaults = {
  /** Canvas width, and height for square canvases, when the spec fixes none;
   * raised to the spec minimum when that is larger. */
  width: 2000,
  /** Product longest side over the canvas shortest side for composites when
   * the spec sets no fill rule. */
  compositeFill: 0.55,
  /** Product longest side over the canvas longest side for the transparent
   * cutout when the spec sets no fill rule. */
  cutoutFillTarget: 0.875,
  /** Largest share of either canvas axis the placed product may cover. */
  maxAxisShare: 0.98,
  /**
   * Product longest side over the canvas longest side for removed photos,
   * per the seller's "Product size in the frame" (PHASE_15 P1). Clamped to
   * spec.fill where the spec sets one, so amazon.main stays within its
   * registry range whatever the seller picks. Standard is today's target.
   */
  productSizeFill: {
    standard: 0.875,
    larger: 0.93,
    smaller: 0.75,
  },
} as const;

/**
 * Lifestyle scenes per pack (PHASE_15 P1 "Number of scenes", founder
 * decision 4): the seller picks from min to max, and a pack that names no
 * count plans the default, for every category.
 */
export const sceneCountOptions = {
  min: 1,
  max: 4,
  default: 3,
} as const;

/**
 * Scenes that fill a pack's scene count after the category's required
 * scenes and the seller's use contexts, in order. At least sceneCountOptions
 * .max entries, so every count can be planned exactly.
 */
export const lifestyleFallbackScenes = [
  "clean studio scene",
  "everyday use scene",
  "styled tabletop scene",
  "close detail scene",
] as const;

/**
 * Colors for deterministic and template stills (gray sweep, brand sweep
 * fallback, template backgrounds and text). Seed data per CLAUDE.md rule 2,
 * so no renderer hardcodes a color. Template backgrounds follow the shot's
 * style preset.
 */
export const stillStyle = {
  sweepGrayHex: "#D9DADC",
  /** Used for sweep_brand when the workspace has no brand kit color yet. */
  fallbackBrandHex: "#3A4556",
  presetBackgroundHex: {
    minimal_studio: "#ECECEE",
    luxury_marble: "#F3F1ED",
    kitchen_lifestyle: "#EADFCF",
    outdoor: "#DDE4D8",
    holiday: "#F0E7DB",
  } satisfies Record<PresetKey, string>,
  /** Background when the preset is "none" or unknown. */
  defaultBackgroundHex: "#F4F4F5",
  textHex: "#1B1F24",
  accentHex: "#FD7F11",
  /** Pure white for backgrounds, edge blends and flattening. White required
   * specs still take their white from the registry background rgb. */
  whiteHex: "#FFFFFF",
  /**
   * A background below this CIE L* can show a light edge around a cut out
   * product: its edge pixels still carry the light studio background it was
   * photographed on. Set from the dark swatch gate
   * (deterministic/fringe.test.ts), where a navy product shows a fringe on
   * every gray below L* 70 and none above. A custom color below it gets the
   * line "Dark colors can show a light edge around your product."
   */
  lightEdgeBelowLightness: 70,
  /** Template text on a card whose background is dark ("Graphics follow
   * your color", PHASE_15 P1). */
  textOnDarkHex: "#FFFFFF",
  /**
   * A card background whose WCAG relative luminance (0 to 1) is below this
   * takes textOnDarkHex instead of textHex. 0.179 is where white text and
   * textHex give about the same contrast.
   */
  darkBackgroundLuminance: 0.179,
} as const;

/**
 * Background colors the seller can pick in the new pack form (PHASE_15
 * control 3), in dropdown order. Every value except white reuses a hex
 * already seeded above. Keys are stored on jobs, so never rename one.
 *
 * Slate (#3A4556) and charcoal (#1B1F24) failed the dark swatch gate
 * (deterministic/fringe.test.ts shows a light fringe around a dark product
 * on both), so they wait for P1 and are not offered in P0.
 */
export const backgroundSwatches = {
  white: { label: "White", hex: "#FFFFFF" },
  light_gray: { label: "Light gray", hex: "#F4F4F5" },
  studio_gray: { label: "Studio gray", hex: "#D9DADC" },
  warm_white: { label: "Warm white", hex: "#F3F1ED" },
  sand: { label: "Sand", hex: "#EADFCF" },
  sage: { label: "Sage", hex: "#DDE4D8" },
} as const satisfies Record<string, { label: string; hex: string }>;

export type BackgroundSwatchKey = keyof typeof backgroundSwatches;

/**
 * Limits for kept photos (PHASE_15 control 6 and the fidelity section).
 * Every kept output, passthrough included, is capped at maxMegapixels so a
 * 512 MB worker can hold the render, the reference and the decode. A photo
 * whose ICC profile description is one of srgbProfileNames counts as sRGB and
 * may ship unchanged.
 */
export const originalFit = {
  maxMegapixels: 16,
  srgbProfileNames: [
    "sRGB",
    "sRGB IEC61966-2.1",
    "sRGB IEC61966-2-1 black scaled",
    "sRGB built-in",
    "sRGB2014",
    "c2",
  ],
  /** Trim to the channel's shape (P1 crop fit): the margin kept around the
   * product box on every side, as a share of the box's longest side. */
  cropMarginShare: 0.05,
  /** Match my photo's edges (P1): the width in pixels of the photo's outer
   * ring whose median color fills the added space. */
  edgeRingPx: 2,
  /** Memory (512 MB workers): the most RSS, in MB, one kept output of an
   * 80 MP photo may add above the resting process while its source, the
   * render, the reference, the encode and the shipped decode are all held,
   * as the runner holds them. The 512 MB worker less 128 MB for the runner at
   * rest. A test holds it; if it fails, maxMegapixels drops to 12. */
  peakRssAddedMb: 384,
} as const;

/**
 * JPEG encoding (raw.ts encodeJpeg). libjpeg's optimized Huffman coding
 * holds every DCT coefficient of the image until the end, about 180 MB more
 * peak memory on a 16 MP kept photo, for files about 6 percent smaller.
 * Above this size it is off, so a kept photo at the originalFit cap fits a
 * 512 MB worker; every generated canvas is under it and encodes as before.
 */
export const jpegEncoding = {
  optimiseCodingMaxMegapixels: 8,
} as const;

/**
 * The "Made with Curvi" badge on social exports (plan 9.6.3). Seed data per
 * CLAUDE.md rule 2, so the packager carries no layout literals. The badge is
 * drawn only on specs with badgeAllowed, never on a marketplace spec, and
 * only in a corner clear of the product mask.
 */
export const badgeStyle = {
  text: "Made with Curvi",
  /** Font size as a share of the canvas shortest side. */
  fontOfShort: 0.022,
  /** Smallest font size in pixels, so small canvases stay legible. */
  minFontPx: 12,
  /** Gap from the canvas edge, or from the spec safe zone, as a share of the shortest side. */
  marginOfShort: 0.025,
  /** Pill padding as a share of the font size. */
  padXOfFont: 0.75,
  padYOfFont: 0.45,
  /** Clearance kept between the pill and any product pixel, as a share of the font size. */
  productClearanceOfFont: 0.5,
  backgroundHex: "#1B1F24",
  backgroundOpacity: 0.78,
  textHex: "#FFFFFF",
} as const;

/** One pack bundle (PHASE_16 workstream 1); see packBundles. */
export interface PackBundle {
  key: string;
  label: string;
  shotTypes: readonly Shot["type"][];
  aplusModules?: readonly Shot["type"][];
  extras: Readonly<Record<"scenes" | "backdrops" | "transparentPng" | "graphics" | "cards" | "ads", boolean>>;
  maxSecondary?: number;
}

/** The main image of every marketplace: the Amazon main image, the white
 * front image, a kept front photo and the Shopify collection thumbnail. */
const MAIN_SHOT_TYPES: readonly Shot["type"][] = ["amazon_main", "alt_angle_white", "original_photo", "collection_thumb"];

/**
 * Pack bundles (PHASE_16 workstream 1): "how much" a pack makes, next to
 * Phase 15's Looks, which answer "how it looks". Seed data per CLAUDE.md
 * rule 2, so the planner, the estimate and the form read one definition.
 * - shotTypes: the shot types the bundle may plan. Any other shot type is
 *   skipped as not in the chosen set, before the channel limits.
 * - aplusModules: the A+ module shot types the bundle adds on top
 *   (workstream 2 adds its module types here and to Shot.type).
 * - extras: the Extra images switches the bundle starts from with Remove
 *   (Keep starts with every extra off). A family can only be on when the
 *   bundle holds one of its shot types.
 * - maxSecondary: the most other angle images (a white alternate angle, or
 *   a kept photo other than the front one) the bundle plans; absent is no cap.
 * Keys are stored on jobs, so never rename one. `everything` is today's pack
 * and takes every shot type the schema has, new ones included.
 */
export const packBundles = {
  main: {
    key: "main",
    label: "Main image only",
    shotTypes: MAIN_SHOT_TYPES,
    extras: { scenes: false, backdrops: false, transparentPng: false, graphics: false, cards: false, ads: false },
    maxSecondary: 0,
  },
  listing: {
    key: "listing",
    label: "Listing set",
    shotTypes: [
      ...MAIN_SHOT_TYPES,
      "cutout_png",
      "sweep_gray",
      "sweep_brand",
      "lifestyle",
      "infographic",
      "dimensions",
      "in_the_box",
      "comparison",
    ],
    extras: { scenes: true, backdrops: true, transparentPng: true, graphics: true, cards: false, ads: false },
  },
  aplus: {
    key: "aplus",
    label: "A+ set",
    shotTypes: MAIN_SHOT_TYPES,
    aplusModules: [
      "aplus_banner",
      "aplus_pain_points",
      "aplus_features",
      "aplus_ingredients",
      "aplus_results",
      "aplus_how_to",
      "aplus_endorsement",
    ],
    extras: { scenes: false, backdrops: false, transparentPng: false, graphics: false, cards: true, ads: false },
    maxSecondary: 0,
  },
  everything: {
    key: "everything",
    label: "Everything",
    shotTypes: Shot.shape.type.options,
    // The ads family (PHASE_16 workstream 3) is shown here but starts off.
    extras: { scenes: true, backdrops: true, transparentPng: true, graphics: true, cards: true, ads: false },
  },
} as const satisfies Record<string, PackBundle>;

export type PackBundleKey = keyof typeof packBundles;

// ---------------------------------------------------------------------------
// A+ modules (PHASE_16 workstream 2): template cards around the real product.

/** How a module's lines are drawn: a dotted list, numbered steps, short
 * labels, or the seller's quotes. */
export type AplusModuleLayout = "list" | "steps" | "labels" | "quotes";

/** One A+ module; see aplusModules. */
export interface AplusModuleSeed {
  /** Plain name, for logs and the copy request. */
  label: string;
  /** The registry spec the module is rendered for (docs/verification.md,
   * 2026-09-29). Every module uses the 970 by 600 header today, the one A+
   * spec the new pack form offers; the 970 by 300 wide banner and the
   * smaller image slots stay in the registry, coming soon, until a module
   * that suits them ships. */
  specId: string;
  /** Where the lines come from: the copy_generator recipe (then the claims
   * guard), or only what the seller typed. */
  copy: "generated" | "seller";
  layout: AplusModuleLayout;
  /** Fewest and most lines the module prints. Fewer usable lines than
   * minLines skips the module; it is never padded. */
  minLines: number;
  maxLines: number;
  /** Analyzer compliance flags that drop the module (a results card never
   * ships for a product flagged for a medical or food claim). */
  dropOnComplianceFlags?: readonly string[];
  /** What the copy request asks the recipe to write, in plain words. */
  brief: string;
}

/**
 * The six A+ modules workstream 2 adds next to the hero banner
 * (aplus_banner), in plan order. Seed data per CLAUDE.md rule 2: specs,
 * line counts and briefs change here, never in the planner or renderer.
 */
export const aplusModules = {
  aplus_features: {
    label: "features",
    specId: "amazon.aplus.basic_header",
    copy: "generated",
    layout: "list",
    minLines: 3,
    maxLines: 5,
    brief: "Headline and 3 to 5 short lines, each one feature you can see in the photos or the seller named.",
  },
  aplus_pain_points: {
    label: "pain points",
    specId: "amazon.aplus.basic_header",
    copy: "generated",
    layout: "list",
    minLines: 3,
    maxLines: 5,
    brief: "Headline and 3 to 5 short lines, each an everyday problem the product's visible features solve, phrased as the problem solved.",
  },
  aplus_how_to: {
    label: "how to use",
    specId: "amazon.aplus.basic_header",
    copy: "generated",
    layout: "steps",
    minLines: 3,
    maxLines: 5,
    brief: "Headline and 3 to 5 short steps in order, each starting with a verb, for using the product as the photos show it.",
  },
  aplus_ingredients: {
    label: "ingredients or materials",
    specId: "amazon.aplus.basic_header",
    copy: "generated",
    layout: "labels",
    minLines: 2,
    maxLines: 5,
    brief: "Headline and 2 to 5 short labels, each one material or ingredient exactly as the profile or the seller names it.",
  },
  aplus_results: {
    label: "results",
    specId: "amazon.aplus.basic_header",
    copy: "generated",
    layout: "list",
    minLines: 3,
    maxLines: 5,
    dropOnComplianceFlags: ["medical_claim", "food_claim"],
    brief: "Headline and 3 to 5 short lines on what everyday use looks like, in plain terms, with no numbers and no health, body or efficacy outcomes.",
  },
  aplus_endorsement: {
    label: "endorsement",
    specId: "amazon.aplus.basic_header",
    copy: "seller",
    layout: "quotes",
    minLines: 1,
    maxLines: 3,
    brief: "Only the press quotes or awards the seller typed, never written by a model and never customer reviews.",
  },
} as const satisfies Record<string, AplusModuleSeed>;

export type AplusModuleKey = keyof typeof aplusModules;

/**
 * A+ copy slot limits and the claims guard (PHASE_16 workstream 2). The
 * Amazon hosted guideline suggests titles of 30 characters for image
 * modules; our cards print on the image itself, so a headline and each line
 * keep to the Shot schema's 40 character cap (docs/verification.md).
 * - maxModulesPerDocument: an A+ document holds at most 7 modules for a
 *   selling partner (SP-API aplusContent 2020-11-01, checked 2026-09-29), so
 *   a pack never plans more A+ files than that.
 * - blockedTerms: words that make a medical, efficacy, guarantee or ranking
 *   claim. A generated line holding one is dropped unless the seller typed
 *   that word; a generated number is dropped unless the seller typed it.
 */
export const aplusCopy = {
  headlineMaxChars: 40,
  lineMaxChars: 40,
  maxModulesPerDocument: 7,
  blockedTerms: [
    "cure",
    "cures",
    "treat",
    "treats",
    "treatment",
    "heal",
    "heals",
    "healing",
    "prevent",
    "prevents",
    "relief",
    "relieve",
    "relieves",
    "remedy",
    "therapy",
    "therapeutic",
    "medical",
    "medicinal",
    "clinical",
    "clinically",
    "proven",
    "doctor",
    "doctors",
    "dermatologist",
    "fda",
    "approved",
    "certified",
    "guarantee",
    "guaranteed",
    "detox",
    "immune",
    "disease",
    "anti aging",
    "antibacterial",
    "kills",
    "germs",
    "weight loss",
    "burns fat",
    "percent",
    "per cent",
    "twice",
    "double",
    "triple",
    "best",
    "number one",
    "#1",
    "no. 1",
    "miracle",
    "top rated",
    "satisfaction guaranteed",
    "instant results",
    "permanent",
  ],
} as const;

// ---------------------------------------------------------------------------
// Ads formats (PHASE_16 workstream 3): the moodboard pin, the carousel and the
// static ad pack. Every size, safe zone and text limit comes from the
// registry; these are the layout choices and the words the planner may print.

/** One beat of the carousel story, in slide order. */
export type CarouselBeat = "hook" | "benefit" | "details" | "in_the_box" | "cta";

/**
 * The formats of the ads extra family, seed data per CLAUDE.md rule 2.
 * - lineMaxChars: the longest line printed on an ads image, the Shot
 *   schema's 40 character cap. A placement whose registry text limit is
 *   shorter (Facebook feed headlines, 27) takes only headlines that fit.
 * - pin: the 2:3 moodboard pin, the product (on its scene when scenes are
 *   on) with one short line.
 * - carousel: slides of one wide canvas cut into equal parts (founder
 *   decision 4). The story runs hook, benefits (one slide each, at most
 *   maxBenefitSlides), details (up to maxDetailLines features), in the box
 *   (only with the seller's lines), then the call to action. Fewer than
 *   minSlides and the carousel is skipped; never more than maxSlides (Meta
 *   and Pinterest carousels take 10, docs/verification.md).
 * - adPack: static ad variants, each a headline and a call to action,
 *   rendered for every picked placement inside its safe zone. The variant
 *   count is the most the product's usable headlines allow, from
 *   minVariants to maxVariants; fewer than minVariants and the pack is
 *   skipped. Calls to action are plain phrases, one per variant in order.
 */
export const adsFormats = {
  lineMaxChars: 40,
  pin: {
    specId: "pinterest.pin",
  },
  carousel: {
    specId: "meta.feed_4x5",
    minSlides: 3,
    maxSlides: 10,
    maxBenefitSlides: 3,
    maxDetailLines: 3,
    beats: ["hook", "benefit", "details", "in_the_box", "cta"] as readonly CarouselBeat[],
    callToAction: "Shop now",
    /** The continuous background runs from the card color at the first
     * slide's left edge to the card color mixed this much with the accent
     * at the last slide's right edge. */
    gradientAccentShare: 0.14,
  },
  adPack: {
    placements: [
      "meta.feed_1x1",
      "meta.feed_4x5",
      "meta.story_9x16",
      "meta.reels_9x16",
      "tiktok.ad_9x16",
      "pinterest.pin",
    ],
    minVariants: 4,
    maxVariants: 6,
    callsToAction: ["Shop now", "See the details", "Get yours today", "Take a closer look", "Find out more", "Order yours"],
  },
} as const;
