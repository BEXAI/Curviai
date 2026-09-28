/**
 * Brand kit input validation (Update.md 4.2). The brand page posts the whole
 * kit object from the browser, so every field is parsed before it reaches the
 * service: hex colors (at most 6), a style preset from the seeded presets or
 * "auto", fonts from the seeded template font catalog, a bounded name, and a
 * logo key that is null or a plausible object key. Whether the key belongs to
 * the workspace is checked by the service, which knows the workspace id.
 */

import { z } from "zod";
import {
  AUTO_STYLE_PRESET,
  DEFAULT_TEMPLATE_FONT,
  isTemplateFontKey,
  presets,
  templateFonts,
  type PresetKey,
} from "@curvi/pipeline/seed";

const presetKeys = Object.keys(presets) as [PresetKey, ...PresetKey[]];

// No control characters or angle brackets in names that end up in templates.
const SAFE_TEXT = /^[^\u0000-\u001F\u007F<>]*$/;

export const MAX_BRAND_COLORS = 6;

const UNKNOWN_FONT = "unknown_font";

/**
 * A stored or posted font choice as a catalog key: "" for the default, the
 * key itself, or the key whose label matches (kits saved before the font
 * list stored names like "Inter"). null for anything else.
 */
export function normalizeFontChoice(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (text.length === 0) {
    return "";
  }
  if (isTemplateFontKey(text)) {
    return text === DEFAULT_TEMPLATE_FONT ? "" : text;
  }
  const lower = text.toLowerCase();
  for (const [key, entry] of Object.entries(templateFonts)) {
    if (entry.label.toLowerCase() === lower) {
      return key === DEFAULT_TEMPLATE_FONT ? "" : key;
    }
  }
  return null;
}

const fontChoice = z
  .string()
  .trim()
  .max(80)
  .regex(SAFE_TEXT)
  .transform((value) => normalizeFontChoice(value))
  .refine((value): value is string => value !== null, { message: UNKNOWN_FONT })
  .transform((value) => value ?? "");

export const brandKitInputSchema = z.object({
  name: z
    .string()
    .trim()
    .max(80)
    .regex(SAFE_TEXT)
    .transform((value) => value || "Default"),
  colors: z
    .array(z.string().regex(/^#[0-9A-Fa-f]{6}$/))
    .max(MAX_BRAND_COLORS),
  fonts: z.object({
    heading: fontChoice,
    body: fontChoice,
  }),
  stylePreset: z.enum([AUTO_STYLE_PRESET, ...presetKeys]),
  logoKey: z.string().min(1).max(512).nullable().optional(),
});

export type BrandKitInput = z.infer<typeof brandKitInputSchema>;

/** A plain spoken notice for the first problem in a rejected kit. */
export function brandKitIssueNotice(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path[0];
  switch (field) {
    case "colors":
      return `Colors must look like #1D2433, with up to ${MAX_BRAND_COLORS} colors.`;
    case "stylePreset":
      return "Pick a style preset from the list.";
    case "logoKey":
      return "That logo upload could not be used. Upload it again.";
    case "fonts":
      if (issue?.message === UNKNOWN_FONT) {
        return "Pick a font from the list.";
      }
      return "Kit names and fonts must be 80 characters or fewer, with no special characters.";
    case "name":
      return "Kit names and fonts must be 80 characters or fewer, with no special characters.";
    default:
      return "Check the brand kit fields and try again.";
  }
}
