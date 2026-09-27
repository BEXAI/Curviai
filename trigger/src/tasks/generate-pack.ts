/**
 * The pack job: thin Trigger.dev wrapper around runGeneratePack from the
 * pure pipeline runner. Fan out happens through the generate-shot subtask
 * with batchTriggerAndWait; ledger accounting, state transitions and QC all
 * live in the runner so they are unit tested without the platform.
 *
 * The task itself does not retry: a failed pack releases its credit
 * reservation, and blindly retrying the whole job would double account.
 * Per shot retries live in generate-shot and inside the QC loop.
 */

import { task } from "@trigger.dev/sdk/v3";
import type { Shot } from "@curvi/pipeline";
import { resolveRuntimeDeps } from "../db-runtime";
import {
  deserializeShotOutcome,
  runGeneratePack,
  type GeneratePackInput,
  type GeneratePackSummary,
  type ShotContext,
  type ShotOutcome,
} from "../pipeline-runner";
import { DEMO_MODE_NOTICE, optionalEnv } from "../runtime";
import { generateShot } from "./generate-shot";

export const generatePack = task({
  id: "generate-pack",
  maxDuration: 1_800,
  retry: { maxAttempts: 1 },
  run: async (payload: GeneratePackInput): Promise<GeneratePackSummary & { notice?: string }> => {
    const deps = resolveRuntimeDeps();

    const runShots = async (shots: Shot[], ctx: ShotContext): Promise<ShotOutcome[]> => {
      if (shots.length === 0) {
        return [];
      }
      const batch = await generateShot.batchTriggerAndWait(
        shots.map((shot) => ({ payload: { shot, ...ctx } })),
      );
      return batch.runs.map((run, i) => {
        if (!run.ok) {
          throw new Error(`Shot ${shots[i].id} failed after subtask retries: ${String(run.error)}`);
        }
        return deserializeShotOutcome(run.output, ctx);
      });
    };

    const summary = await runGeneratePack(payload, { ...deps, runShots });
    if (!optionalEnv("ANTHROPIC_API_KEY")) {
      return { ...summary, notice: DEMO_MODE_NOTICE };
    }
    return summary;
  },
});
