/**
 * Applies a brand kit's style preset to a finished shot plan. Both planners
 * (the LLM recipe and planShots) pick a preset per shot from the product
 * category; a kit that names a preset replaces it on every shot that uses
 * one (lifestyle scenes, the Shopify hero, A+ banners, social crops).
 * Shots planned with "none" (white main, alternate angles, cutouts, text
 * cards) keep it, and so do reflective or transparent products, which
 * planner rule 5 keeps on soft even light (minimal_studio).
 *
 * The seller's Scene style for one pack (PHASE_15 P1 scenePreset) wins over
 * the kit's preset when it is not auto, under the same rules.
 */
import { presets, type PresetKey } from "../seed/templates";
import type { ProductProfile, ShotList } from "../schemas";

export { AUTO_STYLE_PRESET } from "../seed/brand";

export function brandStylePreset(value: string | null | undefined): PresetKey | null {
  return typeof value === "string" && Object.hasOwn(presets, value) ? (value as PresetKey) : null;
}

export function applyBrandStylePreset(
  plan: ShotList,
  preset: string | null | undefined,
  profile: Pick<ProductProfile, "surface">,
  scenePreset?: string | null,
): ShotList {
  const chosen = brandStylePreset(scenePreset) ?? brandStylePreset(preset);
  if (!chosen || profile.surface.reflective || profile.surface.transparent) {
    return plan;
  }
  return {
    ...plan,
    shots: plan.shots.map((shot) =>
      shot.stylePreset === "none" || shot.stylePreset === chosen ? shot : { ...shot, stylePreset: chosen },
    ),
  };
}
