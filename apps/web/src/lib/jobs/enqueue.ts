/**
 * The bridge from POST /api/jobs to the worker (audit P0 finding 1). With
 * TRIGGER_SECRET_KEY set, the job goes to the Trigger.dev generate-pack task.
 * Without it, the pack runs inline in this process after the response
 * flushes, using the same runner and the same database backed store, so local
 * and small scale db deployments work end to end without a worker account.
 */

import { after } from "next/server";
import type { GeneratePackInput } from "@curvi/trigger/runner";
import { optionalEnv } from "@/lib/env";

export type EnqueueMode = "trigger" | "inline";

export async function enqueueGeneratePack(payload: GeneratePackInput): Promise<EnqueueMode> {
  if (optionalEnv("TRIGGER_SECRET_KEY")) {
    const { tasks } = await import("@trigger.dev/sdk/v3");
    await tasks.trigger("generate-pack", payload, {
      idempotencyKey: `generate-pack:${payload.jobId}`,
    });
    return "trigger";
  }

  after(async () => {
    try {
      const [{ resolveRuntimeDeps }, { runGeneratePack }] = await Promise.all([
        import("@curvi/trigger/db-runtime"),
        import("@curvi/trigger/runner"),
      ]);
      // runGeneratePack owns failure handling: it marks the job failed and
      // releases the remaining hold through the store.
      await runGeneratePack(payload, resolveRuntimeDeps());
    } catch (err) {
      console.error(`[jobs] inline pack run crashed for job ${payload.jobId}`, err);
      await failJobAndRelease(payload).catch((cleanupErr) => {
        console.error(`[jobs] could not fail job ${payload.jobId} after crash`, cleanupErr);
      });
    }
  });
  return "inline";
}

/** Last resort cleanup when the inline run crashed before the runner's own
 * failure path could act: mark the job failed and return the held credits. */
async function failJobAndRelease(payload: GeneratePackInput): Promise<void> {
  const { getDb } = await import("@/lib/services/db");
  const { generationJobs, sql, eq } = await import("@curvi/db");
  const db = getDb();
  await db
    .update(generationJobs)
    .set({ status: "failed", error: "The pack run crashed before it could start.", updatedAt: new Date() })
    .where(eq(generationJobs.id, payload.jobId));
  await db.execute(
    sql`select release_credits(${payload.workspaceId}::uuid, ${payload.jobId}::uuid)`,
  );
}
