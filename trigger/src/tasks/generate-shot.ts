/**
 * Per shot subtask: thin Trigger.dev wrapper around runShot from the pure
 * pipeline runner. generate-pack fans out one of these per planned shot;
 * each run carries its own platform level retries on top of the QC retry
 * loop inside runShot.
 */

import { task } from "@trigger.dev/sdk/v3";
import type { Shot } from "@curvi/pipeline";
import { resolveRuntimeDeps } from "../db-runtime";
import { buildR2Handoff } from "../r2";
import {
  runShot,
  serializeShotOutcome,
  type SerializableShotOutcome,
  type ShotContext,
} from "../pipeline-runner";

/** The shot plus its context. The context carries the job's resolved output
 * options (ShotContext.output), so the subtask renders the pack's colors and
 * kept photos exactly as the in process fan out does (PHASE_15 item 21). */
export interface GenerateShotPayload extends ShotContext {
  shot: Shot;
}

export const generateShot = task({
  id: "generate-shot",
  maxDuration: 600,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 15_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: GenerateShotPayload): Promise<SerializableShotOutcome> => {
    const deps = resolveRuntimeDeps();
    const outcome = await runShot(payload.shot, payload, deps);
    // A file past the inline budget goes through R2 under the workspace's
    // own prefix: Trigger.dev caps a task output at 10MB (PHASE_15 item 15).
    return await serializeShotOutcome(outcome, {
      handoff: buildR2Handoff(),
      workspaceId: payload.workspaceId,
      jobId: payload.jobId,
      ...(payload.runKey ? { runKey: payload.runKey } : {}),
    });
  },
});
