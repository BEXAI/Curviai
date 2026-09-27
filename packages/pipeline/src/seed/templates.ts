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
  lifestyle_plate_flux2: ({ scene, preset }: { scene: string; preset: PresetKey }) =>
    `Professional commercial product photograph, empty ${scene} set prepared for a product placed at center, ${presets[preset].surface}, softbox key light at 45 degrees camera left, white fill card camera right, subtle rim light, shot on 100mm macro lens at f/8, focus stacked, color accurate, natural contact area on the surface at center, no text, no people, no other products.`,
  harmonize_nano_banana2: () =>
    `Keep the product exactly as it is: do not change its label, logo, text, shape, color or size. Only adjust the surrounding light so the scene matches the product, and add a soft realistic contact shadow beneath it.`,
};
