/**
 * Remember choices per product (docs/phases/PHASE_15.md P1, founder decision
 * 7): each pack that carried output options saves the seller's choice on
 * products.output_defaults, and the new pack form prefills it the next time
 * the product is picked. It is a client prefill only: createJob never reads
 * it, so a request without options is always Marketplace ready and no
 * automatic flow inherits Keep.
 *
 * The choice is saved as normalized, never the resolved hex: a brand color
 * stays "brand color 1", so a later kit edit changes what it means, exactly
 * like picking it again. Kept apart from createJob so its edits stay small.
 */

import { and, eq, products, type Db } from "@curvi/db";
import { normalizeOutputOptions } from "@curvi/pipeline/output-options";
import type { CreateJobInput } from "./types";

/** The products.output_defaults value a pack request saves, or undefined
 * when it saves nothing: no options, a concept pack, or options the
 * schema refuses (createJob has already answered those). */
export function outputDefaultsFor(
  input: Pick<CreateJobInput, "mode" | "outputOptions">,
): Record<string, unknown> | undefined {
  if (input.mode === "concept" || !input.outputOptions) {
    return undefined;
  }
  try {
    return { ...normalizeOutputOptions(input.outputOptions) };
  } catch {
    return undefined;
  }
}

/** The stored record as the form receives it: a plain object, else null.
 * The form parses it (rememberedFormState) and fails closed. */
export function readOutputDefaults(stored: unknown): Record<string, unknown> | null {
  return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : null;
}

/**
 * Saves the request's choice on the product, inside createJob's
 * transaction, so a refused pack remembers nothing. Scoped to the
 * workspace like every product write.
 */
export async function saveOutputDefaults(
  db: Pick<Db, "update">,
  workspaceId: string,
  productId: string,
  input: Pick<CreateJobInput, "mode" | "outputOptions">,
): Promise<void> {
  const defaults = outputDefaultsFor(input);
  if (!defaults) {
    return;
  }
  await db
    .update(products)
    .set({ outputDefaults: defaults })
    .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)));
}
