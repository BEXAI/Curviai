/**
 * Pack follow up task: thin Trigger.dev wrapper around runPackFollowUp (a
 * retried shot or an added angle on a delivered pack). Follow ups are one
 * shot or a few, so they run in this task without a fan out.
 *
 * No task level retry, for the same reason as generate-pack: the runner
 * settles the follow up's hold itself, and a blind rerun would account twice.
 */

import { task } from "@trigger.dev/sdk/v3";
import { resolveRuntimeDeps } from "../db-runtime";
import { runPackFollowUp, type PackFollowUpInput, type PackFollowUpSummary } from "../follow-up";

export const packFollowUp = task({
  id: "pack-follow-up",
  maxDuration: 900,
  retry: { maxAttempts: 1 },
  run: async (payload: PackFollowUpInput): Promise<PackFollowUpSummary> => {
    return runPackFollowUp(payload, resolveRuntimeDeps());
  },
});
