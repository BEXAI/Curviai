/**
 * Shot fan out width. Kept free of heavy imports so the health endpoint can
 * report the value the runner would use without loading the pipeline.
 */

/** Shots run at once by the default fan out. Two keeps a pack's peak memory
 * to about two shots' worth of raw images while still overlapping provider
 * waits; raise it with CURVI_SHOT_CONCURRENCY on larger instances. */
export const DEFAULT_SHOT_CONCURRENCY = 2;

/** Bounds CURVI_SHOT_CONCURRENCY is clamped to. */
export const SHOT_CONCURRENCY_RANGE = { min: 1, max: 8 } as const;

/** CURVI_SHOT_CONCURRENCY clamped to 1 to 8 when it is a whole number;
 * undefined when unset or not a whole number (the runner default applies). */
export function parseShotConcurrency(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  return Math.min(SHOT_CONCURRENCY_RANGE.max, Math.max(SHOT_CONCURRENCY_RANGE.min, Number(value)));
}
