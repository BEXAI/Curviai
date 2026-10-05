import { NormalizedBox } from "@curvi/pipeline/schemas";
import { z } from "zod";

const box = NormalizedBox.strict();

/** Server-resolved selection, stored beside the shot rather than inside its
 * schema (which intentionally strips unknown planner fields). */
export const SourceSelection = z.strictObject({
  version: z.literal(1),
  sourceMediaId: z.string().min(1),
  /** How the server resolved this choice. Geometric inventory alone does
   * not establish that one connected piece is one semantic product. */
  basis: z.enum(["first_run", "single_product_intake", "single_product_inventory", "added_cutout_inventory", "added_original_photo"]).optional(),
  target: z.strictObject({
    label: z.string(),
    box: box.nullable(),
    others: z.array(z.strictObject({ label: z.string(), box })),
    keep: z.array(box).min(1).optional(),
    touching: z.boolean().optional(),
    recut: z.boolean().optional(),
  }).nullable(),
  exclude: z.array(z.string()),
  otherItems: z.boolean(),
});
export type SourceSelection = z.infer<typeof SourceSelection>;

export const SOURCE_SELECTION_UNAVAILABLE =
  "The original product selection is unavailable. Start a new pack and choose the product again.";

export class SourceSelectionUnavailableError extends Error {
  constructor() { super(SOURCE_SELECTION_UNAVAILABLE); }
}

export function readSourceSelection(value: unknown, sourceMediaId: string): SourceSelection {
  const parsed = SourceSelection.safeParse(value);
  if (!parsed.success || parsed.data.sourceMediaId !== sourceMediaId) {
    throw new SourceSelectionUnavailableError();
  }
  return parsed.data;
}
