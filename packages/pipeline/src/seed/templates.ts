/**
 * Prompt compiler templates and style presets, verbatim from
 * CURVI_BUILD_PLAN.md section 5.4. Negative constraints are expressed as
 * positive instructions because FLUX.2 has no negative prompt field.
 */

export const presets = {
  minimal_studio: { surface: "seamless light gray paper sweep" },
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
    const base = `Professional commercial product photograph, empty ${scene} set prepared for a product placed at center, ${presets[preset].surface}, softbox key light at 45 degrees camera left, white fill card camera right, subtle rim light, shot on 100mm macro lens at f/8, focus stacked, color accurate, natural contact area on the surface at center, no text, no people, no other products.`;
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
