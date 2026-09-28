/**
 * Brand kit input validation (Update.md 4.2). The brand page posts the whole
 * kit object from the browser, so every field is parsed before it reaches the
 * service: hex colors (at most 6), a style preset from the seeded presets,
 * bounded names and fonts, and a logo key that is null or a plausible object
 * key. Whether the key belongs to the workspace is checked by the service,
 * which knows the workspace id.
 */

import { z } from "zod";
import { presets, type PresetKey } from "@curvi/pipeline/seed";

const presetKeys = Object.keys(presets) as [PresetKey, ...PresetKey[]];

// No control characters or angle brackets in names that end up in templates.
const SAFE_TEXT = /^[^\u0000-\u001F\u007F<>]*$/;

export const MAX_BRAND_COLORS = 6;

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
    heading: z.string().trim().max(80).regex(SAFE_TEXT),
    body: z.string().trim().max(80).regex(SAFE_TEXT),
  }),
  stylePreset: z.enum(presetKeys),
  logoKey: z.string().min(1).max(512).nullable().optional(),
});

export type BrandKitInput = z.infer<typeof brandKitInputSchema>;

/** A plain spoken notice for the first problem in a rejected kit. */
export function brandKitIssueNotice(error: z.ZodError): string {
  const field = error.issues[0]?.path[0];
  switch (field) {
    case "colors":
      return `Colors must look like #1D2433, with up to ${MAX_BRAND_COLORS} colors.`;
    case "stylePreset":
      return "Pick a style preset from the list.";
    case "logoKey":
      return "That logo upload could not be used. Upload it again.";
    case "name":
    case "fonts":
      return "Kit names and fonts must be 80 characters or fewer, with no special characters.";
    default:
      return "Check the brand kit fields and try again.";
  }
}
