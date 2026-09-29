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
} as const;

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
