/**
 * DbService: Drizzle over DATABASE_URL for rows and for the SECURITY DEFINER
 * credit ledger functions (reserve_credits, credit_balance), which migration
 * 0002 revoked from anon and authenticated sessions; the owner connection may
 * call them. The Supabase auth context supplies identity only. Activates only
 * when DATABASE_URL and Supabase env exist; nothing here runs in demo mode.
 *
 * Workspace scoping is enforced in this layer: every query filters by the
 * workspace resolved from the signed in member, since the owner connection
 * bypasses RLS by design (the plan's service role pattern).
 */

import {
  createDb,
  type Db,
  brandKits,
  generationJobs,
  products,
  sourceMedia,
  workspaces,
  sql,
  eq,
  and,
  lt,
  notInArray,
} from "@curvi/db";
import { presets, tierByKey, tiers, type TierKey } from "@curvi/pipeline/seed";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isR2Configured, optionalEnv } from "@/lib/env";
import { enqueueGeneratePack } from "@/lib/jobs/enqueue";
import { buildGeneratePackInput } from "@/lib/jobs/payload";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { isWorkspaceObjectKey } from "@/lib/object-keys";
import { isWorkspaceSourceKey, presignDownload, presignObjectGet } from "@/lib/r2";
import { brandKitInputSchema, brandKitIssueNotice } from "@/lib/validation/brand-kit";
import type {
  BrandKitView,
  CreateJobInput,
  CreateJobResult,
  CreateProductInput,
  IntegrationView,
  JobFilesView,
  JobFileView,
  JobShotView,
  JobStatus,
  JobSummary,
  JobView,
  MemberView,
  ProductSummary,
  RegisterSourceMediaInput,
  SaveResult,
  Services,
  ShotStatus,
  WorkspaceRole,
  WorkspaceSummary,
} from "./types";

const globalScope = globalThis as typeof globalThis & { __curviDb?: Db };

export function getDb(): Db {
  if (!globalScope.__curviDb) {
    const url = optionalEnv("DATABASE_URL");
    if (!url) {
      throw new Error("DbService needs DATABASE_URL");
    }
    // prepare false so the Supabase transaction mode pooler is safe.
    globalScope.__curviDb = createDb(url, { max: 2, prepare: false });
  }
  return globalScope.__curviDb;
}

export interface DbServiceDeps {
  db: Db;
  /** Resolves the signed in Supabase user id, or null. */
  getUserId: () => Promise<string | null>;
  /** The signed in user's email, used to name a freshly provisioned workspace. */
  getUserEmail?: () => Promise<string | null>;
  /** Request scoped Supabase client carrying the user's auth context. */
  getSupabase: () => Promise<SupabaseClient | null>;
}

const TERMINAL_JOB_STATES = new Set(["done", "failed", "canceled"]);
const STALE_JOB_MS = 30 * 60 * 1000;

function tierKeyOf(plan: string): TierKey {
  const match = tiers.find((t) => t.key === plan);
  return match ? match.key : "free";
}

function toShotStatus(value: string | null): ShotStatus {
  switch (value) {
    case "generating":
    case "qc":
    case "done":
    case "failed":
    case "needs_review":
      return value;
    default:
      return "pending";
  }
}

interface QcRecord {
  pass?: unknown;
  fillPct?: unknown;
  background?: unknown;
}

function complianceFromQc(qc: Record<string, unknown> | null): JobShotView["compliance"] {
  if (!qc) {
    return null;
  }
  const record = qc as QcRecord;
  const background = Array.isArray(record.background) && record.background.length === 3
    ? ([Number(record.background[0]), Number(record.background[1]), Number(record.background[2])] as [
        number,
        number,
        number,
      ])
    : null;
  return {
    pass: record.pass === true,
    fillPct: typeof record.fillPct === "number" ? record.fillPct : null,
    background,
  };
}

export class DbService implements Services {
  readonly mode = "db" as const;

  constructor(private readonly deps: DbServiceDeps) {}

  private get db(): Db {
    return this.deps.db;
  }

  async getCurrentWorkspace(): Promise<WorkspaceSummary | null> {
    const userId = await this.deps.getUserId();
    if (!userId) {
      return null;
    }
    const membershipRow = await this.db.query.members.findFirst({
      where: (t, { eq }) => eq(t.userId, userId),
    });
    let membership: { workspaceId: string; role: WorkspaceRole } | null = membershipRow
      ? { workspaceId: membershipRow.workspaceId, role: membershipRow.role }
      : null;
    if (!membership) {
      // First session after signup: provision a workspace with the free
      // tier's one time credit grant, so value can land in session one
      // (plan 9.8 and the 9.1 free tier row).
      membership = await this.provisionWorkspace(userId);
      if (!membership) {
        return null;
      }
    }
    const workspace = await this.db.query.workspaces.findFirst({
      where: (t, { eq }) => eq(t.id, membership.workspaceId),
    });
    if (!workspace) {
      return null;
    }
    return {
      id: workspace.id,
      name: workspace.name,
      plan: workspace.plan,
      creditBalance: await this.creditBalance(workspace.id),
      role: membership.role,
    };
  }

  /** getCurrentWorkspace already provisions the first workspace on a
   * user's first session, so ensuring one is the same read. */
  async ensureWorkspace(): Promise<WorkspaceSummary | null> {
    return this.getCurrentWorkspace();
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<SaveResult> {
    const userId = await this.deps.getUserId();
    if (!userId) {
      return { ok: false, notice: "Sign in to rename the workspace." };
    }
    const membership = await this.db.query.members.findFirst({
      where: (t) => and(eq(t.userId, userId), eq(t.workspaceId, workspaceId)),
    });
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return { ok: false, notice: "Only owners and admins can rename the workspace." };
    }
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) {
      return { ok: false, notice: "Workspace name cannot be empty." };
    }
    await this.db
      .update(workspaces)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
    return { ok: true, notice: "Workspace name saved." };
  }

  /** Creates the user's first workspace, owner membership and the free tier's
   * one time credit grant. An advisory lock on the user id makes concurrent
   * first requests provision exactly once. */
  private async provisionWorkspace(
    userId: string,
  ): Promise<{ workspaceId: string; role: WorkspaceRole } | null> {
    const email = (await this.deps.getUserEmail?.()) ?? null;
    const name = email ? `${email.split("@")[0]} workspace` : "Your workspace";
    const freeCredits = tierByKey("free").creditsOnce;
    try {
      const rows = (await this.db.execute(
        sql`select provision_workspace(${userId}::uuid, ${name}::text, ${freeCredits}::numeric) as workspace_id`,
      )) as unknown as Array<{ workspace_id: string | null }>;
      const workspaceId = rows[0]?.workspace_id;
      if (!workspaceId) {
        return null;
      }
      return { workspaceId, role: "owner" };
    } catch {
      // Provisioning is best effort at read time; the caller sees the signed
      // out state and the next request retries.
      return null;
    }
  }

  /** The signed in member's role in this workspace, or null when they do not
   * belong to it. Plan 4.3: the client role reads assets but cannot generate
   * or bill, enforced here because the owner connection bypasses RLS. */
  private async currentRole(workspaceId: string): Promise<WorkspaceRole | null> {
    const userId = await this.deps.getUserId();
    if (!userId) {
      return null;
    }
    const membership = await this.db.query.members.findFirst({
      where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.userId, userId)),
    });
    return membership?.role ?? null;
  }

  private async creditBalance(workspaceId: string): Promise<number> {
    try {
      const rows = (await this.db.execute(
        sql`select credit_balance(${workspaceId}::uuid) as balance`,
      )) as unknown as Array<{ balance: number | string | null }>;
      return Number(rows[0]?.balance ?? 0);
    } catch {
      return 0;
    }
  }

  async listProducts(workspaceId: string): Promise<ProductSummary[]> {
    const rows = await this.db.query.products.findMany({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? "Untitled product",
      mode: row.mode,
      category: typeof row.profile?.category === "string" ? row.profile.category : "other",
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getProduct(workspaceId: string, productId: string): Promise<ProductSummary | null> {
    const row = await this.db.query.products.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, productId), eq(t.workspaceId, workspaceId)),
    });
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      title: row.title ?? "Untitled product",
      mode: row.mode,
      category: typeof row.profile?.category === "string" ? row.profile.category : "other",
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listRecentJobs(workspaceId: string, limit = 10): Promise<JobSummary[]> {
    const jobs = await this.db.query.generationJobs.findMany({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit,
    });
    if (jobs.length === 0) {
      return [];
    }
    const productIds = [...new Set(jobs.map((j) => j.productId))];
    const productRows = await this.db.query.products.findMany({
      where: (t, { inArray }) => inArray(t.id, productIds),
    });
    const titles = new Map(productRows.map((p) => [p.id, p.title ?? "Untitled product"]));
    return jobs.map((job) => ({
      id: job.id,
      productTitle: titles.get(job.productId) ?? "Untitled product",
      status: job.status as JobStatus,
      creditsReserved: job.creditsReserved,
      createdAt: job.createdAt.toISOString(),
    }));
  }

  async getJob(workspaceId: string, jobId: string): Promise<JobView | null> {
    let job = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
    });
    if (!job) {
      return null;
    }
    // Reconcile runs orphaned by an instance restart: the runner heartbeats
    // updated_at on every state change, every shot attempt and every stored
    // asset, so a job that has not moved in this window will never finish.
    // The update re-checks both conditions in SQL, so a run that heartbeats
    // or finishes between the read above and this write is never clobbered,
    // and only the request that wins the update releases the credits. The
    // worker refuses to leave a terminal state, so a failed job stays failed.
    if (!TERMINAL_JOB_STATES.has(job.status) && Date.now() - job.updatedAt.getTime() > STALE_JOB_MS) {
      const jobId = job.id;
      const staleBefore = new Date(Date.now() - STALE_JOB_MS);
      const reconciledError = "The run was interrupted before finishing. Reserved credits were released.";
      const [reconciled] = await this.db
        .update(generationJobs)
        .set({ status: "failed", error: reconciledError, updatedAt: new Date() })
        .where(
          and(
            eq(generationJobs.id, jobId),
            notInArray(generationJobs.status, ["done", "failed", "canceled"]),
            lt(generationJobs.updatedAt, staleBefore),
          ),
        )
        .returning();
      if (reconciled) {
        try {
          await this.db.execute(sql`select release_credits(${workspaceId}::uuid, ${jobId}::uuid)`);
        } catch (err) {
          console.error(`[jobs] could not release credits for reconciled job ${jobId}`, err);
        }
        job = reconciled;
      } else {
        // Lost the race: the run moved or finished. Show its current row.
        const current = await this.db.query.generationJobs.findFirst({ where: (t, { eq }) => eq(t.id, jobId) });
        if (current) {
          job = current;
        }
      }
    }
    const [product, steps, assetRows] = await Promise.all([
      this.db.query.products.findFirst({ where: (t, { eq }) => eq(t.id, job.productId) }),
      this.db.query.jobSteps.findMany({
        where: (t, { eq }) => eq(t.jobId, job.id),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      }),
      this.db.query.assets.findMany({ where: (t, { eq }) => eq(t.jobId, job.id) }),
    ]);

    const qcByShotType = new Map(assetRows.map((a) => [a.shotType, a.qc]));
    const latestByShot = new Map<string, (typeof steps)[number]>();
    for (const step of steps) {
      if (step.shotId) {
        latestByShot.set(step.shotId, step);
      }
    }
    const shots: JobShotView[] = [...latestByShot.entries()].map(([shotId, step]) => {
      const status = toShotStatus(step.status);
      return {
        shotId,
        shotType: step.stage ?? "shot",
        providerStage: step.provider ?? "worker",
        status,
        channels: [],
        credits: 0,
        compliance: status === "done" ? complianceFromQc(qcByShotType.get(step.stage ?? "") ?? null) : null,
      };
    });

    // Signed thumbnails for shots whose generated image landed in R2.
    // DbJobStore records each asset's shot id in its qc verdict and names
    // variants after the channel file, so map variant to shot via its asset.
    if (isR2Configured() && assetRows.length > 0) {
      const shotIdByAssetId = new Map<string, string>();
      for (const a of assetRows) {
        const qc = a.qc as { shotId?: unknown } | null;
        if (typeof qc?.shotId === "string") {
          shotIdByAssetId.set(a.id, qc.shotId);
        }
      }
      const variantRows = await this.db.query.assetVariants.findMany({
        where: (t, { inArray }) =>
          inArray(
            t.assetId,
            assetRows.map((a) => a.id),
          ),
      });
      const urlByShotId = new Map<string, string>();
      await Promise.all(
        variantRows.map(async (variant) => {
          const shotId = shotIdByAssetId.get(variant.assetId);
          // One thumbnail per shot is enough; the first variant wins. Only
          // this workspace's keys are signed (Update.md 4.1).
          if (!shotId || urlByShotId.has(shotId) || !isWorkspaceObjectKey(workspaceId, variant.r2Key)) {
            return;
          }
          try {
            urlByShotId.set(shotId, await presignObjectGet(variant.r2Key));
          } catch {
            // Missing or unsignable object: the card renders without a thumb.
          }
        }),
      );
      for (const shot of shots) {
        shot.imageUrl = urlByShotId.get(shot.shotId) ?? null;
      }
    }

    return {
      id: job.id,
      productId: job.productId,
      productTitle: product?.title ?? "Untitled product",
      status: job.status as JobStatus,
      mode: job.mode ?? product?.mode ?? "listing",
      channels: job.channels ?? [],
      creditsReserved: job.creditsReserved,
      creditsCharged: job.creditsCharged,
      createdAt: job.createdAt.toISOString(),
      shots,
      error: job.error ?? null,
    };
  }

  async createJob(workspaceId: string, input: CreateJobInput): Promise<CreateJobResult> {
    const existing = await this.db.query.generationJobs.findFirst({
      where: (t, { eq }) => eq(t.idempotencyKey, input.idempotencyKey),
    });
    if (existing) {
      // A replay must match the whole request body (plan 4.4.1); a reused key
      // with different channels or mode is a 409. A "new" product resolved to
      // a real id on the first attempt, so a retry can only match on the rest.
      const sameBody =
        existing.workspaceId === workspaceId &&
        (input.productId === "new" || existing.productId === input.productId) &&
        (existing.mode ?? input.mode) === input.mode &&
        JSON.stringify([...(existing.channels ?? input.channels)].sort()) ===
          JSON.stringify([...input.channels].sort());
      if (sameBody) {
        const job = await this.getJob(workspaceId, existing.id);
        if (job) {
          return { outcome: "replayed", job };
        }
      }
      if (existing.workspaceId !== workspaceId) {
        // Never leak another workspace's job id.
        return { outcome: "conflict" };
      }
      return { outcome: "conflict", existingJobId: existing.id };
    }

    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return {
        outcome: "rejected",
        reason: "role_forbidden",
        message: "Client seats can review assets but cannot start packs or spend credits.",
      };
    }

    let product;
    if (input.productId === "new") {
      const [created] = await this.db
        .insert(products)
        .values({
          workspaceId,
          title: input.newProductTitle?.trim() || "New product",
          mode: input.mode,
        })
        .returning();
      product = created;
    } else {
      product = await this.db.query.products.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, input.productId), eq(t.workspaceId, workspaceId)),
      });
    }
    if (!product) {
      return { outcome: "rejected", reason: "unknown_product", message: "That product does not exist in this workspace." };
    }

    // Register uploads sent with the job, then collect the media this pack
    // can draw from. Only keys inside this workspace's source prefix count.
    const uploads = (input.uploads ?? []).filter((u) => isWorkspaceSourceKey(workspaceId, u.key));
    if (uploads.length > 0) {
      await this.db.insert(sourceMedia).values(
        uploads.map((u) => ({
          workspaceId,
          productId: product.id,
          r2Key: u.key,
          kind: u.kind,
          sha256: u.sha256,
        })),
      );
    }
    // Update.md 4.1: the worker loads every media key with owner R2
    // credentials, so only keys in this workspace's source prefix are read,
    // including rows written before migration 0011 closed member writes.
    const media = (
      await this.db.query.sourceMedia.findMany({
        where: (t, { and, eq, like }) =>
          and(eq(t.productId, product.id), eq(t.workspaceId, workspaceId), like(t.r2Key, `ws/${workspaceId}/src/%`)),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
        limit: 6,
      })
    ).filter((m) => isWorkspaceSourceKey(workspaceId, m.r2Key));
    // Plan 2.7: Listing Mode requires at least one real photo. Angles that
    // were not photographed are skipped by the planner, never invented.
    if (input.mode === "listing" && !media.some((m) => m.kind !== "video")) {
      return {
        outcome: "rejected",
        reason: "needs_photo",
        message: "Listing Mode needs at least one real photo of this product. Upload one first, or switch to Concept Mode.",
      };
    }

    const workspace = await this.db.query.workspaces.findFirst({
      where: (t, { eq }) => eq(t.id, workspaceId),
    });
    const tier = tierKeyOf(workspace?.plan ?? "free");
    // Reservation is a seed cost estimate; the worker's planner recomputes the
    // exact plan and charge_credits bills only the assets that pass QC.
    const creditsReserved = estimatePackCredits(input.channels, input.mode, tier).total;
    if (creditsReserved <= 0) {
      return {
        outcome: "rejected",
        reason: "insufficient_credits",
        message: "This selection plans no billable shots. Pick at least one channel.",
      };
    }

    const [inserted] = await this.db
      .insert(generationJobs)
      .values({
        workspaceId,
        productId: product.id,
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        channels: input.channels,
        mode: input.mode,
      })
      .returning();

    try {
      await this.db.execute(
        sql`select reserve_credits(${workspaceId}::uuid, ${creditsReserved}::numeric, ${inserted.id}::uuid)`,
      );
    } catch {
      await this.db
        .update(generationJobs)
        .set({ status: "failed", error: "credit reservation failed" })
        .where(eq(generationJobs.id, inserted.id));
      return {
        outcome: "rejected",
        reason: "insufficient_credits",
        message: "Not enough credits for this pack. Top up or pick fewer channels.",
      };
    }

    // Brand colors are optional styling: a failed lookup must never fail a
    // job that already holds its credit reservation.
    let brandColors: string[] = [];
    try {
      const kit = await this.db.query.brandKits.findFirst({ where: (t, { eq }) => eq(t.workspaceId, workspaceId) });
      brandColors = Array.isArray(kit?.colors) ? kit.colors.filter((c): c is string => typeof c === "string") : [];
    } catch (err) {
      console.warn(`[jobs] brand kit lookup failed for workspace ${workspaceId}; using default colors`, err);
    }

    try {
      await enqueueGeneratePack(
        buildGeneratePackInput({
          jobId: inserted.id,
          workspaceId,
          tier,
          channels: input.channels,
          mode: input.mode,
          creditBudget: creditsReserved,
          product: {
            id: product.id,
            title: product.title,
            mode: product.mode,
            amazonSku: product.amazonSku,
          },
          media: media.map((m) => ({ r2Key: m.r2Key, kind: m.kind })),
          userDescription: input.userDescription,
          brandColors,
        }),
      );
    } catch (err) {
      // The reservation must never strand when the queue is unreachable.
      await this.db
        .update(generationJobs)
        .set({ status: "failed", error: "The pack could not be queued.", updatedAt: new Date() })
        .where(eq(generationJobs.id, inserted.id));
      await this.db.execute(
        sql`select release_credits(${workspaceId}::uuid, ${inserted.id}::uuid)`,
      );
      throw err;
    }

    const job = await this.getJob(workspaceId, inserted.id);
    if (!job) {
      return { outcome: "conflict", existingJobId: inserted.id };
    }
    return { outcome: "created", job };
  }

  async createProduct(workspaceId: string, input: CreateProductInput): Promise<ProductSummary | null> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return null;
    }
    const [row] = await this.db
      .insert(products)
      .values({ workspaceId, title: input.title, mode: input.mode })
      .returning();
    return {
      id: row.id,
      title: row.title ?? "Untitled product",
      mode: row.mode,
      category: "other",
      createdAt: row.createdAt.toISOString(),
    };
  }

  async registerSourceMedia(workspaceId: string, input: RegisterSourceMediaInput): Promise<SaveResult> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return { ok: false, notice: "Client seats cannot upload product photos." };
    }
    if (!isWorkspaceSourceKey(workspaceId, input.r2Key)) {
      return { ok: false, notice: "That upload does not belong to this workspace." };
    }
    const product = await this.db.query.products.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, input.productId), eq(t.workspaceId, workspaceId)),
    });
    if (!product) {
      return { ok: false, notice: "That product does not exist in this workspace." };
    }
    await this.db.insert(sourceMedia).values({
      workspaceId,
      productId: input.productId,
      r2Key: input.r2Key,
      kind: input.kind,
      width: input.width ?? null,
      height: input.height ?? null,
      sha256: input.sha256,
    });
    return { ok: true, notice: "Photo saved to this product." };
  }

  async listJobFiles(workspaceId: string, jobId: string): Promise<JobFilesView | null> {
    const job = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
    });
    if (!job) {
      return null;
    }
    const assetRows = await this.db.query.assets.findMany({
      where: (t, { eq }) => eq(t.jobId, job.id),
    });
    const assetIds = assetRows.map((a) => a.id);
    const [variantRows, packRows] = await Promise.all([
      assetIds.length > 0
        ? this.db.query.assetVariants.findMany({
            where: (t, { and, eq, inArray }) =>
              and(eq(t.workspaceId, workspaceId), inArray(t.assetId, assetIds)),
          })
        : Promise.resolve([]),
      this.db.query.packFiles.findMany({ where: (t, { eq }) => eq(t.jobId, job.id) }),
    ]);

    const canSign = isR2Configured();
    const files: JobFileView[] = [];
    for (const variant of variantRows) {
      // Only this workspace's keys are signed (Update.md 4.1).
      if (!isWorkspaceObjectKey(workspaceId, variant.r2Key)) {
        continue;
      }
      files.push({
        name: variant.filename,
        channel: variant.channelSpecId.split(".")[0],
        specId: variant.channelSpecId,
        kind: "image",
        bytes: variant.bytes,
        url: canSign ? await presignDownload(variant.r2Key) : null,
      });
    }
    for (const pack of packRows) {
      files.push({
        name: pack.filename,
        channel: pack.channel,
        specId: null,
        kind: pack.kind === "report" ? "report" : "zip",
        bytes: pack.bytes,
        url: canSign ? await presignDownload(pack.r2Key) : null,
      });
    }
    return {
      jobId: job.id,
      status: job.status as JobStatus,
      files,
      notice:
        files.length === 0 && job.status === "done"
          ? "This pack finished but no files were stored. Configure R2 so delivered files persist."
          : !canSign && files.length > 0
            ? "Files exist but R2 is not configured on this server, so download links are unavailable."
            : undefined,
    };
  }

  async getBrandKit(workspaceId: string): Promise<BrandKitView> {
    const row = await this.db.query.brandKits.findFirst({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    });
    // Update.md 4.2: only a key inside this workspace's source prefix is ever
    // presigned or handed back to the form, whatever the row holds.
    const logoKey = row?.logoR2Key && isWorkspaceSourceKey(workspaceId, row.logoR2Key) ? row.logoR2Key : null;
    let logoUrl: string | null = null;
    if (logoKey && isR2Configured()) {
      try {
        logoUrl = await presignObjectGet(logoKey);
      } catch {
        logoUrl = null;
      }
    }
    const stylePreset = row?.stylePreset && Object.hasOwn(presets, row.stylePreset) ? row.stylePreset : "minimal_studio";
    return {
      name: row?.name ?? "Default",
      colors: row?.colors ?? [],
      fonts: {
        heading: row?.fonts?.heading ?? "",
        body: row?.fonts?.body ?? "",
      },
      stylePreset,
      hasLogo: Boolean(logoKey || row?.logoAssetId),
      logoUrl,
      logoKey,
    };
  }

  /** Update.md 4.2: owner, admin and editor only; the kit is re validated
   * here because this is the trust boundary; a logo key must sit in this
   * workspace's source prefix; both insert and update run over the owner
   * connection, since migration 0011 leaves members no FOR ALL policy. */
  async saveBrandKit(workspaceId: string, kit: BrandKitView): Promise<SaveResult> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return { ok: false, notice: "Only owners, admins and editors can change the brand kit." };
    }
    const parsed = brandKitInputSchema.safeParse(kit);
    if (!parsed.success) {
      return { ok: false, notice: brandKitIssueNotice(parsed.error) };
    }
    const input = parsed.data;
    if (input.logoKey && !isWorkspaceSourceKey(workspaceId, input.logoKey)) {
      return { ok: false, notice: "That logo upload does not belong to this workspace. Upload it again." };
    }
    const existing = await this.db.query.brandKits.findFirst({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    });
    // No new logo keeps the current one, but never a key that fails the
    // prefix check (a legacy row), which the 0011 constraint would reject.
    const keptLogo =
      existing?.logoR2Key && isWorkspaceSourceKey(workspaceId, existing.logoR2Key) ? existing.logoR2Key : null;
    const values = {
      name: input.name,
      colors: input.colors,
      fonts: { heading: input.fonts.heading, body: input.fonts.body },
      stylePreset: input.stylePreset,
      logoR2Key: input.logoKey ?? keptLogo,
      updatedAt: new Date(),
    };
    if (!existing) {
      await this.db.insert(brandKits).values({ workspaceId, ...values });
    } else {
      await this.db
        .update(brandKits)
        .set(values)
        .where(and(eq(brandKits.id, existing.id), eq(brandKits.workspaceId, workspaceId)));
    }
    return { ok: true, notice: "Brand kit saved." };
  }

  async listMembers(workspaceId: string): Promise<MemberView[]> {
    const rows = await this.db.query.members.findMany({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    });
    return rows.map((row) => ({
      id: row.userId,
      label: `Member ${row.userId.slice(0, 8)}`,
      role: row.role,
    }));
  }

  async listIntegrations(workspaceId: string): Promise<IntegrationView[]> {
    const rows = await this.db.query.integrations.findMany({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    });
    const kinds: IntegrationView["kind"][] = ["shopify", "amazon"];
    return kinds.map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      return {
        kind,
        status: row?.encryptedToken ? "connected" : "not_connected",
        detail: row?.encryptedToken
          ? "Connected."
          : kind === "shopify"
            ? "Connect a store to get auto packs for new products."
            : "Amazon publishing arrives after launch. Packs download to convention names today.",
      };
    });
  }
}
