import { z } from "zod";

export const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Expected a six digit hex color like #1A2B3C");

const emojiPattern = /\p{Extended_Pictographic}/u;

/** A short text label with no emoji, used for on video copy. */
export function plainLabel(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !emojiPattern.test(value), {
      message: "Labels cannot contain emoji",
    });
}

export const brandColorsSchema = z.object({
  ink: hexColor.default("#111827"),
  accent: hexColor.default("#0E7490"),
  paper: hexColor.default("#FFFFFF"),
});

export type BrandColors = z.output<typeof brandColorsSchema>;

export const defaultBrandColors: BrandColors = {
  ink: "#111827",
  accent: "#0E7490",
  paper: "#FFFFFF",
};

export const videoFormatSchema = z.enum(["9x16", "1x1"]);
export type VideoFormat = z.output<typeof videoFormatSchema>;

export const fpsSchema = z.number().int().min(12).max(60);

export function dimensionsForFormat(format: VideoFormat): { width: number; height: number } {
  return format === "1x1" ? { width: 1080, height: 1080 } : { width: 1080, height: 1920 };
}

export const fontStack = '"Helvetica Neue", Helvetica, Arial, sans-serif';
