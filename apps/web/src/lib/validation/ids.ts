/**
 * Id validation for route params and request bodies (Update.md 4.7). Every id
 * column is a Postgres uuid, and a non uuid value makes Postgres raise 22P02,
 * which surfaced as a 500. Routes check ids here first and answer 400 or 404.
 *
 * The pattern accepts any canonical 8-4-4-4-12 hex uuid, which is exactly the
 * text form Postgres returns, rather than only RFC version 4 ids, so rows made
 * by any uuid generator keep working.
 */

import { z } from "zod";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export const uuidSchema = z.string().regex(UUID_PATTERN, { message: "Must be a valid id." });

/** An existing product id, or "new" to create the product with the pack. */
export const productIdSchema = z.union([z.literal("new"), uuidSchema]);
