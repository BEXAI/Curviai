/**
 * Template fonts a brand kit can pick for text on infographic and dimensions
 * stills. Each entry names a Google font package pinned in
 * packages/pipeline/package.json and the TTF inside it, so the renderer
 * never goes through a system font stack (see templates/font.ts). Licenses
 * are recorded in docs/verification.md. The first entry is the default and
 * the fallback whenever a kit names no font, an unknown one, or one whose
 * file cannot be found on the host.
 */

export interface TemplateFontEntry {
  /** Name shown in the brand kit form. */
  label: string;
  /** npm package that ships the TTF. */
  packageName: string;
  /** Path of the TTF inside the package. */
  file: string;
}

export const templateFonts = {
  inter: {
    label: "Inter",
    packageName: "@expo-google-fonts/inter",
    file: "600SemiBold/Inter_600SemiBold.ttf",
  },
  montserrat: {
    label: "Montserrat",
    packageName: "@expo-google-fonts/montserrat",
    file: "600SemiBold/Montserrat_600SemiBold.ttf",
  },
  playfair_display: {
    label: "Playfair Display",
    packageName: "@expo-google-fonts/playfair-display",
    file: "700Bold/PlayfairDisplay_700Bold.ttf",
  },
  lora: {
    label: "Lora",
    packageName: "@expo-google-fonts/lora",
    file: "600SemiBold/Lora_600SemiBold.ttf",
  },
  roboto_slab: {
    label: "Roboto Slab",
    packageName: "@expo-google-fonts/roboto-slab",
    file: "600SemiBold/RobotoSlab_600SemiBold.ttf",
  },
} as const satisfies Record<string, TemplateFontEntry>;

export type TemplateFontKey = keyof typeof templateFonts;

/** The font used when a kit picks none. */
export const DEFAULT_TEMPLATE_FONT: TemplateFontKey = "inter";

export function isTemplateFontKey(value: unknown): value is TemplateFontKey {
  return typeof value === "string" && Object.hasOwn(templateFonts, value);
}
