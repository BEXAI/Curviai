/**
 * What was done to a delivered file's background and pixels (PHASE_15
 * packager item 9), and the machine notes that describe it. Pure and client
 * safe: the packager writes these notes into the compliance report, the web
 * demo emits the same ones, and the web copy maps each note to one sentence
 * through parseTreatmentNote, so no note string is written twice.
 */
import { z } from "zod";
import { stillStyle } from "./seed/templates";

const HexValue = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/**
 * How a delivered file was treated:
 * - original: a kept photo, rendered (resized, padded, converted or filled).
 * - original_unchanged: a kept photo shipped as the stored bytes.
 * - background: a cut out product placed on a background color.
 */
export const PackAssetTreatment = z
  .object({
    kind: z.enum(["original", "original_unchanged", "background"]),
    /** The stored upload was decoded and written again at ingest (rotated, GIF, TIFF). */
    reencodedAtUpload: z.boolean().optional(),
    /** Flat added space in this color. */
    padHex: HexValue.optional(),
    /** Trimmed around the product box (P1 crop fit). */
    cropped: z.boolean().optional(),
    /** Resize factor applied to the photo; 1 means none. */
    scale: z.number().positive().optional(),
    /** Stored photo size, for the resized note. */
    sourceWidth: z.number().int().positive().optional(),
    sourceHeight: z.number().int().positive().optional(),
    /** The spec requires white, so white was used instead of the seller's color. */
    forcedWhite: z.boolean().optional(),
    /** Converted to sRGB (a non sRGB profile, CMYK or 16 bit). */
    colorConverted: z.boolean().optional(),
    /** Transparent areas of the photo were filled with this color. */
    alphaFilledHex: HexValue.optional(),
    /** The kept photo shows other items, which stay in the picture. */
    otherItems: z.boolean().optional(),
    /** The kept photo already had a pure white background, so it was only
     * cropped, resized and padded with white for a white required spec. */
    alreadyWhite: z.boolean().optional(),
    /** The background color behind a cut out product. */
    colorHex: HexValue.optional(),
  })
  .strict();
export type PackAssetTreatment = z.infer<typeof PackAssetTreatment>;

/** Scale factors closer to 1 than this are not reported as a resize. */
const SCALE_EPSILON = 1e-6;

/** Every treatment note, fixed text or built from a value. */
export const TREATMENT_NOTES = {
  keptAtSellerRequest: "background: kept at seller request",
  unchangedFile: "original: unchanged file",
  turnedUpright: "original: stored copy, turned upright at upload",
  resizedFrom: (width: number, height: number) => `original: resized from ${width}x${height}`,
  padded: (hex: string) => `original: padded ${hex.toUpperCase()}`,
  cropped: "original: cropped around product",
  enlarged: (scale: number) => `original: enlarged ${scale.toFixed(1)}x`,
  colorConverted: "original: color converted to srgb",
  alphaFilled: (hex: string) => `original: transparent areas filled ${hex.toUpperCase()}`,
  otherItems: "original: other items kept",
  alreadyWhite: "original: already white",
  whiteRequired: "background: white required",
  color: (hex: string) => `background: color ${hex.toUpperCase()}`,
} as const;

export type TreatmentNoteKey = keyof typeof TREATMENT_NOTES;

/** The fixed start of each note that carries a value. */
export const TREATMENT_NOTE_PREFIXES = {
  resizedFrom: "original: resized from ",
  padded: "original: padded ",
  enlarged: "original: enlarged ",
  alphaFilled: "original: transparent areas filled ",
  color: "background: color ",
} as const satisfies Partial<Record<TreatmentNoteKey, string>>;

/**
 * The machine notes for one delivered file, in a stable order. A kept photo
 * says it was kept (or already white), then what happened to it; a
 * background file says white was required or which color it got.
 */
export function treatmentNotes(treatment: PackAssetTreatment | null | undefined): string[] {
  if (!treatment) {
    return [];
  }
  const notes: string[] = [];
  if (treatment.kind === "background") {
    if (treatment.forcedWhite) {
      notes.push(TREATMENT_NOTES.whiteRequired);
    } else if (treatment.colorHex && treatment.colorHex.toUpperCase() !== stillStyle.whiteHex.toUpperCase()) {
      notes.push(TREATMENT_NOTES.color(treatment.colorHex));
    }
    return notes;
  }
  notes.push(treatment.alreadyWhite ? TREATMENT_NOTES.alreadyWhite : TREATMENT_NOTES.keptAtSellerRequest);
  if (treatment.kind === "original_unchanged") {
    notes.push(TREATMENT_NOTES.unchangedFile);
  }
  if (treatment.reencodedAtUpload) {
    notes.push(TREATMENT_NOTES.turnedUpright);
  }
  if (treatment.cropped) {
    notes.push(TREATMENT_NOTES.cropped);
  }
  const scale = treatment.scale;
  if (scale !== undefined && scale < 1 - SCALE_EPSILON && treatment.sourceWidth && treatment.sourceHeight) {
    notes.push(TREATMENT_NOTES.resizedFrom(treatment.sourceWidth, treatment.sourceHeight));
  }
  if (scale !== undefined && scale > 1 + SCALE_EPSILON) {
    notes.push(TREATMENT_NOTES.enlarged(scale));
  }
  if (treatment.colorConverted) {
    notes.push(TREATMENT_NOTES.colorConverted);
  }
  if (treatment.alphaFilledHex) {
    notes.push(TREATMENT_NOTES.alphaFilled(treatment.alphaFilledHex));
  }
  if (treatment.padHex) {
    notes.push(TREATMENT_NOTES.padded(treatment.padHex));
  }
  if (treatment.otherItems) {
    notes.push(TREATMENT_NOTES.otherItems);
  }
  return notes;
}

/** A treatment note read back: which note it is and the value it carries. */
export interface ParsedTreatmentNote {
  key: TreatmentNoteKey;
  /** "2000x1500", "#1F2A44" or "1.3" for notes that carry a value. */
  value?: string;
}

/** Reads a compliance report note back into its key, or null when it is not a treatment note. */
export function parseTreatmentNote(note: string): ParsedTreatmentNote | null {
  for (const [key, entry] of Object.entries(TREATMENT_NOTES)) {
    if (typeof entry === "string" && entry === note) {
      return { key: key as TreatmentNoteKey };
    }
  }
  for (const [key, prefix] of Object.entries(TREATMENT_NOTE_PREFIXES)) {
    if (note.startsWith(prefix)) {
      const value = note.slice(prefix.length);
      return { key: key as TreatmentNoteKey, value: key === "enlarged" ? value.replace(/x$/, "") : value };
    }
  }
  return null;
}
