/**
 * Product features that exist in code but are not offered yet. A flag stays
 * false until the feature really works end to end in production, so the app
 * never offers something it cannot deliver (Phase 10 decision 1).
 */

/**
 * Concept Mode (text only renders with a visible Concept render label) needs
 * a concept text to image recipe and the corner label overlay in the
 * pipeline. Neither ships yet: a text only pack would end with no files, and
 * a photo pack would deliver composites without the label. While this is
 * false the new pack form hides the Concept option and the service rejects
 * mode "concept". The UI and service code paths stay in place for the day it
 * flips.
 */
export const CONCEPT_MODE_AVAILABLE = false;

/**
 * Seller output options (docs/phases/PHASE_15.md): the Look, Remove the
 * background, Background color, Extra images and Photo shape controls on the
 * new pack form. Set NEXT_PUBLIC_OUTPUT_OPTIONS=1 per environment once the
 * Trigger.dev worker that honors the options is deployed (worker first, then
 * the web app, then the flag). Read at call time on the server, and inlined
 * at build time in the browser.
 */
export function outputOptionsAvailable(): boolean {
  return process.env.NEXT_PUBLIC_OUTPUT_OPTIONS === "1";
}

/** The env flag as the page saw it at build or boot. */
export const OUTPUT_OPTIONS_AVAILABLE = outputOptionsAvailable();

/** The platform_settings row that switches output options off at runtime,
 * with no deploy. Seeded true (packages/pipeline/src/seed/credits.ts). */
export const OUTPUT_OPTIONS_SWITCH_KEY = "output_options_enabled";

/** How long a server process reuses the kill switch it read. */
export const OUTPUT_OPTIONS_SWITCH_CACHE_MS = 30_000;

const switchScope = globalThis as typeof globalThis & {
  __curviOutputOptionsSwitch?: { on: boolean; at: number };
};

/**
 * The kill switch, read through `read` (the stored platform_settings value,
 * or undefined when the row is missing) and cached per process for
 * OUTPUT_OPTIONS_SWITCH_CACHE_MS. Fails closed: only a stored true turns
 * options on, so a missing row, any other value or a failed read keeps them
 * off. The reader is injected so this module stays client safe.
 */
export async function outputOptionsSwitchOn(
  read: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<boolean> {
  const cached = switchScope.__curviOutputOptionsSwitch;
  if (cached && now() - cached.at < OUTPUT_OPTIONS_SWITCH_CACHE_MS) {
    return cached.on;
  }
  let on = false;
  try {
    on = (await read()) === true;
  } catch (err) {
    console.warn("[features] could not read the output options switch; treating it as off", err);
  }
  switchScope.__curviOutputOptionsSwitch = { on, at: now() };
  return on;
}

/** Forgets the cached kill switch (tests). */
export function resetOutputOptionsSwitchForTests(): void {
  delete switchScope.__curviOutputOptionsSwitch;
}
