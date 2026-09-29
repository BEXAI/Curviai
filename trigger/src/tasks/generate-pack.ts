/**
 * The pack job: thin Trigger.dev wrapper around runGeneratePack from the
 * pure pipeline runner. Fan out happens through the generate-shot subtask
 * with batchTriggerAndWait; ledger accounting, state transitions and QC all
 * live in the runner so they are unit tested without the platform.
 *
 * The task itself does not retry: a failed pack releases its credit
 * reservation, and blindly retrying the whole job would double account.
 * Per shot retries live in generate-shot and inside the QC loop, and a shot
 * that still fails becomes needs review instead of failing the pack.
 */

import { task } from "@trigger.dev/sdk/v3";
import type { Shot } from "@curvi/pipeline";
import { resolveRuntimeDeps } from "../db-runtime";
import {
  deserializeShotOutcome,
  recordShotFailure,
  runGeneratePack,
  type GeneratePackInput,
  type GeneratePackSummary,
  type ShotContext,
  type ShotOutcome,
} from "../pipeline-runner";
import { buildR2Handoff } from "../r2";
import { DEMO_MODE_NOTICE, optionalEnv } from "../runtime";
import { generateShot } from "./generate-shot";

export const generatePack = task({
  id: "generate-pack",
  maxDuration: 1_800,
  retry: { maxAttempts: 1 },
  run: async (payload: GeneratePackInput): Promise<GeneratePackSummary & { notice?: string }> => {
    const deps = resolveRuntimeDeps();
    const handoff = buildR2Handoff();

    const runShots = async (shots: Shot[], ctx: ShotContext): Promise<ShotOutcome[]> => {
      if (shots.length === 0) {
        return [];
      }
      const batch = await generateShot.batchTriggerAndWait(
        shots.map((shot) => ({ payload: { shot, ...ctx } })),
      );
      // A shot whose subtask failed after its retries goes to needs review
      // with its credits released; its siblings still ship (Update.md 3.3).
      return Promise.all(
        batch.runs.map((run, i) =>
          run.ok
            ? deserializeShotOutcome(run.output, ctx, { handoff })
            : recordShotFailure(deps.store, shots[i], ctx, run.error),
        ),
      );
    };

    const summary = await runGeneratePack(payload, { ...deps, runShots });
    if (!optionalEnv("ANTHROPIC_API_KEY")) {
      return { ...summary, notice: DEMO_MODE_NOTICE };
    }
    return summary;
  },
});
