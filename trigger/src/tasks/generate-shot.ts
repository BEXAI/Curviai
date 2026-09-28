/**
 * Per shot subtask: thin Trigger.dev wrapper around runShot from the pure
 * pipeline runner. generate-pack fans out one of these per planned shot;
 * each run carries its own platform level retries on top of the QC retry
 * loop inside runShot.
 */

import { task } from "@trigger.dev/sdk/v3";
import type { Shot } from "@curvi/pipeline";
import { resolveRuntimeDeps } from "../db-runtime";
import {
  runShot,
  serializeShotOutcome,
  type SerializableShotOutcome,
  type ShotContext,
} from "../pipeline-runner";

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
    return await serializeShotOutcome(outcome);
  },
});
