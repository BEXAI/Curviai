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

/**
 * Shot types whose channel outputs run one at a time per process (PHASE_15
 * memory section): a kept photo output at the 16 megapixel cap holds its
 * rendered RGBA, its reference and its shipped decode at once, so two in
 * flight could run a 512 MB worker out of memory. Other shots keep the
 * fan out width above.
 */
export const SERIAL_SHOT_TYPES: ReadonlySet<string> = new Set(["original_photo"]);

let serialTail: Promise<unknown> = Promise.resolve();

/**
 * Runs fn in the shot concurrency class of its type: through one process
 * wide queue for SERIAL_SHOT_TYPES, directly for every other type. A failed
 * run never blocks the next one.
 */
export function withShotClassSlot<T>(shotType: string, fn: () => Promise<T>): Promise<T> {
  if (!SERIAL_SHOT_TYPES.has(shotType)) {
    return fn();
  }
  const run = serialTail.then(fn, fn);
  serialTail = run.catch(() => undefined);
  return run;
}
