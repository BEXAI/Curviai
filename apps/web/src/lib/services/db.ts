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
} from "@curvi/db";
import { tierByKey, tiers, type TierKey } from "@curvi/pipeline/seed";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isR2Configured, optionalEnv } from "@/lib/env";
import { CONCEPT_MODE_AVAILABLE } from "@/lib/features";
import { publicJobError } from "@/lib/job-copy";
import { enqueueGeneratePack } from "@/lib/jobs/enqueue";
import { buildGeneratePackInput } from "@/lib/jobs/payload";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { isWorkspaceKey, isWorkspaceSourceKey, presignDownload, presignObjectGet } from "@/lib/r2";
import { isUuid } from "@/lib/uuid";
import { buildShotViews } from "./job-shots";
import { looksStale, reconcileStaleJobs } from "./reconcile";
import type {
  BrandKitView,
  CreateJobInput,
  CreateJobResult,
  CreateProductInput,
  IntegrationView,
  JobFileDownload,
  JobFilesView,
  JobFileView,
  JobStatus,
  JobSummary,
  JobView,
  MemberView,
  ProductSummary,
  RegisterSourceMediaInput,
  SaveResult,
  Services,
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

/** Most photos a pack sends to the worker: this request's uploads first,
 * then the product's newest stored photos. */
const MAX_PACK_MEDIA = 6;

export const PROVISIONING_ERROR_MESSAGE = "We could not set up your workspace. Try again in a minute.";

/**
 * Provisioning the first workspace failed (a database error, not a signed
 * out user). Thrown instead of returning null, so a signup that could not be
 * set up surfaces as a retryable server error rather than a "Sign in" prompt
 * (Update.md 6.8). Routes map it to 503 with PROVISIONING_ERROR_MESSAGE.
 */
export class ProvisioningError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(PROVISIONING_ERROR_MESSAGE, options);
    this.name = "ProvisioningError";
  }
}

/** Thrown inside the createJob transaction when reserve_credits refuses, so
 * the transaction rolls back and the caller can answer with a rejection. */
class ReservationError extends Error {
  constructor(readonly original: unknown) {
    super("credit reservation failed");
    this.name = "ReservationError";
  }
}

/** Postgres error fields, looked up through Drizzle's wrapping error. */
function pgErrorField(err: unknown, field: "code" | "message"): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const value = (current as Record<string, unknown>)[field];
    if (field === "code" && typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) {
      return value;
    }
    if (field === "message" && typeof value === "string" && /insufficient credit/i.test(value)) {
      return value;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorField(err, "code") === "23505";
}

/** reserve_credits raises "insufficient credit balance" when the workspace
 * cannot cover the hold. */
function isInsufficientBalance(err: unknown): boolean {
  return pgErrorField(err, "message") !== null;
}

function tierKeyOf(plan: string): TierKey {
  const match = tiers.find((t) => t.key === plan);
  return match ? match.key : "free";
}

interface PackMedia {
  r2Key: string;
  kind: "image" | "video" | "frame" | null;
}

/** This request's uploads first, then stored photos, one entry per object,
 * capped at MAX_PACK_MEDIA. */
function mergePackMedia(uploads: PackMedia[], stored: PackMedia[]): PackMedia[] {
  const seen = new Set<string>();
  const merged: PackMedia[] = [];
  for (const item of [...uploads, ...stored]) {
    if (seen.has(item.r2Key)) {
      continue;
    }
    seen.add(item.r2Key);
    merged.push(item);
  }
  return merged.slice(0, MAX_PACK_MEDIA);
}

/** Parses a JobFileView id: "v_<asset variant uuid>" or "p_<pack file uuid>". */
function parseFileId(fileId: string): { table: "variant" | "pack"; id: string } | null {
  const match = /^([vp])_(.+)$/.exec(fileId);
  if (!match || !isUuid(match[2])) {
    return null;
  }
  return { table: match[1] === "v" ? "variant" : "pack", id: match[2] };
}

function fileDownloadPath(jobId: string, fileId: string): string {
  return `/api/jobs/${jobId}/files/${fileId}`;
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
    } catch (err) {
      // A signed in user whose workspace could not be created is a server
      // error, not a signed out state: surface it so the page offers a retry
      // instead of a misleading "Sign in" (Update.md 6.8).
      console.error(`[workspace] provisioning failed for user ${userId}`, err);
      throw new ProvisioningError({ cause: err });
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
    // Settle orphaned runs first, so a hold left by a crashed run never makes
    // the balance look lower than it is (Update.md 3.2).
    await reconcileStaleJobs(this.db, { workspaceId });
    try {
      const result = (await this.db.execute(sql`select credit_balance(${workspaceId}::uuid) as balance`)) as unknown;
      // postgres-js returns the rows array; other drivers wrap it in { rows }.
      const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
        balance: number | string | null;
      }>;
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
    // Orphaned runs show as failed here, not as running forever (Update.md 3.2).
    await reconcileStaleJobs(this.db, { workspaceId });
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
    if (!isUuid(jobId)) {
      return null;
    }
    const findJob = () =>
      this.db.query.generationJobs.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
      });
    let job = await findJob();
    if (!job) {
      return null;
    }
    // Reconcile a run orphaned by an instance restart (Update.md 3.1). Only
    // the request that wins the conditional update releases the hold; every
    // request then reads the current row.
    if (looksStale(job)) {
      await reconcileStaleJobs(this.db, { workspaceId, jobId: job.id });
      job = (await findJob()) ?? job;
    }
    const current = job;
    const [product, steps, assetRows] = await Promise.all([
      this.db.query.products.findFirst({ where: (t, { eq }) => eq(t.id, current.productId) }),
      this.db.query.jobSteps.findMany({
        where: (t, { eq }) => eq(t.jobId, current.id),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      }),
      this.db.query.assets.findMany({ where: (t, { eq }) => eq(t.jobId, current.id) }),
    ]);

    const shots = buildShotViews(steps, assetRows);

    // Delivered variants give each finished shot its real channels, a
    // preview and a download link. DbJobStore records each asset's shot id
    // in its qc verdict, so a variant maps to its shot through its asset.
    if (assetRows.length > 0) {
      const shotIdByAssetId = new Map<string, string>();
      for (const a of assetRows) {
        const shotId = a.qc && typeof a.qc.shotId === "string" ? a.qc.shotId : null;
        if (shotId) {
          shotIdByAssetId.set(a.id, shotId);
        }
      }
      const variantRows = await this.db.query.assetVariants.findMany({
        where: (t, { and, eq, inArray }) =>
          and(
            eq(t.workspaceId, workspaceId),
            inArray(
              t.assetId,
              assetRows.map((a) => a.id),
            ),
          ),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      });
      const variantsByShot = new Map<string, typeof variantRows>();
      for (const variant of variantRows) {
        const shotId = shotIdByAssetId.get(variant.assetId);
        if (!shotId || !isWorkspaceKey(workspaceId, variant.r2Key)) {
          continue;
        }
        variantsByShot.set(shotId, [...(variantsByShot.get(shotId) ?? []), variant]);
      }
      const canSign = isR2Configured();
      await Promise.all(
        shots.map(async (shot) => {
          const variants = variantsByShot.get(shot.shotId);
          if (!variants || variants.length === 0) {
            return;
          }
          shot.channels = [...new Set(variants.map((v) => v.channelSpecId))];
          if (!canSign) {
            return;
          }
          // One preview per shot is enough; the first delivered file wins.
          const first = variants[0];
          shot.downloadUrl = fileDownloadPath(current.id, `v_${first.id}`);
          try {
            shot.imageUrl = await presignObjectGet(first.r2Key);
          } catch {
            // Unsignable object: the card renders without a preview.
            shot.imageUrl = null;
          }
        }),
      );
    }

    return {
      id: current.id,
      productId: current.productId,
      productTitle: product?.title ?? "Untitled product",
      status: current.status as JobStatus,
      mode: current.mode ?? product?.mode ?? "listing",
      channels: current.channels ?? [],
      creditsReserved: current.creditsReserved,
      creditsCharged: current.creditsCharged,
      createdAt: current.createdAt.toISOString(),
      shots,
      // Raw worker errors can name providers; the board gets plain copy and
      // the detail stays in the row and the logs.
      error: current.status === "failed" ? publicJobError(current.error) : null,
    };
  }

  /** The replay or conflict answer for a reused Idempotency-Key, or null
   * when the key is new. A replay must match the request body (plan 4.4.1);
   * a "new" product resolved to a real id on the first attempt, so a retry
   * can only match on the rest. */
  private async replayFor(workspaceId: string, input: CreateJobInput): Promise<CreateJobResult | null> {
    const existing = await this.db.query.generationJobs.findFirst({
      where: (t, { eq }) => eq(t.idempotencyKey, input.idempotencyKey),
    });
    if (!existing) {
      return null;
    }
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

  /**
   * Creates a pack job (Update.md 6.3). Everything that can reject the
   * request is checked before anything is written: role, mode, product,
   * uploads, photo requirement and the credit estimate. The product (when
   * new), the uploads, the job row and the credit hold are then written in
   * one transaction, so a rejected or failed attempt leaves no empty product,
   * no stray media and no job behind. Uploads insert with ON CONFLICT DO
   * NOTHING against the (workspace_id, r2_key) unique index, so a retry never
   * duplicates a photo.
   */
  async createJob(workspaceId: string, input: CreateJobInput): Promise<CreateJobResult> {
    const replay = await this.replayFor(workspaceId, input);
    if (replay) {
      return replay;
    }

    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return {
        outcome: "rejected",
        reason: "role_forbidden",
        message: "Client seats can review assets but cannot start packs or spend credits.",
      };
    }

    if (input.mode === "concept" && !CONCEPT_MODE_AVAILABLE) {
      return {
        outcome: "rejected",
        reason: "mode_unavailable",
        message: "Concept Mode is not available yet. Start a Listing Mode pack from a real photo.",
      };
    }

    let existingProduct: typeof products.$inferSelect | null = null;
    if (input.productId !== "new") {
      existingProduct = isUuid(input.productId)
        ? ((await this.db.query.products.findFirst({
            where: (t, { and, eq }) => and(eq(t.id, input.productId), eq(t.workspaceId, workspaceId)),
          })) ?? null)
        : null;
      if (!existingProduct) {
        return { outcome: "rejected", reason: "unknown_product", message: "That product does not exist in this workspace." };
      }
    }

    // Only keys inside this workspace's source prefix count, for this
    // request's uploads and for the photos already stored on the product.
    const uploadRows = [
      ...new Map(
        (input.uploads ?? []).filter((u) => isWorkspaceSourceKey(workspaceId, u.key)).map((u) => [u.key, u]),
      ).values(),
    ];
    const uploads = uploadRows.map((u) => ({ r2Key: u.key, kind: u.kind }));
    const storedMedia = existingProduct
      ? (
          await this.db.query.sourceMedia.findMany({
            where: (t, { and, eq }) => and(eq(t.productId, existingProduct.id), eq(t.workspaceId, workspaceId)),
            orderBy: (t, { desc }) => [desc(t.createdAt)],
            limit: MAX_PACK_MEDIA,
          })
        )
          .filter((m) => isWorkspaceSourceKey(workspaceId, m.r2Key))
          .map((m) => ({ r2Key: m.r2Key, kind: m.kind }))
      : [];
    const media = mergePackMedia(uploads, storedMedia);

    // Plan 2.7: Listing Mode requires at least one real photo. Angles that
    // were not photographed are skipped by the planner, never invented.
    if (input.mode === "listing" && !media.some((m) => m.kind !== "video")) {
      return {
        outcome: "rejected",
        reason: "needs_photo",
        message: "Listing Mode needs at least one real photo of this product. Upload one first.",
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

    let created: { product: typeof products.$inferSelect; jobId: string };
    try {
      created = await this.db.transaction(async (tx) => {
        const product =
          existingProduct ??
          (
            await tx
              .insert(products)
              .values({
                workspaceId,
                title: input.newProductTitle?.trim() || "New product",
                mode: input.mode,
              })
              .returning()
          )[0];
        if (uploadRows.length > 0) {
          await tx
            .insert(sourceMedia)
            .values(
              uploadRows.map((u) => ({
                workspaceId,
                productId: product.id,
                r2Key: u.key,
                kind: u.kind,
                sha256: u.sha256,
              })),
            )
            .onConflictDoNothing({ target: [sourceMedia.workspaceId, sourceMedia.r2Key] });
        }
        const [inserted] = await tx
          .insert(generationJobs)
          .values({
            workspaceId,
            productId: product.id,
            status: "queued",
            idempotencyKey: input.idempotencyKey,
            channels: input.channels,
            mode: input.mode,
          })
          .returning({ id: generationJobs.id });
        try {
          await tx.execute(
            sql`select reserve_credits(${workspaceId}::uuid, ${creditsReserved}::numeric, ${inserted.id}::uuid)`,
          );
        } catch (err) {
          throw new ReservationError(err);
        }
        return { product, jobId: inserted.id };
      });
    } catch (err) {
      if (err instanceof ReservationError) {
        if (isInsufficientBalance(err.original)) {
          return {
            outcome: "rejected",
            reason: "insufficient_credits",
            message: "Not enough credits for this pack. Top up or pick fewer channels.",
          };
        }
        throw err.original;
      }
      if (isUniqueViolation(err)) {
        // A concurrent request with the same Idempotency-Key committed first.
        const winner = await this.replayFor(workspaceId, input);
        if (winner) {
          return winner;
        }
      }
      throw err;
    }
    const { product, jobId } = created;

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
          jobId,
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
          media,
          userDescription: input.userDescription,
          brandColors,
        }),
      );
    } catch (err) {
      // The reservation must never strand when the queue is unreachable.
      await this.db
        .update(generationJobs)
        .set({ status: "failed", error: "The pack could not be queued.", updatedAt: new Date() })
        .where(eq(generationJobs.id, jobId));
      try {
        await this.db.execute(sql`select release_credits(${workspaceId}::uuid, ${jobId}::uuid)`);
      } catch (releaseErr) {
        console.error(`[jobs] could not release credits for unqueued job ${jobId}`, releaseErr);
      }
      throw err;
    }

    const job = await this.getJob(workspaceId, jobId);
    if (!job) {
      return { outcome: "conflict", existingJobId: jobId };
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
      return { ok: false, reason: "forbidden", notice: "Client seats cannot upload product photos." };
    }
    if (!isWorkspaceSourceKey(workspaceId, input.r2Key)) {
      return { ok: false, reason: "foreign_key", notice: "That upload does not belong to this workspace." };
    }
    const product = isUuid(input.productId)
      ? await this.db.query.products.findFirst({
          where: (t, { and, eq }) => and(eq(t.id, input.productId), eq(t.workspaceId, workspaceId)),
        })
      : undefined;
    if (!product) {
      return { ok: false, reason: "unknown_product", notice: "That product does not exist in this workspace." };
    }
    // One row per uploaded object: registering the same upload again is a
    // no op, and an upload saved to another product stays there.
    const inserted = await this.db
      .insert(sourceMedia)
      .values({
        workspaceId,
        productId: input.productId,
        r2Key: input.r2Key,
        kind: input.kind,
        width: input.width ?? null,
        height: input.height ?? null,
        sha256: input.sha256,
      })
      .onConflictDoNothing({ target: [sourceMedia.workspaceId, sourceMedia.r2Key] })
      .returning({ id: sourceMedia.id });
    if (inserted.length === 0) {
      const existing = await this.db.query.sourceMedia.findFirst({
        where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.r2Key, input.r2Key)),
      });
      if (existing && existing.productId !== input.productId) {
        return { ok: false, reason: "conflict", notice: "That photo is already saved to another product." };
      }
    }
    return { ok: true, notice: "Photo saved to this product." };
  }

  async listJobFiles(workspaceId: string, jobId: string): Promise<JobFilesView | null> {
    if (!isUuid(jobId)) {
      return null;
    }
    const job = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
    });
    if (!job) {
      return null;
    }
    const assetRows = await this.db.query.assets.findMany({
      where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspaceId)),
    });
    const assetIds = assetRows.map((a) => a.id);
    const [variantRows, packRows] = await Promise.all([
      assetIds.length > 0
        ? this.db.query.assetVariants.findMany({
            where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.assetId, assetIds)),
          })
        : Promise.resolve([]),
      this.db.query.packFiles.findMany({
        where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspaceId)),
      }),
    ]);

    // Previews are signed for an hour; every download goes through the
    // download route, which signs a fresh, named url on each click
    // (Update.md 6.6). Keys outside this workspace are never signed.
    const canSign = isR2Configured();
    const files: JobFileView[] = [];
    const variants = variantRows
      .filter((v) => isWorkspaceKey(workspaceId, v.r2Key))
      .sort((a, b) => a.channelSpecId.localeCompare(b.channelSpecId) || a.filename.localeCompare(b.filename));
    for (const variant of variants) {
      const id = `v_${variant.id}`;
      let url: string | null = null;
      if (canSign) {
        try {
          url = await presignObjectGet(variant.r2Key);
        } catch {
          url = null;
        }
      }
      files.push({
        id,
        name: variant.filename,
        channel: variant.channelSpecId.split(".")[0],
        specId: variant.channelSpecId,
        kind: "image",
        bytes: variant.bytes,
        url,
        downloadUrl: canSign ? fileDownloadPath(job.id, id) : null,
      });
    }
    for (const pack of packRows.filter((p) => isWorkspaceKey(workspaceId, p.r2Key))) {
      const id = `p_${pack.id}`;
      files.push({
        id,
        name: pack.filename,
        channel: pack.channel,
        specId: null,
        kind: pack.kind === "report" ? "report" : "zip",
        bytes: pack.bytes,
        url: null,
        downloadUrl: canSign ? fileDownloadPath(job.id, id) : null,
      });
    }

    const hasImages = files.some((f) => f.kind === "image");
    let notice: string | undefined;
    if (job.status === "done" && !hasImages) {
      notice =
        files.length === 0
          ? "This pack finished, but its files are not available. Contact us and we will sort it out."
          : "No shot passed our checks, so this pack has no image files and nothing was charged for them.";
    } else if (!canSign && files.length > 0) {
      notice = "Your files are stored, but downloads are not available on this server right now. Try again later.";
    }
    return { jobId: job.id, status: job.status as JobStatus, files, notice };
  }

  async getJobFileDownload(workspaceId: string, jobId: string, fileId: string): Promise<JobFileDownload | null> {
    const parsed = parseFileId(fileId);
    if (!parsed || !isUuid(jobId) || !isR2Configured()) {
      return null;
    }
    const job = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
    });
    if (!job) {
      return null;
    }
    let file: { r2Key: string; filename: string } | null = null;
    if (parsed.table === "variant") {
      const variant = await this.db.query.assetVariants.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, parsed.id), eq(t.workspaceId, workspaceId)),
      });
      const asset = variant
        ? await this.db.query.assets.findFirst({
            where: (t, { and, eq }) => and(eq(t.id, variant.assetId), eq(t.jobId, job.id)),
          })
        : undefined;
      file = variant && asset ? { r2Key: variant.r2Key, filename: variant.filename } : null;
    } else {
      const pack = await this.db.query.packFiles.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, parsed.id), eq(t.jobId, job.id), eq(t.workspaceId, workspaceId)),
      });
      file = pack ? { r2Key: pack.r2Key, filename: pack.filename } : null;
    }
    if (!file || !isWorkspaceKey(workspaceId, file.r2Key)) {
      return null;
    }
    return { url: await presignDownload(file.r2Key, file.filename), filename: file.filename };
  }

  async getBrandKit(workspaceId: string): Promise<BrandKitView> {
    const row = await this.db.query.brandKits.findFirst({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    });
    let logoUrl: string | null = null;
    if (row?.logoR2Key && isR2Configured()) {
      try {
        logoUrl = await presignObjectGet(row.logoR2Key);
      } catch {
        logoUrl = null;
      }
    }
    return {
      name: row?.name ?? "Default",
      colors: row?.colors ?? [],
      fonts: {
        heading: row?.fonts?.heading ?? "",
        body: row?.fonts?.body ?? "",
      },
      stylePreset: row?.stylePreset ?? "minimal_studio",
      hasLogo: Boolean(row?.logoR2Key || row?.logoAssetId),
      logoUrl,
      logoKey: row?.logoR2Key ?? null,
    };
  }

  async saveBrandKit(workspaceId: string, kit: BrandKitView): Promise<SaveResult> {
    const existing = await this.db.query.brandKits.findFirst({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    });
    if (!existing) {
      await this.db.insert(brandKits).values({
        workspaceId,
        name: kit.name,
        colors: kit.colors,
        fonts: { heading: kit.fonts.heading, body: kit.fonts.body },
        stylePreset: kit.stylePreset,
        logoR2Key: kit.logoKey ?? null,
      });
      return { ok: true, notice: "Brand kit saved." };
    }
    const supabase = await this.deps.getSupabase();
    if (!supabase) {
      return { ok: false, notice: "Supabase is not configured, so the brand kit was not updated." };
    }
    const { error } = await supabase
      .from("brand_kits")
      .update({
        name: kit.name,
        colors: kit.colors,
        fonts: { heading: kit.fonts.heading, body: kit.fonts.body },
        style_preset: kit.stylePreset,
        logo_r2_key: kit.logoKey ?? existing.logoR2Key ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) {
      return { ok: false, notice: "Saving failed. Check that your role allows editing the brand kit." };
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
