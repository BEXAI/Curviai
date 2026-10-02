import { healthLimits } from "@curvi/pipeline/seed";

/** Let one pack make progress even when idle RSS stays above the threshold. */
export function memoryAllowsStart(running: number, rss: number, limit: number | null): boolean {
  return running === 0 || limit === null || rss < limit * healthLimits.memoryStartRatio;
}
