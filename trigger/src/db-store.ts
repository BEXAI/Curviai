/**
 * DbJobStore: the JobStore that persists a pack run to Postgres, closing the
 * loop the plan draws in section 4.4. State transitions land on
 * generation_jobs, ledger actions call the SECURITY DEFINER credit functions
 * (charge_credits per passing asset with the shot id as the idempotency step
 * key, release_credits with an exact amount for failed shots and remainders),
 * assets and job_steps rows feed the progress board, and savePack uploads the
 * delivered files to R2 and records asset_variants and pack_files rows, only
 * while the job is still live.
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
  type JobRecipeVariant,
} from "@curvi/db";
import type { JobInventory, PackFileReport } from "@curvi/pipeline";
import type { SellerIntent, Shot } from "@curvi/pipeline/schemas";
import {
  JobAbandonedError,
  type JobLedgerEntry,
  type JobStore,
  type StoredAsset,
  type StoredFollowUpFiles,
  type StoredPack,
  type StoredPlan,
  type UndeliveredShot,
} from "./pipeline-runner";
import type { JobState } from "./state";
import { assetFileKey, followUpFileKey, packFileKey, type PackUploader } from "./r2";

export interface DbJobStoreOptions {
  /** True when the app already reserved credits at job creation, the normal
   * web flow. The store then skips the SQL reserve call. */
  reserveHandledExternally?: boolean;
  /** Uploads delivered files to R2. When null, credit settlement and asset
   * rows still persist but no files are stored or recorded. */
  uploader?: PackUploader | null;
  /** The run this store acts for (generation_jobs.run_key). Set through
   * forRun; see liveJob. */
  runKey?: string | null;
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

  /** This store bound to one run's key: every liveness check, state write
   * and ledger write then requires the job row to carry that key. */
  forRun(runKey: string): DbJobStore {
    return new DbJobStore(this.db, { ...this.opts, runKey });
  }

  /**
   * The where clause of every liveness check: the job exists, is not
   * terminal, and still belongs to this store's run. A follow up moves a job
   * from done back to generating, so status alone cannot tell a stale runner
   * of an earlier run from the live one; the run key can. A null key on the
   * row or on this store is a run queued before migration 0019 and falls
   * back to the status check alone, so those jobs still finish.
   */
  private liveJob(jobId: string) {
    return and(eq(generationJobs.id, jobId), notInArray(generationJobs.status, TERMINAL_JOB_STATES), this.ownsRun());
  }

  /** True when the job row belongs to this store's run (see liveJob). */
  private ownsRun() {
    const runKey = this.opts.runKey ?? null;
    return runKey === null
      ? sql`true`
      : sql`(${generationJobs.runKey} is null or ${generationJobs.runKey} = ${runKey})`;
  }

  /**
   * Runs a ledger write only while the job still belongs to this store's
   * run, under the workspace row lock the ledger functions, the web app's
   * cancel and settle and startFollowUp all take first. A cancel followed by
   * a new follow up changes the key, so a stale runner can neither charge a
   * shot against the new follow up's hold nor release any of it. Returns
   * false, with nothing written, when the run no longer owns the job.
   */
  private async inOwnedRun(jobId: string, workspaceId: string, write: (tx: Db) => Promise<unknown>): Promise<boolean> {
    if ((this.opts.runKey ?? null) === null) {
      await write(this.db);
      return true;
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
      const owned = await tx
        .select({ id: generationJobs.id })
        .from(generationJobs)
        .where(and(eq(generationJobs.id, jobId), this.ownsRun()));
      if (owned.length === 0) {
        return false;
      }
      await write(tx as unknown as Db);
      return true;
    });
  }

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
      .where(this.liveJob(jobId))
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
   * is terminal or belongs to another run. */
  async heartbeat(jobId: string): Promise<boolean> {
    const rows = await this.db
      .update(generationJobs)
      .set({ updatedAt: new Date() })
      .where(this.liveJob(jobId))
      .returning({ id: generationJobs.id });
    return rows.length > 0;
  }

  /** Records the recipe version each stage of the job runs on (A/B). */
  async saveRecipeVariants(jobId: string, variants: Record<string, JobRecipeVariant>): Promise<void> {
    await this.db.update(generationJobs).set({ recipeVariants: variants }).where(eq(generationJobs.id, jobId));
  }

  /** Records the seller intent intake parsed from the note, only while the
   * job is live and still this store's run (liveJob), so a stale runner of
   * an earlier run never overwrites the live run's intent. */
  async saveSellerIntent(jobId: string, intent: SellerIntent): Promise<void> {
    await this.db
      .update(generationJobs)
      .set({ sellerIntent: intent, updatedAt: new Date() })
      .where(this.liveJob(jobId));
  }

  /** Records what the product inventory found in each photo, with the same
   * liveness rule as saveSellerIntent (liveJob). */
  async saveInventory(jobId: string, inventory: JobInventory): Promise<void> {
    await this.db
      .update(generationJobs)
      .set({ inventory, updatedAt: new Date() })
      .where(this.liveJob(jobId));
  }

  /** Returns everything the ledger still holds for the job. Idempotent:
   * release_credits without an amount releases zero when nothing is held.
   * A run that no longer owns the job releases nothing: whatever is held
   * then belongs to the run that does, and the cancel or settle that ended
   * this one already returned its hold. */
  async releaseAllHeld(jobId: string, workspaceId: string): Promise<void> {
    await this.inOwnedRun(jobId, workspaceId, (tx) =>
      tx.execute(sql`select release_credits(${workspaceId}::uuid, ${jobId}::uuid)`),
    );
  }

  /** Throws JobAbandonedError, with nothing written, once the job belongs to
   * another run (see inOwnedRun). */
  async appendLedger(entry: JobLedgerEntry): Promise<void> {
    if (entry.reason === "reserve" && this.opts.reserveHandledExternally) {
      return;
    }
    const call =
      entry.reason === "reserve"
        ? sql`select reserve_credits(${entry.workspaceId}::uuid, ${entry.credits}::numeric, ${entry.jobId}::uuid)`
        : entry.reason === "charge"
          ? sql`select charge_credits(${entry.workspaceId}::uuid, ${entry.credits}::numeric, ${entry.jobId}::uuid, ${entry.ref ?? null}::text)`
          : sql`select release_credits(${entry.workspaceId}::uuid, ${entry.jobId}::uuid, ${entry.credits}::numeric)`;
    if (!(await this.inOwnedRun(entry.jobId, entry.workspaceId, (tx) => tx.execute(call)))) {
      throw new JobAbandonedError(entry.jobId);
    }
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
        // The planned shot, so the seller can run a shot that needs review
        // again exactly as planned (pack follow ups).
        ...(asset.shot ? { shot: asset.shot } : {}),
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

  /**
   * Uploads the delivered files, then records them, but only while the job
   * is live. The pack is delivered the moment its compliance report row
   * exists: the web app's settle (settleInterruptedJob, run by the inline
   * run cap, a shutdown or a crash) marks a job with that row done and
   * charges it, and fails any other job and releases its hold. So the
   * asset_variants, zip and report rows are written in one transaction that
   * first locks the workspace row, the same lock the settle and
   * charge_credits take first, and then checks the job is not terminal and
   * still belongs to this store's run (liveJob).
   * Either this transaction goes first and the settle sees a delivered pack,
   * or the settle goes first and nothing is recorded: a settled job never
   * gains files that nobody pays for. A job already terminal throws
   * JobAbandonedError before any upload; one settled during the uploads
   * throws it with nothing recorded (its uploaded objects stay unlisted).
   */
  async savePack(pack: StoredPack): Promise<void> {
    const uploader = this.opts.uploader ?? null;
    if (!uploader) {
      // Without storage the customer can never download the pack, so this
      // must fail the run: the runner then releases the held credits instead
      // of charging for files that were never delivered.
      throw new Error("Pack storage is not configured, so the pack could not be delivered.");
    }
    if (!(await this.heartbeat(pack.jobId))) {
      throw new JobAbandonedError(pack.jobId);
    }

    const report = JSON.parse(await readFile(pack.reportPath, "utf8")) as ComplianceReport;
    const assetIdByShot = await this.assetIdsByShot(pack.jobId);
    await this.ensureChannelSpecs();

    const variants: Array<typeof assetVariants.$inferInsert> = [];
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
      variants.push({
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

    const packRows: Array<typeof packFiles.$inferInsert> = [];
    for (const channel of pack.channels) {
      const zipPath = path.join(pack.outDir, `${channel}.zip`);
      if (!(await exists(zipPath))) {
        continue;
      }
      const key = packFileKey(pack.workspaceId, pack.jobId, `${channel}.zip`);
      const { bytes } = await uploader.upload(zipPath, key);
      packRows.push({
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
    // The report row goes last: it is what marks the pack delivered.
    packRows.push({
      workspaceId: pack.workspaceId,
      jobId: pack.jobId,
      kind: "report",
      channel: null,
      filename: "compliance-report.json",
      r2Key: reportKey,
      bytes,
    });

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from workspaces where id = ${pack.workspaceId}::uuid for update`);
      const live = await tx.select({ id: generationJobs.id }).from(generationJobs).where(this.liveJob(pack.jobId));
      if (live.length === 0) {
        throw new JobAbandonedError(pack.jobId);
      }
      if (variants.length > 0) {
        await tx.insert(assetVariants).values(variants);
      }
      await tx.insert(packFiles).values(packRows);
    });
  }

  /**
   * Delivers the files of a pack follow up into a pack its first run already
   * delivered. Each file goes to its own key under the follow up's run key,
   * so nothing already delivered is ever overwritten. The asset_variants rows
   * are written in one transaction that locks the workspace row and checks
   * the job is live and still this follow up's (liveJob), the same order savePack and the web app's cancel and
   * settle take: a job canceled or settled first records nothing, and one
   * recorded first is charged by whoever settles it. The channel zips of the
   * first run no longer hold every file of those channels, so their rows go;
   * the all files zip and the single file downloads read asset_variants and
   * stay complete. Returns the shot ids whose files were recorded.
   */
  async saveFollowUpFiles(batch: StoredFollowUpFiles): Promise<string[]> {
    const uploader = this.opts.uploader ?? null;
    if (!uploader) {
      throw new Error("Pack storage is not configured, so the files could not be delivered.");
    }
    if (!(await this.heartbeat(batch.jobId))) {
      throw new JobAbandonedError(batch.jobId);
    }
    const assetIdByShot = await this.latestPassedAssetIds(batch.jobId);
    await this.ensureChannelSpecs();

    const variants: Array<typeof assetVariants.$inferInsert> = [];
    for (const file of batch.files) {
      const assetId = assetIdByShot.get(file.ref);
      const localPath = path.join(batch.outDir, "files", file.channel, file.file);
      if (!assetId || !(await exists(localPath))) {
        continue;
      }
      const key = followUpFileKey(batch.workspaceId, batch.jobId, batch.runKey, file.channel, file.file);
      const { bytes } = await uploader.upload(localPath, key);
      variants.push({
        workspaceId: batch.workspaceId,
        assetId,
        channelSpecId: file.specId,
        r2Key: key,
        filename: file.file,
        bytes,
        width: file.width,
        height: file.height,
      });
    }
    if (variants.length === 0) {
      return [];
    }
    const channels = [...new Set(batch.files.filter((f) => assetIdByShot.has(f.ref)).map((f) => f.channel))];

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from workspaces where id = ${batch.workspaceId}::uuid for update`);
      const live = await tx.select({ id: generationJobs.id }).from(generationJobs).where(this.liveJob(batch.jobId));
      if (live.length === 0) {
        throw new JobAbandonedError(batch.jobId);
      }
      await tx.insert(assetVariants).values(variants);
      await tx
        .delete(packFiles)
        .where(
          and(
            eq(packFiles.jobId, batch.jobId),
            eq(packFiles.kind, "zip"),
            sql`${packFiles.channel} = any(${`{${channels.join(",")}}`}::text[])`,
          ),
        );
    });
    const recorded = new Set(variants.map((v) => v.assetId));
    return [...assetIdByShot].filter(([, assetId]) => recorded.has(assetId)).map(([shotId]) => shotId);
  }

  /** The newest approved asset row of each shot. A shot run again keeps its
   * earlier needs review row, so the passing run's row is the one its files
   * belong to. */
  private async latestPassedAssetIds(jobId: string): Promise<Map<string, string>> {
    const rows = await this.db.query.assets.findMany({
      where: (t, { and, eq }) => and(eq(t.jobId, jobId), eq(t.approved, true)),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      const shotId = row.qc && typeof row.qc.shotId === "string" ? row.qc.shotId : null;
      if (shotId) {
        map.set(shotId, row.id);
      }
    }
    return map;
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
