/**
 * DbJobStore: the JobStore that persists a pack run to Postgres, closing the
 * loop the plan draws in section 4.4. State transitions land on
 * generation_jobs, ledger actions call the SECURITY DEFINER credit functions
 * (charge_credits per passing asset with the shot id as the idempotency step
 * key, release_credits with an exact amount for failed shots and remainders),
 * assets and job_steps rows feed the progress board, and savePack uploads the
 * delivered files to R2 and records asset_variants and pack_files rows.
 *
 * The web app reserves credits when it creates the job, so the store's
 * reserve action is an accounting no op here; JobLedgerPlan still tracks it
 * so the runner's invariants hold.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  assetVariants,
  assets,
  generationJobs,
  jobSteps,
  loadChannelSpecs,
  packFiles,
  sql,
  and,
  eq,
  notInArray,
  type Db,
} from "@curvi/db";
import type { PackFileReport } from "@curvi/pipeline";
import type { Shot } from "@curvi/pipeline/schemas";
import type {
  JobLedgerEntry,
  JobStore,
  StoredAsset,
  StoredPack,
  StoredPlan,
  UndeliveredShot,
} from "./pipeline-runner";
import type { JobState } from "./state";
import { assetFileKey, packFileKey, type PackUploader } from "./r2";

export interface DbJobStoreOptions {
  /** True when the app already reserved credits at job creation, the normal
   * web flow. The store then skips the SQL reserve call. */
  reserveHandledExternally?: boolean;
  /** Uploads delivered files to R2. When null, credit settlement and asset
   * rows still persist but no files are stored or recorded. */
  uploader?: PackUploader | null;
}

const TERMINAL_JOB_STATES: JobState[] = ["done", "failed", "canceled"];

interface ComplianceReport {
  files: PackFileReport[];
}

export class DbJobStore implements JobStore {
  private specsSeeded: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: DbJobStoreOptions = {},
  ) {}

  /**
   * Moves the job to a new state unless it is already terminal. A terminal
   * row means the stale run reconciler (or an earlier failure) settled the
   * job; returning false tells the runner to stop instead of reviving it and
   * charging against a reservation that was already released.
   */
  async setJobState(jobId: string, state: JobState, meta?: Record<string, unknown>): Promise<boolean> {
    const error =
      state === "failed" && meta && typeof meta.error === "string" ? meta.error : undefined;
    const cogsMicros = cogsFrom(meta);
    // COGS only ever grows: the runner reports its running total of metered
    // provider spend, and a later, smaller report must not erase earlier spend.
    const cogs =
      cogsMicros !== undefined
        ? { cogsMicros: sql`greatest(${generationJobs.cogsMicros}, ${cogsMicros}::bigint)` }
        : {};
    const rows = await this.db
      .update(generationJobs)
      .set({ status: state, updatedAt: new Date(), ...(error !== undefined ? { error } : {}), ...cogs })
      .where(and(eq(generationJobs.id, jobId), notInArray(generationJobs.status, TERMINAL_JOB_STATES)))
      .returning({ id: generationJobs.id });
    if (rows.length === 0 && cogsMicros !== undefined) {
      // The job was already settled (for example by the stale run reconciler),
      // but the provider spend is real, so it still lands on the job's COGS.
      await this.db.update(generationJobs).set(cogs).where(eq(generationJobs.id, jobId));
    }
    return rows.length > 0;
  }

  /** Bumps updated_at on a live job so a long generation phase never looks
   * stale to the reconciler. Returns false, and touches nothing, once the job
   * is terminal. */
  async heartbeat(jobId: string): Promise<boolean> {
    const rows = await this.db
      .update(generationJobs)
      .set({ updatedAt: new Date() })
      .where(and(eq(generationJobs.id, jobId), notInArray(generationJobs.status, TERMINAL_JOB_STATES)))
      .returning({ id: generationJobs.id });
    return rows.length > 0;
  }

  /** Returns everything the ledger still holds for the job. Idempotent:
   * release_credits without an amount releases zero when nothing is held. */
  async releaseAllHeld(jobId: string, workspaceId: string): Promise<void> {
    await this.db.execute(sql`select release_credits(${workspaceId}::uuid, ${jobId}::uuid)`);
  }

  async appendLedger(entry: JobLedgerEntry): Promise<void> {
    if (entry.reason === "reserve") {
      if (this.opts.reserveHandledExternally) {
        return;
      }
      await this.db.execute(
        sql`select reserve_credits(${entry.workspaceId}::uuid, ${entry.credits}::numeric, ${entry.jobId}::uuid)`,
      );
      return;
    }
    if (entry.reason === "charge") {
      await this.db.execute(
        sql`select charge_credits(${entry.workspaceId}::uuid, ${entry.credits}::numeric, ${entry.jobId}::uuid, ${entry.ref ?? null}::text)`,
      );
      return;
    }
    await this.db.execute(
      sql`select release_credits(${entry.workspaceId}::uuid, ${entry.jobId}::uuid, ${entry.credits}::numeric)`,
    );
  }

  /**
   * Writes one pending job_steps row per planned shot and one skipped row per
   * shot the planner left out, with its reason in error, so the progress
   * board lists the whole pack from the plan onward. saveAsset later appends
   * the shot's final row, which the board prefers over the pending one.
   * Display only, so a failure is logged and never fails the run.
   */
  async savePlan(plan: StoredPlan): Promise<void> {
    const rows: Array<typeof jobSteps.$inferInsert> = [
      ...plan.shots.map((shot) => ({
        workspaceId: plan.workspaceId,
        jobId: plan.jobId,
        shotId: shot.id,
        stage: shot.type,
        provider: stageLabelFor(shot.method),
        status: "pending",
      })),
      ...plan.skipped.map((skip, index) => ({
        workspaceId: plan.workspaceId,
        jobId: plan.jobId,
        shotId: `skipped_${String(index + 1).padStart(2, "0")}_${skip.type}`,
        stage: skip.type,
        provider: "planner",
        status: "skipped",
        error: skip.reason.slice(0, 300),
      })),
    ];
    if (rows.length === 0) {
      return;
    }
    try {
      await this.db.insert(jobSteps).values(rows);
      await this.heartbeat(plan.jobId);
    } catch (err) {
      console.warn(`[db-store] could not record the plan for job ${plan.jobId}`, err);
    }
  }

  async saveAsset(asset: StoredAsset): Promise<void> {
    await this.db.insert(assets).values({
      workspaceId: asset.workspaceId,
      jobId: asset.jobId,
      shotType: asset.shotType,
      approved: asset.status === "passed",
      qc: {
        ...asset.verdict,
        shotId: asset.shotId,
        specId: asset.specId,
        status: asset.status,
        attempts: asset.attempts,
        credits: asset.credits,
        costMicros: asset.costMicros,
        // The progress board's green badge reads these measured values.
        fillPct: asset.measured.fillPct,
        background: asset.measured.background,
      },
    });
    await this.db.insert(jobSteps).values({
      workspaceId: asset.workspaceId,
      jobId: asset.jobId,
      shotId: asset.shotId,
      stage: asset.shotType,
      provider: "worker",
      attempt: asset.attempts,
      // A shot that did not pass is released at no charge and shown as an
      // amber Needs review card, never as a red Failed one (Update.md 3.5).
      status: asset.status === "passed" ? "done" : "needs_review",
      costMicros: Math.round(asset.costMicros),
    });
    await this.heartbeat(asset.jobId);
  }

  /**
   * A shot that passed QC but that the packager left out (a channel image
   * limit): its asset row stops claiming delivery (approved false, qc status
   * needs_review with the plain reason, no credits) and a needs_review step
   * row is appended, which the board shows over the earlier done row. The
   * runner already released its credits; nothing here touches the ledger.
   */
  async markShotUndelivered(update: UndeliveredShot): Promise<void> {
    const reason = update.reason.slice(0, 300);
    const patch = JSON.stringify({ status: "needs_review", pass: false, repairHint: reason, delivered: false });
    await this.db
      .update(assets)
      .set({ approved: false, qc: sql`coalesce(${assets.qc}, '{}'::jsonb) || ${patch}::jsonb` })
      .where(and(eq(assets.jobId, update.jobId), sql`${assets.qc}->>'shotId' = ${update.shotId}`));
    await this.db.insert(jobSteps).values({
      workspaceId: update.workspaceId,
      jobId: update.jobId,
      shotId: update.shotId,
      stage: update.shotType,
      provider: "worker",
      status: "needs_review",
      error: reason,
    });
    await this.heartbeat(update.jobId);
  }

  async savePack(pack: StoredPack): Promise<void> {
    const uploader = this.opts.uploader ?? null;
    if (!uploader) {
      // Without storage the customer can never download the pack, so this
      // must fail the run: the runner then releases the held credits instead
      // of charging for files that were never delivered.
      throw new Error("Pack storage is not configured, so the pack could not be delivered.");
    }

    const report = JSON.parse(await readFile(pack.reportPath, "utf8")) as ComplianceReport;
    const assetIdByShot = await this.assetIdsByShot(pack.jobId);
    await this.ensureChannelSpecs();

    for (const file of report.files) {
      const localPath = path.join(pack.outDir, "files", file.channel, file.file);
      if (!(await exists(localPath))) {
        continue;
      }
      const key = assetFileKey(pack.workspaceId, pack.jobId, file.channel, file.file);
      const { bytes } = await uploader.upload(localPath, key);
      const assetId = file.ref ? assetIdByShot.get(file.ref) : undefined;
      if (!assetId) {
        continue;
      }
      await this.db.insert(assetVariants).values({
        workspaceId: pack.workspaceId,
        assetId,
        channelSpecId: file.specId,
        r2Key: key,
        filename: file.file,
        bytes,
        width: file.measured?.width ?? null,
        height: file.measured?.height ?? null,
      });
    }

    for (const channel of pack.channels) {
      const zipPath = path.join(pack.outDir, `${channel}.zip`);
      if (!(await exists(zipPath))) {
        continue;
      }
      const key = packFileKey(pack.workspaceId, pack.jobId, `${channel}.zip`);
      const { bytes } = await uploader.upload(zipPath, key);
      await this.db.insert(packFiles).values({
        workspaceId: pack.workspaceId,
        jobId: pack.jobId,
        kind: "zip",
        channel,
        filename: `${channel}.zip`,
        r2Key: key,
        bytes,
      });
    }

    const reportKey = packFileKey(pack.workspaceId, pack.jobId, "compliance-report.json");
    const { bytes } = await uploader.upload(pack.reportPath, reportKey);
    await this.db.insert(packFiles).values({
      workspaceId: pack.workspaceId,
      jobId: pack.jobId,
      kind: "report",
      channel: null,
      filename: "compliance-report.json",
      r2Key: reportKey,
      bytes,
    });
  }

  /** Asset rows may have been written by fan out subtasks on their own
   * connections, so the shot to asset mapping is resolved from the database,
   * never from in process state. */
  private async assetIdsByShot(jobId: string): Promise<Map<string, string>> {
    const rows = await this.db.select().from(assets).where(eq(assets.jobId, jobId));
    const map = new Map<string, string>();
    for (const row of rows) {
      const shotId = row.qc && typeof row.qc.shotId === "string" ? row.qc.shotId : null;
      if (shotId) {
        map.set(shotId, row.id);
      }
    }
    return map;
  }

  /** asset_variants.channel_spec_id references channel_specs, so make sure the
   * registry is seeded before inserting variants. Idempotent upsert. */
  private ensureChannelSpecs(): Promise<void> {
    this.specsSeeded ??= loadChannelSpecs(this.db).then(() => undefined);
    return this.specsSeeded;
  }
}

/** The runner's metered provider spend for the job (plan 4.4.3 cogsMicros),
 * passed as meta.costMicros on the done and failed transitions. */
function cogsFrom(meta?: Record<string, unknown>): number | undefined {
  const value = meta?.costMicros;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
}

/** Neutral stage label for a planned shot; provider names never reach the
 * board. */
function stageLabelFor(method: Shot["method"]): string {
  switch (method) {
    case "deterministic":
      return "pixel pipeline";
    case "composite_generate":
    case "edit_generate":
      return "image model";
    case "template":
      return "template engine";
    case "video_generate":
      return "video model";
    case "avatar":
      return "avatar model";
    default:
      return "worker";
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
