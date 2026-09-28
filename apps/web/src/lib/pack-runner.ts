/**
 * In process pack execution for db mode. createJob fires startPackRun and
 * returns immediately; the pipeline then runs inside this Node server using
 * the same runGeneratePack the Trigger.dev tasks wrap, with live providers
 * when their env keys exist. A Drizzle backed JobStore writes job status,
 * per shot steps, assets and ledger effects to Postgres, so the existing
 * job board polling shows real progress. When a Trigger.dev deployment
 * later takes over, this module is the only thing to swap.
 */

import { assetVariants, assets, generationJobs, jobSteps, products, eq, sql, type Db } from "@curvi/db";
import type { ProductProfile } from "@curvi/pipeline";
import {
  runGeneratePack,
  type GeneratePackInput,
  type JobLedgerEntry,
  type JobState,
  type JobStore,
  type StoredAsset,
  type StoredPack,
} from "@curvi/trigger/pipeline-runner";
import { buildRuntimeDeps } from "@curvi/trigger/runtime";
import { isR2Configured } from "@/lib/env";
import { putGeneratedObject } from "@/lib/r2";
import { getDb } from "@/lib/services/db";

/** One run per job per server instance; restarts leave the job resumable. */
const running = new Set<string>();

export class DrizzleJobStore implements JobStore {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly productId: string,
  ) {}

  async saveProfile(_jobId: string, profile: ProductProfile): Promise<void> {
    await this.db
      .update(products)
      .set({ profile, ...(profile.name ? { title: profile.name } : {}), updatedAt: new Date() })
      .where(eq(products.id, this.productId));
  }

  async setJobState(jobId: string, state: JobState, meta?: Record<string, unknown>): Promise<void> {
    const error = typeof meta?.error === "string" ? meta.error.slice(0, 500) : undefined;
    await this.db
      .update(generationJobs)
      .set({ status: state, ...(error ? { error } : {}), updatedAt: new Date() })
      .where(eq(generationJobs.id, jobId));
  }

  /**
   * Maps the runner's ledger plan onto the SECURITY DEFINER ledger
   * functions. The reserve already happened in createJob with the same
   * budget, so it is skipped here; charges are idempotent per shot through
   * the step key; release returns whatever is still held.
   */
  async appendLedger(entry: JobLedgerEntry): Promise<void> {
    if (entry.reason === "reserve") {
      return;
    }
    if (entry.reason === "charge") {
      await this.db.execute(
        sql`select charge_credits(${entry.workspaceId}::uuid, ${entry.credits}::integer, ${entry.jobId}::uuid, ${entry.ref ?? null})`,
      );
      return;
    }
    await this.db.execute(sql`select release_credits(${entry.workspaceId}::uuid, ${entry.jobId}::uuid)`);
  }

  async saveAsset(asset: StoredAsset): Promise<void> {
    const [inserted] = await this.db
      .insert(assets)
      .values({
        workspaceId: this.workspaceId,
        jobId: asset.jobId,
        shotType: asset.shotType,
        qc: asset.verdict,
        approved: asset.status === "passed",
      })
      .returning();
    if (asset.encoded && isR2Configured()) {
      const format = asset.encoded.format === "jpg" ? "jpg" : "png";
      const key = `ws/${this.workspaceId}/out/${asset.jobId}/${asset.shotId}.${format}`;
      try {
        await putGeneratedObject(key, asset.encoded.buffer, format === "jpg" ? "image/jpeg" : "image/png");
        await this.db.insert(assetVariants).values({
          workspaceId: this.workspaceId,
          assetId: inserted.id,
          channelSpecId: asset.specId,
          r2Key: key,
          filename: `${asset.shotType}.${format}`,
          bytes: asset.encoded.buffer.length,
        });
      } catch {
        // The asset row and QC verdict stand; the variant upload can be retried.
      }
    }
    await this.db.insert(jobSteps).values({
      workspaceId: this.workspaceId,
      jobId: asset.jobId,
      shotId: asset.shotId,
      stage: asset.shotType,
      provider: "pipeline",
      attempt: asset.attempts,
      status: asset.status === "passed" ? "done" : "needs_review",
      costMicros: asset.costMicros,
    });
  }

  async savePack(pack: StoredPack): Promise<void> {
    // Pack files stay on the instance disk for now; durable pack storage in
    // R2 with a download route is tracked in docs/verification.md.
    await this.db.insert(jobSteps).values({
      workspaceId: this.workspaceId,
      jobId: pack.jobId,
      shotId: "pack",
      stage: "packaging",
      provider: "packager",
      status: "done",
      costMicros: 0,
    });
  }
}

export type StartPackArgs = GeneratePackInput & { productId: string };

export function startPackRun(args: StartPackArgs): void {
  if (running.has(args.jobId)) {
    return;
  }
  running.add(args.jobId);
  void (async () => {
    const db = getDb();
    const deps = buildRuntimeDeps();
    const store = new DrizzleJobStore(db, args.workspaceId, args.productId);
    try {
      // Video and avatar shots wait for their providers; skipping them here
      // keeps live packs honest instead of charging for placeholder renders.
      await runGeneratePack(args, { ...deps, store, excludeShotMethods: ["video_generate", "avatar"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await store.setJobState(args.jobId, "failed", { error: message });
        await db.execute(sql`select release_credits(${args.workspaceId}::uuid, ${args.jobId}::uuid)`);
      } catch {
        // The job row keeps its last written state; polling surfaces it.
      }
    } finally {
      running.delete(args.jobId);
    }
  })();
}
