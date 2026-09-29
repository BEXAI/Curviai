/**
 * View types for the brand kit from a logo (PHASE_16 workstream 7). Free of
 * server imports, so the service contract and the client form share them.
 */

import type { BrandKitSuggestion } from "@curvi/pipeline/brand";

export type { BrandKitSuggestion, ContrastPair, SuggestedColor } from "@curvi/pipeline/brand";

export type BrandPaletteRefusal =
  | "forbidden"
  | "foreign_key"
  | "invalid_upload"
  | "upgrade_required"
  | "no_colors"
  | "unavailable"
  | "rate_limited";

export type BrandPaletteOutcome =
  | { ok: true; suggestion: BrandKitSuggestion }
  | { ok: false; reason: BrandPaletteRefusal; notice: string };
