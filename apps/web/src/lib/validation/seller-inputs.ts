/**
 * Request validation for the seller inputs a pack carries: the role of each
 * photo, the SKU, box contents and comparison facts. The limits come from
 * @curvi/pipeline/seller-inputs, the same ones the planner and the still
 * templates use, so the API refuses a line the image could not print whole
 * instead of cutting it.
 */

import { z } from "zod";
import {
  ANGLE_ROLES,
  MAX_SELLER_LINE_CHARS,
  MAX_SELLER_LINES,
  MAX_SKU_CHARS,
  SKU_PATTERN,
} from "@curvi/pipeline/seller-inputs";

export const angleRoleSchema = z.enum(ANGLE_ROLES);

const sellerLine = z
  .string()
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, "Remove the empty line.")
      .max(MAX_SELLER_LINE_CHARS, `Keep each line to ${MAX_SELLER_LINE_CHARS} characters so it prints whole.`),
  );

/** Box contents or comparison facts: at most five short lines. */
export const sellerLinesSchema = z
  .array(sellerLine)
  .max(MAX_SELLER_LINES, `Add at most ${MAX_SELLER_LINES} lines.`);

/** A SKU, or an empty string to clear it. */
export const skuSchema = z
  .string()
  .trim()
  .max(MAX_SKU_CHARS, `Keep the SKU to ${MAX_SKU_CHARS} characters.`)
  .refine((s) => s.length === 0 || SKU_PATTERN.test(s), "Use letters, digits, dots, hyphens or underscores in the SKU.");

/** The product the seller tapped in the chooser at upload: a box
 * normalized to 0..1 of the upright photo, inside the photo
 * (source_media.target_box, docs/phases/PHASE_14.md 3.2). */
export const targetBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((box) => box.x + box.width <= 1.0001 && box.y + box.height <= 1.0001, "The chosen product must be inside the photo.");

/** Most photos one pack sends to the worker, and so the most the new pack
 * form takes: this request's uploads first, then the product's newest
 * stored photos. */
export const MAX_PACK_PHOTOS = 6;
