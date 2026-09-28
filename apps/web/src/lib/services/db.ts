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
import { presets, tierByKey } from "@curvi/pipeline/seed";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkBrandKitEntitlement, checkChannelEntitlements, tierKeyOf } from "@/lib/entitlements";
import { isR2Configured, optionalEnv } from "@/lib/env";
import { CONCEPT_MODE_AVAILABLE } from "@/lib/features";
import { publicJobError } from "@/lib/job-copy";
import { enqueueGeneratePack } from "@/lib/jobs/enqueue";
import { currentInlinePackRunner, InlineRunnerClosedError } from "@/lib/jobs/inline-runner";
import { buildGeneratePackInput } from "@/lib/jobs/payload";
import { pickSourcePhoto } from "@/lib/makeover";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { isWorkspaceKey, isWorkspaceSourceKey, presignDownload, presignObjectGet } from "@/lib/r2";
import { brandKitInputSchema, brandKitIssueNotice } from "@/lib/validation/brand-kit";
import { isUuid } from "@/lib/validation/ids";
import { ProvisioningError, RESTARTING_MESSAGE } from "./errors";
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
    // max 10: this pool serves every request, the /api/health select 1 (two
    // second timeout) and the inline runner's settle and queue heartbeat, so
    // 2 let one slow page starve the health check. The worker pool adds 5
    // (trigger/src/db-runtime.ts). The transaction pooler lends a server
    // connection only for the length of a transaction and accepts 200 clients
    // on the Nano and Micro computes (Supabase docs, checked 2026-09-28).
    globalScope.__curviDb = createDb(url, { max: 10, prepare: false });
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

// Defined in ./errors so routes can map them without loading this module.
export { PROVISIONING_ERROR_MESSAGE, ProvisioningError, RESTARTING_MESSAGE } from "./errors";

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

/** SQLSTATE reserve_credits raises for an insufficient balance (0012). */
const INSUFFICIENT_CREDITS_SQLSTATE = "CU402";
const UNAVAILABLE_MESSAGE = "We could not start this pack right now. Please try again in a minute.";

/** The Postgres error inside a driver or Drizzle error, if any. Drizzle wraps
 * driver errors (DrizzleQueryError) and keeps the original as cause. */
function pgErrorOf(err: unknown): { code?: string; message?: string } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        message: typeof candidate.message === "string" ? candidate.message : undefined,
      };
    }
    current = candidate.cause;
  }
  return null;
}

/** True only for reserve_credits refusing an underfunded workspace. Anything
 * else (a dropped connection, a missing workspace, a bad amount) is not a
 * credit problem and must never read as one (Update.md 1.8). */
export function isInsufficientCreditsError(err: unknown): boolean {
  const pg = pgErrorOf(err);
  if (!pg) {
    return false;
  }
  if (pg.code === INSUFFICIENT_CREDITS_SQLSTATE) {
    return true;
  }
  // Databases that have not applied 0012 raise the same message as a plain
  // exception (P0001).
  return pg.code === "P0001" && /insufficient credit balance/.test(pg.message ?? "");
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

/** Files are served for a finished pack, and for any pack that charged for
 * files it delivered. Charges run only after the pack is stored, and a job
 * that was settled has no hold left to charge against, so a charged job
 * really delivered what it billed for, even if it later ended failed. A run
 * the time cap or a restart settled writes no files and charges nothing, so
 * it stays unserved. */
function servesFiles(job: { status: string; creditsCharged: number | null }): boolean {
  return job.status === "done" || Number(job.creditsCharged ?? 0) > 0;
}

/**
 * True while this instance drains for a restart or deploy, the state in
 * which enqueueGeneratePack's assertAccepting refuses an inline pack. Read
 * without creating the runner: an instance that has no runner yet is not
 * draining, and the Trigger.dev path never creates one.
 */
function inlineRunnerDraining(): boolean {
  return currentInlinePackRunner()?.accepting === false;
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
    } else {
      // On Supabase the auth trigger creates the membership, so provisioning
      // never runs; settle a grant the trigger could not pay here.
      await this.settleSignupGrant(userId);
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

  /**
   * Pays the free signup grant for a user who has no settled grant yet
   * (migration 0012). The auth triggers call grant_signup_credits with no
   * fallback amount, so a signup confirmed before pnpm db:seed wrote
   * free_signup_credits, or a grant that errored inside the confirmation
   * trigger, would otherwise wait for someone to run the seed. The function
   * is idempotent under a per user advisory lock, still waits for a
   * confirmed email on Supabase, still dedupes by inbox, and pays the seeded
   * platform setting when it exists: the seed value passed here only counts
   * before the seed has run. Best effort: a failure is logged and retried on
   * the next request, and the page still loads.
   */
  private async settleSignupGrant(userId: string): Promise<void> {
    try {
      const settled = await this.db.query.signupGrants.findFirst({
        columns: { userId: true },
        where: (t, { eq }) => eq(t.userId, userId),
      });
      if (settled) {
        return;
      }
      const fallback = tierByKey("free").creditsOnce;
      await this.db.execute(sql`select grant_signup_credits(${userId}::uuid, ${fallback}::numeric)`);
    } catch (err) {
      console.error(`[credits] could not settle the signup grant for user ${userId}; the next request retries`, err);
    }
  }

  /** Creates the user's first workspace and owner membership. The free tier's
   * one time grant is paid by the database once the email is confirmed, from
   * the seeded platform setting (migration 0012); the seed value passed here
   * is only a fallback for a database the seed has not reached. An advisory
   * lock on the user id makes concurrent first requests provision once. */
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
    } catch (err) {
      // The page still renders, but a zero shown because the read failed must
      // be visible in the logs, never mistaken for an empty balance.
      console.error(`[credits] could not read the balance of workspace ${workspaceId}`, err);
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
    // Only a finished or charged pack shows them, since the download route
    // serves files for nothing else (servesFiles).
    if (assetRows.length > 0 && servesFiles(current)) {
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

    // The seller's original photo for the before and after reveal, signed
    // like the shot previews and only for a pack that serves files.
    let sourceImageUrl: string | null = null;
    if (current.status === "done" && isR2Configured() && shots.some((s) => s.imageUrl)) {
      const mediaRows = await this.db.query.sourceMedia.findMany({
        where: (t, { and, eq, like }) =>
          and(
            eq(t.productId, current.productId),
            eq(t.workspaceId, workspaceId),
            like(t.r2Key, `ws/${workspaceId}/src/%`),
          ),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
        limit: 50,
      });
      const source = pickSourcePhoto(mediaRows, current.createdAt, (key) => isWorkspaceSourceKey(workspaceId, key));
      if (source) {
        try {
          sourceImageUrl = await presignObjectGet(source.r2Key);
        } catch {
          // Unsignable object: the board shows no reveal.
          sourceImageUrl = null;
        }
      }
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
      sourceImageUrl,
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

    // Plan entitlements, from the seed: channels whose feature is not live or
    // not in this plan are refused before anything is written.
    const workspace = await this.db.query.workspaces.findFirst({
      where: (t, { eq }) => eq(t.id, workspaceId),
    });
    const tier = tierKeyOf(workspace?.plan);
    const entitled = checkChannelEntitlements(input.channels, tier);
    if (!entitled.ok) {
      return { outcome: "rejected", reason: entitled.reason, message: entitled.message };
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
    // The worker loads every media key with owner R2 credentials (Update.md
    // 4.1), so rows written before migration 0011 closed member writes are
    // filtered in SQL too, before the limit applies.
    const uploadRows = [
      ...new Map(
        (input.uploads ?? []).filter((u) => isWorkspaceSourceKey(workspaceId, u.key)).map((u) => [u.key, u]),
      ).values(),
    ];
    const uploads = uploadRows.map((u) => ({ r2Key: u.key, kind: u.kind }));
    const storedMedia = existingProduct
      ? (
          await this.db.query.sourceMedia.findMany({
            where: (t, { and, eq, like }) =>
              and(
                eq(t.productId, existingProduct.id),
                eq(t.workspaceId, workspaceId),
                like(t.r2Key, `ws/${workspaceId}/src/%`),
              ),
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

    // Reservation is a seed cost estimate that leaves out shots production
    // cannot deliver; the worker's planner recomputes the exact plan and
    // charge_credits bills only the assets that pass QC.
    const creditsReserved = estimatePackCredits(input.channels, input.mode, tier).total;
    if (creditsReserved <= 0) {
      return {
        outcome: "rejected",
        reason: "insufficient_credits",
        message: "This selection plans no billable shots. Pick at least one channel.",
      };
    }

    // A server draining for a restart or deploy takes no new packs. Asking
    // before the transaction means the refusal writes nothing: no product,
    // no photos, no job and no hold, so the seller's retry starts clean. A
    // drain that begins after this check is still refused by
    // enqueueGeneratePack, and abandonJob cleans up behind it.
    if (inlineRunnerDraining()) {
      console.warn(`[jobs] refused a pack in workspace ${workspaceId}: this server is draining`);
      return { outcome: "rejected", reason: "unavailable", message: RESTARTING_MESSAGE };
    }

    // Product, uploads, job and reservation commit together, so a rejected
    // pack leaves no empty product or orphan uploads behind (Update.md 6.3).
    let created: { product: typeof products.$inferSelect; jobId: string; insertedMediaIds: string[] };
    try {
      created = await this.db.transaction(async (tx) => {
        // Lock the workspace row before anything else. The foreign key checks
        // of the product, source_media and job inserts below each take FOR
        // KEY SHARE on this row, and reserve_credits then asks for FOR UPDATE
        // on it. Two packs created at once in one workspace would each hold
        // KEY SHARE and wait for the other to let go: Postgres aborts one with
        // a 40P01 deadlock and that seller's pack is refused. Taking FOR
        // UPDATE first serializes createJob per
        // workspace, so no transaction ever upgrades its lock. PGlite runs one
        // connection and serializes transactions, so the unit tests can check
        // the statement order but cannot reproduce the race itself.
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
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
        // The rows this request really inserted (a photo already saved is
        // skipped by ON CONFLICT), so an abandoned new product pack can hand
        // its photos back for the retry.
        const insertedMedia =
          uploadRows.length > 0
            ? await tx
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
                .onConflictDoNothing({ target: [sourceMedia.workspaceId, sourceMedia.r2Key] })
                .returning({ id: sourceMedia.id })
            : [];
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
        return { product, jobId: inserted.id, insertedMediaIds: insertedMedia.map((m) => m.id) };
      });
    } catch (err) {
      if (err instanceof ReservationError && isInsufficientCreditsError(err.original)) {
        // The transaction rolled back, so nothing was reserved or written.
        return {
          outcome: "rejected",
          reason: "insufficient_credits",
          message: "Not enough credits for this pack. Top up or pick fewer channels.",
        };
      }
      if (isUniqueViolation(err)) {
        // A concurrent request with the same Idempotency-Key committed first.
        const winner = await this.replayFor(workspaceId, input);
        if (winner) {
          return winner;
        }
      }
      // Anything else is not a credit problem and must never read as one
      // (Update.md 1.8). The transaction rolled back, so nothing is held.
      console.error(
        `[jobs] could not create a job in workspace ${workspaceId}`,
        err instanceof ReservationError ? err.original : err,
      );
      return { outcome: "rejected", reason: "unavailable", message: UNAVAILABLE_MESSAGE };
    }
    const { product, jobId, insertedMediaIds } = created;

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
      // The reservation must never strand when the queue is unreachable, and
      // a cleanup failure must never hide why the pack did not start.
      const restarting = err instanceof InlineRunnerClosedError;
      if (restarting) {
        // This instance is draining for a restart or deploy and takes no new
        // packs. Expected during a deploy, so a warning, not an error.
        console.warn(`[jobs] refused job ${jobId} in workspace ${workspaceId}: this server is draining`);
      } else {
        console.error(`[jobs] could not queue job ${jobId} in workspace ${workspaceId}`, err);
      }
      // A product this request created keeps no photos, so a retry as a new
      // product saves them to the product it creates. Photos added to an
      // existing product stay: a retry puts them on the same product.
      await this.abandonJob(workspaceId, jobId, "The pack could not be queued.", existingProduct ? [] : insertedMediaIds);
      return { outcome: "rejected", reason: "unavailable", message: restarting ? RESTARTING_MESSAGE : UNAVAILABLE_MESSAGE };
    }

    const job = await this.getJob(workspaceId, jobId);
    if (!job) {
      return { outcome: "conflict", existingJobId: jobId };
    }
    return { outcome: "created", job };
  }

  /**
   * Cleans up behind a job that never started. Best effort throughout, so a
   * cleanup error never replaces the error the caller reports.
   *
   * - Returns everything the job still holds, then marks it failed. When the
   *   release fails the job stays queued, so the stale run reconciler fails
   *   it and returns the hold later; a failed job would keep its hold for
   *   good.
   * - Frees its Idempotency-Key either way. The caller answers with a
   *   refusal, so the seller's retry of the same form must create a fresh
   *   job, never replay this one as a started pack.
   * - Deletes the photo rows in releaseMediaIds (the ones a new product pack
   *   inserted), so a retry saves them to the product it creates instead of
   *   leaving them on this one (the unique index keeps a photo on one
   *   product).
   */
  private async abandonJob(
    workspaceId: string,
    jobId: string,
    error: string,
    releaseMediaIds: string[] = [],
  ): Promise<void> {
    let released = true;
    try {
      await this.db.execute(sql`select release_credits(${workspaceId}::uuid, ${jobId}::uuid)`);
    } catch (err) {
      released = false;
      console.error(
        `[jobs] could not release credits held by job ${jobId}; leaving it for the stale run reconciler`,
        err,
      );
    }
    try {
      await this.db
        .update(generationJobs)
        .set(released ? { status: "failed", error, idempotencyKey: null, updatedAt: new Date() } : { idempotencyKey: null })
        .where(and(eq(generationJobs.id, jobId), eq(generationJobs.workspaceId, workspaceId)));
    } catch (err) {
      console.error(`[jobs] could not mark job ${jobId} as abandoned`, err);
    }
    if (releaseMediaIds.length === 0) {
      return;
    }
    try {
      // Ids come from this request's insert ... returning, never from input.
      await this.db
        .delete(sourceMedia)
        .where(
          and(
            eq(sourceMedia.workspaceId, workspaceId),
            sql`${sourceMedia.id} = any(${`{${releaseMediaIds.join(",")}}`}::uuid[])`,
          ),
        );
    } catch (err) {
      console.warn(`[jobs] could not free the photos of abandoned job ${jobId}`, err);
    }
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
    if (!servesFiles(job)) {
      // Nothing is listed or signed until the pack is done or charged.
      return { jobId: job.id, status: job.status as JobStatus, files: [] };
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
    if (!job || !servesFiles(job)) {
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
   * workspace's source prefix; the plan must include a brand kit
   * (entitlementsFor(tier).brandKits); both insert and update run over the
   * owner connection, since migration 0011 leaves members no FOR ALL policy. */
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
    const [workspace, kits] = await Promise.all([
      this.db.query.workspaces.findFirst({ where: (t, { eq }) => eq(t.id, workspaceId) }),
      this.db.query.brandKits.findMany({ where: (t, { eq }) => eq(t.workspaceId, workspaceId) }),
    ]);
    const existing = kits[0];
    // Plan entitlements, from the seed: Free holds no brand kit, so saving
    // one asks for an upgrade instead of storing a kit the plan does not
    // include.
    const allowance = checkBrandKitEntitlement(tierKeyOf(workspace?.plan), kits.length, !existing);
    if (!allowance.ok) {
      return { ok: false, reason: allowance.reason, notice: allowance.message };
    }
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
