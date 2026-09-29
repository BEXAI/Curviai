/**
 * Prompt compiler templates and style presets, verbatim from
 * CURVI_BUILD_PLAN.md section 5.4. Negative constraints are expressed as
 * positive instructions because FLUX.2 has no negative prompt field.
 */

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
