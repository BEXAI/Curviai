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
  spendCapCounters,
  type Db,
  assetVariants,
  brandKits,
  favorites,
  inArray,
  packFiles,
  generationJobs,
  jobSteps,
  products,
  recordFunnelEvent,
  sourceMedia,
  uploadPreflights,
  workspaces,
  sql,
  eq,
  and,
  type SourceMediaTargetBox,
} from "@curvi/db";
import { jobRequestFingerprint } from "./job-request";
import {
  bundleOf,
  cutoutMediaIds,
  packNeedsCutout,
  type ResolvedOutputOptions,
} from "@curvi/pipeline/output-options";
import type { IngestImageFormat, SourceMediaIngest } from "@curvi/pipeline/ingest";
import { IntakeImageResult, type Shot } from "@curvi/pipeline/schemas";
import { parseVariationShotId, variationShotId } from "@curvi/pipeline/variations";
import { SOURCE_RETENTION_DAYS } from "@/lib/trust/purge";
import { getSpec, hasSpec, refusesOverlays } from "@curvi/specs";
import { readSourceSelection, SourceSelectionUnavailableError, type SourceSelection, type PackFollowUpInput, type PackFollowUpReason } from "@curvi/trigger/follow-up";
import {
  costCaps,
  creditCosts,
  followUpPricing,
  serviceListLimits,
  variationOptions,
  AUTO_STYLE_PRESET,
  entitlementsFor,
  presets,
  socialBadgeByTier,
  tierByKey,
  type TierKey,
} from "@curvi/pipeline/seed";
import { isAngleRole, printableEndorsements, printableSellerLines, type AngleRole } from "@curvi/pipeline/seller-inputs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildComplianceReportView,
  REPORT_NOT_READY,
  REPORT_NOT_STORED,
  unavailableComplianceReport,
  type ComplianceReportView,
} from "@/lib/compliance-report";
import { existingReportKey, prepareReportSnapshot, readSelectedReport, readStoredReportBytes } from "@/lib/selected-report-download";
import { checkBrandKitEntitlement, checkChannelEntitlements, tierKeyOf } from "@/lib/entitlements";
import { isR2Configured, optionalEnv } from "@/lib/env";
import { CONCEPT_MODE_AVAILABLE, opsSwitch, outputOptionsAvailable } from "@/lib/features";
import { resolveGlobalHardStop } from "@curvi/trigger/db-runtime";
import { getPackMaintenance } from "@/lib/pack-maintenance";
import { readCreditBudget } from "@/lib/billing/credit-planning";
import { creditBudgetRejection, isCreditBudgetExceeded } from "@/lib/billing/credit-budget";
import { runnerId } from "@/lib/jobs/runner-owner";
import { fidelityForVariant } from "./file-fidelity";
import { queueView } from "@/lib/jobs/queue-view";
import { platformSettingReader } from "@/lib/platform-settings";
import { inventoryView } from "@/lib/inventory-copy";
import { outputOptionsSummary, publicJobError, shotCopyContextOf } from "@/lib/job-copy";
import { OPTIONS_UNREADABLE_COPY } from "@/lib/output-options-copy";
import {
  packsPausedCopy,
  providerPreflightDetail,
  type PreflightDetail,
  type PreflightVerdict,
} from "@/lib/provider-preflight";
import { enqueueGeneratePack, enqueuePackFollowUp, settleJob } from "@/lib/jobs/enqueue";
import { currentInlinePackRunner, InlineRunnerClosedError } from "@/lib/jobs/inline-runner";
import { brandStyleFor, buildGeneratePackInput, seoSlugFor, type PayloadBrandKit } from "@/lib/jobs/payload";
import { pickSourcePhoto } from "@/lib/makeover";
import { estimatePackCredits, estimatedSpecCoverage, type EstimateSellerInputs } from "@/lib/pack-estimate";
import {
  getObjectBytes,
  isWorkspaceKey,
  isWorkspaceSourceKey,
  presignDownload,
  presignObjectGet,
  putGeneratedObject,
} from "@/lib/r2";
import {
  preflightAddedOverlaysOf,
  preflightProductBoxOf,
  preflightRowsFor,
  sellerAnswersFor,
  sellerAnswersFromChoices,
  preflightUpload as runPreflightUpload,
  reusableIntakeOf,
  type PreflightServiceDeps,
} from "@/lib/preflight/service";
import type { PreflightOutcome } from "@/lib/preflight/types";
import type { UploadPreflight } from "@curvi/db";
import { brandKitInputSchema, brandKitIssueNotice, normalizeFontChoice } from "@/lib/validation/brand-kit";
import { brandPaletteOutcomeOf, defaultBrandPaletteRun, type BrandPaletteOutcome, type BrandPaletteRunner } from "@/lib/brand/palette";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import { answerSaysSomething, readSellerProfile, sellerProfileJson, type SellerAnswer, type SellerProfile } from "@/lib/seller-profile";
import { isUuid } from "@/lib/validation/ids";
import { MAX_PACK_PHOTOS } from "@/lib/validation/seller-inputs";
import { ingestUpload, type IngestOutcome } from "@/lib/trust/ingest";
import { r2TrustStorage } from "@/lib/trust/storage";
import { assertRegisteredSources, assertSourceKeysAvailable, SourceUnavailableError } from "@/lib/trust/source-retention";
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  NO_BILLABLE_SHOTS_MESSAGE,
  ProvisioningError,
  RESTARTING_MESSAGE,
  overMaxCreditsRejection,
} from "./errors";
import { buildShotViews } from "./job-shots";
import {
  LIBRARY_PAGE_SIZE,
  filterGallery,
  galleryFacets,
  galleryItemsOf,
  type GalleryFilters,
} from "@/lib/library";
import { reusePrefillOf, type ReusePrefill } from "@/lib/reuse";
import { overLimitSpec, shotVersionsOf, VERSION_COPY } from "@/lib/variation-picks";
import { readOutputDefaults, saveOutputDefaults } from "./output-defaults";
import {
  hasPhotoBackgroundOverride,
  INVALID_OPTIONS_MESSAGE,
  isNonDefaultOutput,
  outputEstimateInputs,
  parseStoredOutputOptions,
  photoBackgroundsOf,
  readStoredOutputOptions,
  resolveJobOutput,
  type OutputPhoto,
} from "./output-options";
import { looksStale, reconcileStaleJobs } from "./reconcile";
import { AMAZON_NOT_CONNECTED, SHOPIFY_NOT_CONNECTED } from "@/lib/integration-copy";
import {
  angleLabel,
  angleOfSkippedShot,
  cancelNotice,
  followUpCredits,
  planAngleShots,
  RERUN_STEP_STATUS,
  retryShotFor,
  storedShot,
  isRetryable,
  withAddedPhoto,
} from "./shot-ops";
import type {
  AddShotPhotoInput,
  BrandKitView,
  CancelJobResult,
  CreateJobInput,
  CreateJobLifecycle,
  CreateJobRejection,
  CreateJobResult,
  CreateProductInput,
  EstimateJobInput,
  EstimateJobResult,
  IntegrationView,
  JobFileDownload,
  JobFileDownloadOptions,
  JobFilesView,
  JobFileView,
  JobStatus,
  JobSummary,
  JobView,
  MemberView,
  PreflightUploadInput,
  ProductLibraryEntry,
  ProductSummary,
  RegisterSourceMediaInput,
  SaveResult,
  Services,
  ServiceReadOptions,
  ShotOpResult,
  VersionPickResult,
  FavoriteResult,
  LibraryView,
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
  /** Server side ingest of an uploaded object (lib/trust/ingest.ts). Left
   * out, it reads R2 whenever R2 is configured; null skips the check. */
  ingestUpload?: ((key: string, kind: "image" | "video") => Promise<IngestOutcome>) | null;
  /** Overrides for the preflight at upload (tests): the runner side run,
   * thumbnail storage and signing. Left out, the worker runtime and R2 run. */
  preflight?: Partial<Omit<PreflightServiceDeps, "db">>;
  /** Overrides the output options gate (tests). Left out, the env flag and
   * the platform_settings kill switch decide. */
  outputOptionsEnabled?: () => Promise<boolean>;
  /** Overrides the provider pause verdict createJob checks (tests). Left
   * out, lib/provider-preflight decides. */
  providerVerdict?: () => Promise<PreflightVerdict>;
  /** Overrides the logo palette reader (tests). Left out, the worker
   * runtime reads the logo (lib/brand/palette.ts). */
  brandPalette?: BrandPaletteRunner;
  /** Overrides the upload cutout cache check (tests): true when a fresh
   * cached cutout of this stored photo exists. Left out, R2 is read. */
  cutoutCached?: (workspaceId: string, r2Key: string) => Promise<boolean>;
  /** In-lock object existence check, injectable for memory-only regressions. */
  sourceObjectExists?: (key: string) => Promise<boolean>;
}

/** The shots of a follow up that need a cutout: all but the seller's kept
 * photo, which the runner copies without one. */
export function followUpCutoutSources(shots: readonly Pick<Shot, "type" | "method" | "sourceMediaId">[]): string[] {
  const out: string[] = [];
  for (const shot of shots) {
    if (shot.type === "original_photo" && shot.method === "deterministic") continue;
    if (!out.includes(shot.sourceMediaId)) out.push(shot.sourceMediaId);
  }
  return out;
}

/** A source_media.ingest record read back, or null when it is missing or
 * not one (rows before PHASE_15 read as unknown). */
export function ingestRecordOf(raw: unknown): SourceMediaIngest | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return record.v === 1 && typeof record.reencoded === "boolean" && typeof record.sourceFormat === "string"
    ? { v: 1, reencoded: record.reencoded, sourceFormat: record.sourceFormat as IngestImageFormat }
    : null;
}

/**
 * Two ingest records of one upload, oldest first. The first check that
 * decoded and wrote the photo again is the one that knows: a later check
 * reads the upright copy it wrote and reports nothing changed, and the
 * upload's real format is gone with it.
 */
export function mergeIngestRecords(
  earlier: SourceMediaIngest | null | undefined,
  later: SourceMediaIngest | null | undefined,
): SourceMediaIngest | null {
  if (earlier?.reencoded) {
    return earlier;
  }
  return later ?? earlier ?? null;
}

/** The source_media.ingest column value: the record, or SQL NULL (the
 * column's check refuses a JSON null). */
function ingestColumnOf(record: SourceMediaIngest | null | undefined): Record<string, unknown> | null {
  return record ? { ...record } : null;
}

/** True when a request's options ask for anything but today's pack. Options
 * the schema refuses count as asking, so they reach resolveJobOutput and get
 * invalid_options there. */
function isNonDefaultRequest(options: CreateJobInput["outputOptions"]): boolean {
  try {
    return isNonDefaultOutput(options ?? null);
  } catch {
    return true;
  }
}

/** The ingest record the preflight at upload kept for a photo, if any. */
function preflightIngestOf(row: UploadPreflight | undefined): SourceMediaIngest | null {
  return ingestRecordOf((row?.result as { ingest?: unknown } | undefined)?.ingest);
}

/** Most photos a pack sends to the worker (MAX_PACK_PHOTOS). */
const MAX_PACK_MEDIA = MAX_PACK_PHOTOS;

/** Most products the library lists, newest first. */
const MAX_LIBRARY_PRODUCTS = serviceListLimits.products;

type ProductRow = typeof products.$inferSelect;

/** True when a planned original_photo (a kept photo) is headed for a spec
 * that refuses added text, borders or watermarks (refusesOverlays: eBay,
 * Google), so whether the photo carries any matters. */
function shotsReachOverlayRefusingSpecs(shots: readonly Shot[]): boolean {
  return shots.some(
    (shot) =>
      shot.type === "original_photo" &&
      shot.channels.some((specId) => hasSpec(specId) && refusesOverlays(getSpec(specId))),
  );
}

/** A follow up's worker payload: the runner's PackFollowUpInput, which
 * carries the job's stored output options and re-encoded photos. */
export type FollowUpPayload = PackFollowUpInput;

/** The view of a product row, seller inputs included. */
function productSummaryOf(row: ProductRow): ProductSummary {
  return {
    id: row.id,
    title: row.title ?? "Untitled product",
    mode: row.mode,
    category: typeof row.profile?.category === "string" ? row.profile.category : "other",
    createdAt: row.createdAt.toISOString(),
    sku: row.sku ?? null,
    boxContents: printableSellerLines(row.boxContents),
    comparisonFacts: printableSellerLines(row.comparisonFacts),
    endorsements: printableEndorsements(row.endorsements),
  };
}

/**
 * The product columns a pack request changes: only the seller inputs the
 * request carries. An empty SKU clears it; an empty list clears the list.
 */
function sellerInputUpdates(
  input: Pick<CreateJobInput, "sku" | "boxContents" | "comparisonFacts" | "endorsements">,
): Partial<Pick<ProductRow, "sku" | "boxContents" | "comparisonFacts" | "endorsements">> {
  return {
    ...(input.endorsements !== undefined ? { endorsements: printableEndorsements(input.endorsements) } : {}),
    ...(input.sku !== undefined ? { sku: input.sku.trim() || null } : {}),
    ...(input.boxContents !== undefined ? { boxContents: printableSellerLines(input.boxContents) } : {}),
    ...(input.comparisonFacts !== undefined ? { comparisonFacts: printableSellerLines(input.comparisonFacts) } : {}),
  };
}

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

export interface PackMedia {
  r2Key: string;
  kind: "image" | "video" | "frame" | null;
  angle: AngleRole | null;
  /** The product the seller tapped in the chooser (source_media.target_box). */
  targetBox?: SourceMediaTargetBox | null;
  /** Stored upright size and the upload's re-encode flag, when known. */
  width?: number | null;
  height?: number | null;
  reencoded?: boolean | null;
}

/** What the hold reads from a pack request (createJob's or estimateJob's). */
type HoldRequest = Pick<
  CreateJobInput,
  "channels" | "mode" | "outputOptions" | "sku" | "boxContents" | "comparisonFacts" | "endorsements"
> & { uploads?: ReadonlyArray<{ key: string; background?: CreateJobUpload["background"] }> };

type CreateJobUpload = NonNullable<CreateJobInput["uploads"]>[number];

/** The hold for a request and what createJob writes from it. */
interface PackHold {
  sellerUpdates: ReturnType<typeof sellerInputUpdates>;
  brandColors: string[];
  brandKit: PayloadBrandKit | null;
  output: Extract<ReturnType<typeof resolveJobOutput>, { ok: true }>;
  /** The estimate inputs the hold was priced from. */
  estimateInputs: EstimateSellerInputs;
  creditsReserved: number;
}

/** The photos a pack runs on: this request's uploads when it sent any,
 * otherwise the product's stored photos, one entry per object, capped at
 * MAX_PACK_MEDIA. Stored photos are never mixed into a pack that sent new
 * ones: earlier uploads include whatever a failed attempt carried (a wrong
 * photo, a screenshot), and the seller picked this pack's photos on purpose. */
export function mergePackMedia(uploads: PackMedia[], stored: PackMedia[]): PackMedia[] {
  const seen = new Set<string>();
  const merged: PackMedia[] = [];
  for (const item of uploads.length > 0 ? uploads : stored) {
    if (seen.has(item.r2Key)) {
      continue;
    }
    seen.add(item.r2Key);
    merged.push(item);
  }
  return merged.slice(0, MAX_PACK_MEDIA);
}

/** Thrown inside a follow up transaction when the job is not a delivered,
 * finished pack any more (another follow up or a cancel got there first). */
class FollowUpNotReadyError extends Error {
  constructor() {
    super("the pack is not finished");
    this.name = "FollowUpNotReadyError";
  }
}

/** Thrown inside an added photo transaction when the upload is already
 * saved to another product. */
class MediaConflictError extends Error {
  constructor() {
    super("the photo belongs to another product");
    this.name = "MediaConflictError";
  }
}

const NOT_FOUND_MESSAGE = "This pack does not exist in your workspace.";
const CLIENT_SEAT_MESSAGE = "Client seats can review packs but cannot run shots or cancel packs.";
const NOT_READY_MESSAGE = "This pack is still running. Wait for it to finish, then try again.";

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
/** Most delivered assets one library read scans before its filters. */
const LIBRARY_SCAN_LIMIT = serviceListLimits.assetScan;

const ASSET_NOT_FOUND = "This image does not exist in your workspace.";

export function servesFiles(job: { status: string; creditsCharged: number | null }): boolean {
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
      orderBy: (t, { asc }) => [sql`case when ${t.role} = 'owner' then 0 else 1 end`, asc(t.createdAt), asc(t.workspaceId)],
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

  async getSellerProfile(workspaceId: string): Promise<SellerProfile | null> {
    const row = await this.db.query.workspaces.findFirst({
      columns: { sellerProfile: true },
      where: (t, { eq }) => eq(t.id, workspaceId),
    });
    return readSellerProfile(row?.sellerProfile ?? null);
  }

  /** Saves the first run answers on the owner connection (the column is
   * protected from client connections, migration seller_profile) and
   * records segment_answered for the funnel. */
  async saveSellerProfile(workspaceId: string, answer: SellerAnswer): Promise<SaveResult> {
    const userId = await this.deps.getUserId();
    if (!userId) {
      return { ok: false, notice: "Sign in to save your answers.", reason: "forbidden" };
    }
    const membership = await this.db.query.members.findFirst({
      where: (t) => and(eq(t.userId, userId), eq(t.workspaceId, workspaceId)),
    });
    if (!membership || !["owner", "admin", "editor"].includes(membership.role)) {
      return { ok: false, notice: "Only owners, admins and editors can answer for the workspace.", reason: "forbidden" };
    }
    await this.db
      .update(workspaces)
      .set({ sellerProfile: sellerProfileJson(answer, new Date()), updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
    if (answerSaysSomething(answer)) {
      await recordFunnelEvent(this.db, {
        workspaceId,
        name: "segment_answered",
        props: {
          category: answer.category,
          channels: answer.channels.join(","),
          channel_count: answer.channels.length,
        },
      });
    }
    return { ok: true, notice: "Saved. Your first pack starts with these channels." };
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

  /** Reads an upload back and checks it server side (magic bytes, size and
   * pixel caps, video length) and strips photo metadata. Null when the
   * check is skipped: no R2 means no uploads exist to check. */
  private async ingest(key: string, kind: "image" | "video"): Promise<IngestOutcome | null> {
    if (this.deps.ingestUpload !== undefined) {
      return this.deps.ingestUpload ? this.deps.ingestUpload(key, kind) : null;
    }
    return isR2Configured() ? ingestUpload(r2TrustStorage(), key, kind) : null;
  }

  private async assertSourceObjects(keys: readonly string[]): Promise<void> {
    const distinct = [...new Set(keys)];
    if (distinct.length === 0) return;
    const exists = this.deps.sourceObjectExists ?? (isR2Configured()
      ? async (key: string) => (await r2TrustStorage().head(key)) !== null
      : null);
    if (exists && (await Promise.all(distinct.map(exists))).some((found) => !found)) throw new SourceUnavailableError();
  }

  private async creditBalance(workspaceId: string, options: ServiceReadOptions = {}): Promise<number> {
    // Settle orphaned runs first, so a hold left by a crashed run never makes
    // the balance look lower than it is (Update.md 3.2).
    if (options.reconcile !== false) {
      await reconcileStaleJobs(this.db, { workspaceId });
    }
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
    if (rows.length === 0) {
      return [];
    }
    // The photos a pack of each product would run on when it sends no new
    // uploads (mergePackMedia): stored images in this workspace's source
    // prefix, capped at the pack limit, so the form's Keep estimate counts
    // the real photos.
    const media = await this.db.query.sourceMedia.findMany({
      columns: { productId: true, r2Key: true, kind: true },
      where: (t, { and, eq, inArray, like }) =>
        and(
          eq(t.workspaceId, workspaceId),
          inArray(
            t.productId,
            rows.map((row) => row.id),
          ),
          like(t.r2Key, `ws/${workspaceId}/src/%`),
        ),
    });
    const photoCounts = new Map<string, number>();
    for (const m of media) {
      if (m.kind === "image" && isWorkspaceSourceKey(workspaceId, m.r2Key)) {
        photoCounts.set(m.productId, (photoCounts.get(m.productId) ?? 0) + 1);
      }
    }
    return rows.map((row) => ({
      ...productSummaryOf(row),
      storedPhotoCount: Math.min(photoCounts.get(row.id) ?? 0, MAX_PACK_MEDIA),
      outputDefaults: readOutputDefaults(row.outputDefaults),
    }));
  }

  /**
   * The products library: each product with its photo count and its packs,
   * newest first. Stale runs are settled first, so a pack orphaned by a
   * restart shows as failed with its hold returned, not as running forever.
   * Credits show what each pack charged, or what it holds while it runs.
   */
  async listProductLibrary(workspaceId: string): Promise<ProductLibraryEntry[]> {
    await reconcileStaleJobs(this.db, { workspaceId });
    const rows = await this.db.query.products.findMany({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: MAX_LIBRARY_PRODUCTS,
    });
    if (rows.length === 0) {
      return [];
    }
    const productIds = rows.map((row) => row.id);
    const [jobs, media] = await Promise.all([
      this.db.query.generationJobs.findMany({
        columns: {
          id: true,
          productId: true,
          status: true,
          channels: true,
          creditsReserved: true,
          creditsCharged: true,
          createdAt: true,
        },
        where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.productId, productIds)),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      }),
      this.db.query.sourceMedia.findMany({
        columns: { productId: true },
        where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.productId, productIds)),
      }),
    ]);
    const photoCounts = new Map<string, number>();
    for (const m of media) {
      photoCounts.set(m.productId, (photoCounts.get(m.productId) ?? 0) + 1);
    }
    const packsByProduct = new Map<string, ProductLibraryEntry["packs"]>();
    for (const job of jobs) {
      const packs = packsByProduct.get(job.productId) ?? [];
      packs.push({
        id: job.id,
        status: job.status as JobStatus,
        channels: job.channels ?? [],
        createdAt: job.createdAt.toISOString(),
        creditsReserved: Number(job.creditsReserved),
        creditsCharged: Number(job.creditsCharged),
      });
      packsByProduct.set(job.productId, packs);
    }
    return rows.map((row) => ({
      ...productSummaryOf(row),
      photoCount: photoCounts.get(row.id) ?? 0,
      packs: packsByProduct.get(row.id) ?? [],
    }));
  }

  async getProduct(workspaceId: string, productId: string): Promise<ProductSummary | null> {
    const row = await this.db.query.products.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, productId), eq(t.workspaceId, workspaceId)),
    });
    if (!row) {
      return null;
    }
    return productSummaryOf(row);
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
      creditsCharged: Number(job.creditsCharged ?? 0),
      createdAt: job.createdAt.toISOString(),
    }));
  }

  async getJob(workspaceId: string, jobId: string, options: ServiceReadOptions = {}): Promise<JobView | null> {
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
    if (options.reconcile !== false && looksStale(job)) {
      await reconcileStaleJobs(this.db, { workspaceId, jobId: job.id });
      job = (await findJob()) ?? job;
    }
    const current = job;
    const [product, steps, assetRows, role, report] = await Promise.all([
      this.db.query.products.findFirst({ where: (t, { eq }) => eq(t.id, current.productId) }),
      this.db.query.jobSteps.findMany({
        where: (t, { eq }) => eq(t.jobId, current.id),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      }),
      // Oldest first: a shot that ran again is shown from its newest asset.
      this.db.query.assets.findMany({
        where: (t, { eq }) => eq(t.jobId, current.id),
        orderBy: (t, { asc }) => [asc(t.createdAt)],
      }),
      this.currentRole(workspaceId),
      this.db.query.packFiles.findFirst({
        columns: { id: true },
        where: (t, { and, eq }) => and(eq(t.jobId, current.id), eq(t.kind, "report")),
      }),
    ]);
    const mode = current.mode ?? product?.mode ?? "listing";

    const storedOutput = readStoredOutputOptions(current.outputOptions);
    const shots = buildShotViews(steps, assetRows, {
      status: current.status as JobStatus,
      mode,
      copy: shotCopyContextOf(storedOutput),
    });

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
      // Favorites and scene versions (PHASE_16 workstream 6).
      const favoriteIds = await this.favoriteAssetIds(
        workspaceId,
        variantRows.map((v) => v.assetId),
      );
      const versions = shotVersionsOf(
        shots.map((shot) => shot.shotId),
        (shotId) => {
          const files = variantsByShot.get(shotId);
          return files && files.length > 0 ? files.some((v) => v.picked) : undefined;
        },
      );
      const canSign = isR2Configured();
      await Promise.all(
        shots.map(async (shot) => {
          const variants = variantsByShot.get(shot.shotId);
          if (!variants || variants.length === 0) {
            return;
          }
          shot.channels = [...new Set(variants.map((v) => v.channelSpecId))];
          shot.assetId = variants[0].assetId;
          shot.favorite = favoriteIds.has(variants[0].assetId);
          shot.width = variants[0].width;
          shot.height = variants[0].height;
          const version = versions.get(shot.shotId);
          if (version) {
            shot.version = version;
          }
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
    if (current.status === "done" && role !== null && role !== "client") {
      const sourceKeys = new Set((await this.db.query.sourceMedia.findMany({
        where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.productId, current.productId)),
      })).map((m) => m.r2Key));
      const cached = new Map<string, boolean>();
      for (const shot of shots) {
        if (!shot.assetId || shot.status !== "done") continue;
        const asset = assetRows.filter((a) => a.qc?.shotId === shot.shotId).at(-1);
        const planned = storedShot(asset?.qc ?? null);
        if (!asset?.approved || !planned || planned.method !== "composite_generate" || planned.type !== "lifestyle" || planned.carouselId || planned.channels.some((id) => id.endsWith(".main")) || !sourceKeys.has(planned.sourceMediaId)) continue;
        const baseId = parseVariationShotId(shot.shotId)?.baseShotId ?? shot.shotId;
        const maxVersion = Math.max(1, ...shots.map((s) => { const v = parseVariationShotId(s.shotId); return v?.baseShotId === baseId ? v.variation : 1; }));
        if (maxVersion >= variationOptions.max) continue;
        if (!cached.has(planned.sourceMediaId)) cached.set(planned.sourceMediaId, await this.cutoutCached(workspaceId, planned.sourceMediaId));
        shot.regenerate = { credits: (maxVersion <= followUpPricing.regenerateFreePerShot ? 0 : creditCosts.generativeStill) + (cached.get(planned.sourceMediaId) ? 0 : creditCosts.deterministic) };
      }
    }

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
      mode,
      channels: current.channels ?? [],
      creditsReserved: current.creditsReserved,
      creditsCharged: current.creditsCharged,
      createdAt: current.createdAt.toISOString(),
      shots,
      ...(current.status === "queued" ? { queue: await queueView(this.db, current.id) } : {}),
      // Raw worker errors can name providers; the board gets plain copy and
      // the detail stays in the row and the logs.
      error: current.status === "failed" ? publicJobError(current.error) : null,
      sourceImageUrl,
      canManage: role !== null && role !== "client",
      followUpRunning: Boolean(report) && !["done", "failed", "canceled"].includes(current.status),
      inventory: inventoryView(current.inventory),
      ...this.outputOptionsView(current, storedOutput, assetRows),
      // A deploy stopped it mid run and it started again (P18-23).
      ...((current.restartCount ?? 0) > 0 ? { restarted: true } : {}),
    };
  }

  /** The "Your choices" card for a job row. A row with no options reads as
   * today's pack; one the schema refuses shows no card and is logged. The
   * pack's photos are the source photos its shots used plus the kept ones;
   * before any shot is saved the count is unknown and the pack's switch
   * decides whether "Background removed" shows. */
  private outputOptionsView(
    job: typeof generationJobs.$inferSelect,
    stored: ResolvedOutputOptions | null | undefined,
    assetRows: readonly { qc: Record<string, unknown> | null }[],
  ): Pick<JobView, "outputOptions"> {
    if (stored === undefined) {
      console.warn(`[jobs] job ${job.id} has output options that could not be read`);
      return {};
    }
    const sources = assetRows
      .map((a) => storedShot(a.qc)?.sourceMediaId)
      .filter((key): key is string => typeof key === "string" && key.length > 0);
    const photos = new Set([...sources, ...(stored?.keepMediaIds ?? [])]);
    return {
      outputOptions: outputOptionsSummary(stored, {
        specIds: job.channels ?? [],
        ...(sources.length > 0 ? { photoCount: photos.size } : {}),
      }),
    };
  }

  /**
   * An upload's source_media.ingest record: the one the preflight at upload
   * kept when it re-encoded the photo, else this check's own. Best effort: a
   * failed lookup keeps this check's record.
   */
  private async uploadIngestRecord(
    workspaceId: string,
    key: string,
    current: SourceMediaIngest | null | undefined,
  ): Promise<SourceMediaIngest | null> {
    try {
      const rows = await preflightRowsFor(this.db, workspaceId, [key]);
      return mergeIngestRecords(preflightIngestOf(rows.get(key)), current);
    } catch {
      return current ?? null;
    }
  }

  /**
   * Keeps a re-encoded upload's ingest record on its preflight row, where
   * createJob and registerSourceMedia find it: the preflight is often the
   * first check, and every later check reads the upright copy it wrote. Only
   * a re-encode needs keeping. Best effort.
   */
  private async keepPreflightIngest(workspaceId: string, key: string, record: SourceMediaIngest | null): Promise<void> {
    if (!record?.reencoded) {
      return;
    }
    try {
      await this.db
        .update(uploadPreflights)
        .set({ result: sql`${uploadPreflights.result} || ${JSON.stringify({ ingest: record })}::jsonb` })
        .where(and(eq(uploadPreflights.workspaceId, workspaceId), eq(uploadPreflights.r2Key, key)));
    } catch (err) {
      console.warn(`[preflight] could not keep the ingest record of an upload in workspace ${workspaceId}`, err);
    }
  }

  /** The provider pause verdict and its cause (lib/provider-preflight),
   * never throwing. */
  private async providerPause(): Promise<PreflightDetail> {
    if (this.deps.providerVerdict) {
      const verdict = await this.deps.providerVerdict();
      return { verdict, cause: verdict === "ok" ? null : "failures" };
    }
    return providerPreflightDetail();
  }

  /**
   * The refusal for work whose cutouts come from these photos while every
   * cutout provider is paused, or null when it may start. A photo with a
   * fresh cutout in the upload cache needs no provider (the runner reads
   * that cache before the router), so work made only of such photos still
   * runs. Never throws.
   */
  private async cutoutPauseRefusal(workspaceId: string, sources: readonly string[]): Promise<string | null> {
    if (sources.length === 0) {
      return null;
    }
    const pause = await this.providerPause();
    if (pause.verdict !== "packs_paused") {
      return null;
    }
    const cached = await Promise.all(sources.map((key) => this.cutoutCached(workspaceId, key)));
    return cached.every(Boolean) ? null : packsPausedCopy(pause.cause);
  }

  private async cutoutCached(workspaceId: string, key: string): Promise<boolean> {
    try {
      if (this.deps.cutoutCached) {
        return await this.deps.cutoutCached(workspaceId, key);
      }
      if (!isR2Configured() || !isWorkspaceSourceKey(workspaceId, key)) {
        return false;
      }
      const bytes = await getObjectBytes(key);
      if (!bytes) {
        return false;
      }
      const { hasFreshUploadCutout } = await import("@curvi/trigger/live-runtime");
      return await hasFreshUploadCutout(workspaceId, bytes);
    } catch (err) {
      console.warn(`[jobs] could not read the cutout cache for a photo in workspace ${workspaceId}`, err);
      return false;
    }
  }

  /** See Services.outputOptionsEnabled. */
  async outputOptionsEnabled(): Promise<boolean> {
    if (this.deps.outputOptionsEnabled) {
      return this.deps.outputOptionsEnabled();
    }
    if (!outputOptionsAvailable()) {
      return false;
    }
    // The operator switch (P20-20): its stored value, or the seed default
    // when no row is stored, and off when the read fails.
    return opsSwitch("ops:output_options_enabled", platformSettingReader(this.db));
  }

  /** The job's stored options for a follow up, or a refusal when they
   * cannot be read (the follow up would run as a different pack). */
  private followUpOutput(
    job: typeof generationJobs.$inferSelect,
  ): { output: ResolvedOutputOptions | null } | { rejected: ShotOpResult } {
    try {
      return { output: parseStoredOutputOptions(job.outputOptions) };
    } catch (err) {
      console.error(`[jobs] job ${job.id} has output options that could not be read`, err);
      return { rejected: { outcome: "rejected", reason: "unavailable", message: OPTIONS_UNREADABLE_COPY } };
    }
  }

  /**
   * Cancels a running pack. Owner, admin and editor only; a client seat is
   * refused like it is for starting a pack (plan 4.3). The settle runs in one
   * transaction under the workspace row lock (settleJob): a pack whose files
   * were not delivered is marked canceled, a pack whose files were delivered
   * (its first run just finished, or shots running again on it) is marked
   * done with its delivered files charged, and release_credits returns every
   * credit still held, which is exactly the hold of the shots not delivered.
   * The runner stops at its next checkpoint: every heartbeat and state write
   * finds the job terminal.
   */
  async cancelJob(workspaceId: string, jobId: string): Promise<CancelJobResult> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return { outcome: "rejected", reason: "role_forbidden", message: CLIENT_SEAT_MESSAGE };
    }
    const job = isUuid(jobId)
      ? await this.db.query.generationJobs.findFirst({
          where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
        })
      : undefined;
    if (!job) {
      return { outcome: "rejected", reason: "not_found", message: NOT_FOUND_MESSAGE };
    }
    let settled: Awaited<ReturnType<typeof settleJob>>;
    try {
      settled = await settleJob(this.db, { jobId, workspaceId }, { undelivered: "canceled", error: null });
    } catch (err) {
      console.error(`[jobs] could not cancel job ${jobId} in workspace ${workspaceId}`, err);
      return { outcome: "rejected", reason: "unavailable", message: "We could not cancel this pack right now. Try again in a minute." };
    }
    const view = await this.getJob(workspaceId, jobId);
    if (!view) {
      return { outcome: "rejected", reason: "not_found", message: NOT_FOUND_MESSAGE };
    }
    if (settled.status === null) {
      return { outcome: "finished", job: view, notice: cancelNotice("finished", 0) };
    }
    const outcome = settled.status === "canceled" ? "canceled" : "stopped";
    console.info(`[jobs] job ${jobId} ${outcome} by the seller; ${settled.releasedCredits} credits returned`);
    return {
      outcome,
      job: view,
      refundedCredits: settled.releasedCredits,
      notice: cancelNotice(outcome, settled.releasedCredits),
    };
  }

  /**
   * Runs one shot that needs review again, exactly as it was planned, on a
   * pack that was delivered. Its credits are held by the pack rules (the
   * shot's seed price, reserved against the same job) and charged only when
   * its file is delivered; a shot that needs review again, or that cannot
   * run, gets them back.
   */
  async retryShot(workspaceId: string, jobId: string, shotId: string): Promise<ShotOpResult> {
    const start = await this.followUpStart(workspaceId, jobId);
    if ("rejected" in start) {
      return start.rejected;
    }
    const { job } = start;
    const stored = this.followUpOutput(job);
    if ("rejected" in stored) {
      return stored.rejected;
    }
    const assetRows = await this.db.query.assets.findMany({
      where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspaceId)),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    const latest = assetRows.filter((a) => a.qc?.shotId === shotId).at(-1);
    if (!latest || latest.approved) {
      return { outcome: "rejected", reason: "not_retryable", message: "This shot is not waiting for review." };
    }
    const planned = storedShot(latest.qc);
    if (!planned || !isRetryable(latest.qc) || !isWorkspaceSourceKey(workspaceId, planned.sourceMediaId)) {
      return {
        outcome: "rejected",
        reason: "not_retryable",
        message: "This shot cannot run again. Start a new pack for this product to try it.",
      };
    }
    if (planned.type === "carousel_slide" || planned.carouselId) return {
      outcome: "rejected", reason: "not_retryable", message: "Run the whole carousel again to keep its slides consistent.",
    };
    const shot = retryShotFor(planned, await this.filesBySpec(workspaceId, job.id));
    if (!shot) {
      return {
        outcome: "rejected",
        reason: "channel_full",
        message: "The channels this shot is for already have as many images as they allow.",
      };
    }
    return this.startFollowUp(workspaceId, job, "retry", [shot], shot.type, stored.output);
  }

  /** A new unpicked version of a delivered composite scene, using the
   * original source and the same generation and fidelity checks. */
  async regenerateShot(workspaceId: string, jobId: string, shotId: string): Promise<ShotOpResult> {
    const start = await this.followUpStart(workspaceId, jobId);
    if ("rejected" in start) return start.rejected;
    const stored = this.followUpOutput(start.job);
    if ("rejected" in stored) return stored.rejected;
    const rows = await this.db.query.assets.findMany({
      where: (t, { and, eq }) => and(eq(t.jobId, jobId), eq(t.workspaceId, workspaceId)),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    const latest = rows.filter((a) => a.qc?.shotId === shotId).at(-1);
    const planned = storedShot(latest?.qc ?? null);
    if (!latest?.approved || !planned || planned.method !== "composite_generate" || planned.type !== "lifestyle" || planned.carouselId || planned.channels.some((id) => id.endsWith(".main"))) {
      return { outcome: "rejected", reason: "not_retryable", message: "Only a delivered scene can have another version." };
    }
    const delivered = await this.db.query.assetVariants.findFirst({
      where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.assetId, latest.id)),
    });
    if (!delivered) return { outcome: "rejected", reason: "not_retryable", message: "This scene has no delivered file." };
    const source = await this.db.query.sourceMedia.findFirst({
      where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.productId, start.job.productId), eq(t.r2Key, planned.sourceMediaId)),
    });
    if (!source || !isWorkspaceSourceKey(workspaceId, planned.sourceMediaId)) return {
      outcome: "rejected", reason: "not_retryable", message: `The original photo for this pack was deleted after ${SOURCE_RETENTION_DAYS} days, so we cannot make another version from it. Start a new pack with the photo to make more.`,
    };
    const baseId = parseVariationShotId(shotId)?.baseShotId ?? shotId;
    const versions = rows.flatMap((a) => {
      const id = typeof a.qc?.shotId === "string" ? a.qc.shotId : "";
      const parsed = parseVariationShotId(id);
      return id === baseId ? [1] : parsed?.baseShotId === baseId ? [parsed.variation] : [];
    });
    const next = Math.max(1, ...versions) + 1;
    if (next > variationOptions.max) return { outcome: "rejected", reason: "not_retryable", message: `This scene already has ${variationOptions.max} versions. Pick the one you want to ship.` };
    const cached = await this.cutoutCached(workspaceId, planned.sourceMediaId);
    const { variations: _variations, ...original } = planned;
    void _variations;
    const shot: Shot = { ...original, id: variationShotId(baseId, next), variation: next,
      credits: (next - 1 <= followUpPricing.regenerateFreePerShot ? 0 : creditCosts.generativeStill) + (cached ? 0 : creditCosts.deterministic),
    };
    return this.startFollowUp(workspaceId, start.job, "regenerate", [shot], shot.type, stored.output);
  }

  /**
   * Adds the photo a skipped "needs photo" shot waits for: the photo is
   * saved to the pack's product, the deterministic planner plans the shots
   * that photo unlocks for the pack's channels, and they run on the pack
   * like a retry, held and charged by the same rules.
   */
  async addShotPhoto(
    workspaceId: string,
    jobId: string,
    shotId: string,
    input: AddShotPhotoInput,
  ): Promise<ShotOpResult> {
    const start = await this.followUpStart(workspaceId, jobId);
    if ("rejected" in start) {
      return start.rejected;
    }
    const { job } = start;
    const stored = this.followUpOutput(job);
    if ("rejected" in stored) {
      return stored.rejected;
    }
    if (!isWorkspaceSourceKey(workspaceId, input.key)) {
      return { outcome: "rejected", reason: "foreign_key", message: "That upload does not belong to this workspace." };
    }
    // The added photo gets the same server side check as any upload (magic
    // bytes, the 80 megapixel cap, metadata stripped) before it is recorded,
    // and the server's hash and upright size replace what the client sent.
    const checked = await this.ingest(input.key, "image");
    if (checked && !checked.ok) {
      return {
        outcome: "rejected",
        reason: checked.retryable ? "unavailable" : "invalid_upload",
        message: checked.notice,
      };
    }
    const steps = await this.db.query.jobSteps.findMany({
      where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspaceId), eq(t.shotId, shotId)),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
    });
    const latest = steps.at(-1);
    const angle = latest?.status === "skipped" ? angleOfSkippedShot(latest.stage, latest.error) : null;
    if (!latest || !angle) {
      return { outcome: "rejected", reason: "not_retryable", message: "This shot is not waiting for a photo." };
    }
    const workspace = await this.db.query.workspaces.findFirst({ where: (t, { eq }) => eq(t.id, workspaceId) });
    const width = checked?.ok ? checked.width : null;
    const height = checked?.ok ? checked.height : null;
    // The pack's stored options decide what the photo becomes: a kept photo
    // on a Keep pack, a cut out photo on the stored color otherwise. The
    // follow up keeps the added photo too, since keepMediaIds is what the
    // runner reads.
    const output = stored.output ? withAddedPhoto(stored.output, input.key) : null;
    const existingFilesBySpec = await this.filesBySpec(workspaceId, job.id);
    const planFor = (addedOverlays: boolean): Shot[] =>
      planAngleShots({
        angle,
        mediaKey: input.key,
        shotId,
        channels: job.channels ?? [],
        tier: tierKeyOf(workspace?.plan),
        existingFilesBySpec,
        output,
        photoSize: width && height ? { width, height } : null,
        addedOverlays,
      });
    let shots = planFor(false);
    // A kept photo headed for a channel that refuses added text, borders or
    // watermarks (eBay, Google) is checked first, as a first run checks it at
    // intake: when the preflight saw any, the photo is planned again and
    // left off those channels (PHASE_15 P1 added text).
    if (shotsReachOverlayRefusingSpecs(shots) && (await this.addedPhotoOverlays(workspaceId, input.key))) {
      shots = planFor(true);
    }
    if (shots.length === 0) {
      return {
        outcome: "rejected",
        reason: "channel_full",
        message: `No channel in this pack has room for a ${angleLabel(angle)} photo.`,
      };
    }
    const ingestRecord = checked?.ok ? (checked.ingest ?? null) : null;
    return this.startFollowUp(workspaceId, job, "add_angle", shots, latest.stage ?? shots[0].type, output, async (tx) => {
      const inserted = await tx
        .insert(sourceMedia)
        .values({
          workspaceId,
          productId: job.productId,
          r2Key: input.key,
          kind: "image",
          sha256: (checked?.ok ? checked.sha256 : null) ?? input.sha256,
          width,
          height,
          ingest: ingestColumnOf(ingestRecord),
        })
        .onConflictDoNothing({ target: [sourceMedia.workspaceId, sourceMedia.r2Key] })
        .returning({ id: sourceMedia.id });
      if (inserted.length === 0) {
        const existing = await tx.query.sourceMedia.findFirst({
          where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.r2Key, input.key)),
        });
        if (existing && existing.productId !== job.productId) {
          throw new MediaConflictError();
        }
      }
    });
  }

  /** The checks every pack operation starts with: a member who may spend
   * credits, a job in this workspace, and a delivered Listing Mode pack. */
  private async followUpStart(
    workspaceId: string,
    jobId: string,
  ): Promise<{ job: typeof generationJobs.$inferSelect } | { rejected: ShotOpResult }> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return { rejected: { outcome: "rejected", reason: "role_forbidden", message: CLIENT_SEAT_MESSAGE } };
    }
    const job = isUuid(jobId)
      ? await this.db.query.generationJobs.findFirst({
          where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
        })
      : undefined;
    if (!job) {
      return { rejected: { outcome: "rejected", reason: "not_found", message: NOT_FOUND_MESSAGE } };
    }
    if (job.status !== "done") {
      return { rejected: { outcome: "rejected", reason: "not_ready", message: NOT_READY_MESSAGE } };
    }
    if ((job.mode ?? "listing") !== "listing") {
      return {
        rejected: { outcome: "rejected", reason: "not_retryable", message: "Only Listing Mode packs can run shots again." },
      };
    }
    return { job };
  }

  /** Files each channel spec already holds in the job's delivered pack. */
  private async filesBySpec(workspaceId: string, jobId: string): Promise<Record<string, number>> {
    const rows = (await this.db.execute(sql`
      select v.channel_spec_id as spec_id, count(*)::int as files
      from asset_variants v join assets a on a.id = v.asset_id
      where a.job_id = ${jobId}::uuid and v.workspace_id = ${workspaceId}::uuid
      group by v.channel_spec_id
    `)) as unknown;
    const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as Array<{
      spec_id: string;
      files: number | string;
    }>;
    return Object.fromEntries(list.map((r) => [r.spec_id, Number(r.files)]));
  }

  /**
   * Holds the credits for a follow up and queues it. In one transaction
   * under the workspace row lock (the order createJob and the ledger
   * functions use): the job moves from done back to generating, which only
   * one request can win, so a double click never runs a shot twice; any
   * extra rows are written (an added photo); reserve_credits holds the shots'
   * seed prices against the job; and a rerun row puts each card back in
   * progress. A refusal writes nothing. The same transaction gives the job
   * a fresh run key, which the runner's every check then requires, so a
   * stale runner of an earlier run can never act on this one (0019). When
   * the payload cannot be built or the queue refuses the follow up, the hold
   * is returned and the job goes back to done.
   */
  private async startFollowUp(
    workspaceId: string,
    job: typeof generationJobs.$inferSelect,
    reason: PackFollowUpReason,
    shots: Shot[],
    stage: string,
    output: ResolvedOutputOptions | null,
    prepare?: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<void>,
  ): Promise<ShotOpResult> {
    const maintenance = await getPackMaintenance(this.db);
    if (maintenance.paused) return { outcome: "rejected", reason: "unavailable", message: maintenance.message };
    const credits = followUpCredits(shots);
    if (inlineRunnerDraining()) {
      return { outcome: "rejected", reason: "unavailable", message: RESTARTING_MESSAGE };
    }
    // The same cutout pause createJob enforces, before any hold is taken: a
    // shot that needs a cutout would only come back for review.
    const paused = await this.cutoutPauseRefusal(workspaceId, followUpCutoutSources(shots));
    if (paused) {
      return { outcome: "rejected", reason: "unavailable", message: paused };
    }
    const runKey = crypto.randomUUID();
    let baseCostMicros = 0;
    let rerunIds: string[] = [];
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        const moved = await tx
          .update(generationJobs)
          .set({ status: "generating", runKey, runnerId: runnerId(), heartbeatAt: new Date(), startedAt: null, finishedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(generationJobs.id, job.id),
              eq(generationJobs.workspaceId, workspaceId),
              eq(generationJobs.status, "done"),
            ),
          )
          .returning({ cogsMicros: generationJobs.cogsMicros });
        if (moved.length === 0) {
          throw new FollowUpNotReadyError();
        }
        baseCostMicros = Number(moved[0].cogsMicros ?? 0);
        await assertSourceKeysAvailable(tx, workspaceId, shots.map((shot) => shot.sourceMediaId));
        await prepare?.(tx);
        await assertRegisteredSources(tx, workspaceId, job.productId, shots.map((shot) => shot.sourceMediaId));
        await this.assertSourceObjects(shots.map((shot) => shot.sourceMediaId));
        try {
          await tx.execute(sql`select reserve_credits(${workspaceId}::uuid, ${credits}::numeric, ${job.id}::uuid)`);
        } catch (err) {
          throw new ReservationError(err);
        }
        const rows = await tx
          .insert(jobSteps)
          .values(
            shots.map((shot) => ({
              workspaceId,
              jobId: job.id,
              shotId: shot.id,
              stage: shots.length === 1 ? stage : shot.type,
              provider: "worker",
              status: RERUN_STEP_STATUS,
            })),
          )
          .returning({ id: jobSteps.id });
        rerunIds = rows.map((r) => r.id);
      });
    } catch (err) {
      if (err instanceof SourceUnavailableError) return { outcome: "rejected", reason: "not_retryable", message: err.message };
      if (err instanceof FollowUpNotReadyError) {
        return { outcome: "rejected", reason: "not_ready", message: NOT_READY_MESSAGE };
      }
      if (err instanceof MediaConflictError) {
        return { outcome: "rejected", reason: "conflict", message: "That photo is already saved to another product." };
      }
      if (err instanceof ReservationError && isInsufficientCreditsError(err.original)) {
        return {
          outcome: "rejected",
          reason: "insufficient_credits",
          message: `Not enough credits to run this again. It needs ${credits} ${credits === 1 ? "credit" : "credits"}.`,
        };
      }
      if (err instanceof ReservationError && isCreditBudgetExceeded(err.original)) return creditBudgetRejection(credits);
      console.error(
        `[jobs] could not start a ${reason} follow up on job ${job.id}`,
        err instanceof ReservationError ? err.original : err,
      );
      return { outcome: "rejected", reason: "unavailable", message: UNAVAILABLE_MESSAGE };
    }

    // Everything from here runs under the hold that just committed, so any
    // failure, building the payload included, returns it (abandonFollowUp).
    try {
      const payload = await this.followUpPayload(workspaceId, job, {
        runKey,
        reason,
        shots,
        credits,
        baseCostMicros,
        output,
      });
      const saved = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "runKey"));
      const persisted = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        const logoKeys = payload.brand?.logoKey ? [payload.brand.logoKey] : [];
        await assertSourceKeysAvailable(tx, workspaceId, logoKeys);
        await this.assertSourceObjects(logoKeys);
        return tx.update(generationJobs)
          .set({ restartPayload: { ...saved, acceptedAt: new Date().toISOString() } })
          .where(and(eq(generationJobs.id, job.id), eq(generationJobs.workspaceId, workspaceId), eq(generationJobs.runKey, runKey), eq(generationJobs.status, "generating")))
          .returning({ id: generationJobs.id });
      });
      if (!persisted.length) throw new FollowUpNotReadyError();
      await enqueuePackFollowUp(payload);
    } catch (err) {
      const restarting = err instanceof InlineRunnerClosedError;
      if (!restarting) {
        console.error(`[jobs] could not queue a ${reason} follow up on job ${job.id}`, err);
      }
      await this.abandonFollowUp(workspaceId, job.id, rerunIds, runKey);
      if (err instanceof SourceSelectionUnavailableError) {
        return { outcome: "rejected", reason: "not_retryable", message: err.message };
      }
      return { outcome: "rejected", reason: "unavailable", message: restarting ? RESTARTING_MESSAGE : UNAVAILABLE_MESSAGE };
    }
    const view = await this.getJob(workspaceId, job.id);
    if (!view) {
      return { outcome: "rejected", reason: "not_found", message: NOT_FOUND_MESSAGE };
    }
    return { outcome: "started", job: view, creditsHeld: credits };
  }

  /** The follow up's worker payload, from the same sources createJob uses:
   * the product's SKU and title, the brand kit (colors, fonts, logo and
   * style preset), the plan's social badge and the recipe versions the job's
   * first run recorded. The brand kit is optional styling, so a failed
   * lookup falls back to the defaults; anything else throws. */
  private async followUpPayload(
    workspaceId: string,
    job: typeof generationJobs.$inferSelect,
    run: {
      runKey: string;
      reason: PackFollowUpReason;
      shots: Shot[];
      credits: number;
      baseCostMicros: number;
      output: ResolvedOutputOptions | null;
    },
  ): Promise<FollowUpPayload> {
    const product = await this.db.query.products.findFirst({ where: (t, { eq }) => eq(t.id, job.productId) });
    const workspace = await this.db.query.workspaces.findFirst({ where: (t, { eq }) => eq(t.id, workspaceId) });
    const tier = tierKeyOf(workspace?.plan);
    let brandColors: string[] = [];
    let brand: PackFollowUpInput["brand"] | null = null;
    try {
      const kit = await this.db.query.brandKits.findFirst({ where: (t, { eq }) => eq(t.workspaceId, workspaceId) });
      brandColors = Array.isArray(kit?.colors)
        ? kit.colors.filter((c): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 6)
        : [];
      brand = kit
        ? brandStyleFor(workspaceId, { fonts: kit.fonts ?? null, logoKey: kit.logoR2Key, stylePreset: kit.stylePreset })
        : null;
    } catch (err) {
      console.warn(`[jobs] brand kit lookup failed for workspace ${workspaceId}; using default colors`, err);
    }
    const recipeVariants = job.recipeVariants && Object.keys(job.recipeVariants).length > 0 ? job.recipeVariants : null;
    // Colors come from the job's snapshot, never the live kit: the brand
    // sweep hex leads the list (the runner's sweep_brand takes the first
    // valid color), so a kit edit after the pack never changes a retried
    // file (PHASE_15 follow ups).
    if (run.output) {
      const sweep = run.output.brandSweepHex;
      brandColors = [sweep, ...brandColors.filter((c) => c.toUpperCase() !== sweep)].slice(0, 6);
    }
    return {
      kind: "follow_up",
      runKey: run.runKey,
      jobId: job.id,
      workspaceId,
      reason: run.reason,
      shots: run.shots,
      creditBudget: run.credits,
      channels: job.channels ?? [],
      mode: "listing",
      sku: product?.sku || product?.amazonSku || undefined,
      seoSlug: seoSlugFor(product?.title ?? null),
      brandColors,
      ...(brand ? { brand } : {}),
      ...(recipeVariants ? { recipeVariants } : {}),
      socialBadge: socialBadgeByTier[tier] ?? false,
      existingFilesBySpec: await this.filesBySpec(workspaceId, job.id),
      baseCostMicros: run.baseCostMicros,
      ...(await this.followUpSelections(workspaceId, job, run.shots, run.reason)),
      ...(run.output ? { output: run.output } : {}),
      ...(await this.reencodedSources(workspaceId, run.shots)),
      ...(run.output?.fit === "crop" ? await this.productBoxesFor(workspaceId, run.shots) : {}),
      ...(shotsReachOverlayRefusingSpecs(run.shots) ? await this.addedOverlaySources(workspaceId, run.shots) : {}),
    };
  }

  /** Reuse the worker's exact decision, never reclassify the original photo
   * against today's models or the seller's edited product description. */
  private async followUpSelections(
    workspaceId: string,
    job: typeof generationJobs.$inferSelect,
    shots: Shot[],
    reason: PackFollowUpReason,
  ): Promise<Pick<PackFollowUpInput, "sourceSelections" | "resolveAddedSources">> {
    const keys = [...new Set(shots.map((shot) => shot.sourceMediaId))];
    const [rows, sources, preflights] = await Promise.all([
      this.db.query.assets.findMany({
        where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.jobId, job.id)),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      }),
      this.db.query.sourceMedia.findMany({
        where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), eq(t.productId, job.productId), inArray(t.r2Key, keys)),
      }),
      preflightRowsFor(this.db, workspaceId, keys),
    ]);
    const selections: Record<string, SourceSelection> = {};
    const resolveAddedSources: string[] = [];
    const priorSelections = reason === "add_angle" ? rows.flatMap((row) => {
      const shot = storedShot(row.qc);
      return shot && row.qc?.sourceSelection !== undefined ? [readSourceSelection(row.qc.sourceSelection, shot.sourceMediaId)] : [];
    }) : [];
    const priorExclude = [...new Set(priorSelections.flatMap((value) => [...value.exclude, ...(value.target?.others.map((other) => other.label) ?? [])]))];
    for (const key of keys) {
      const saved = rows.find((row) => storedShot(row.qc)?.sourceMediaId === key && row.qc?.sourceSelection !== undefined);
      if (saved) {
        selections[key] = readSourceSelection(saved.qc?.sourceSelection, key);
        continue;
      }
      const source = sources.find((row) => row.r2Key === key);
      if (!source) throw new SourceSelectionUnavailableError();
      // A newly added Keep photo is explicitly used whole. Conservatively
      // retain the other-items guard when intake cannot prove it is alone.
      const keptAddition = reason === "add_angle" && shots.filter((shot) => shot.sourceMediaId === key).every((shot) => shot.type === "original_photo");
      const preflight = preflights.get(key);
      const intake = IntakeImageResult.safeParse(preflight?.intake?.image);
      const singleIntake = preflight?.status === "ready" && intake.success && intake.data.sellableProduct && intake.data.screenshot !== true && intake.data.distinctProducts === 1 &&
        (!intake.data.products || intake.data.products.length === 1);
      const inventory = job.inventory?.photos.find((photo) => photo.mediaId === key);
      const singleInventory = inventory?.items.length === 1 && inventory.intakeCount === 1 &&
        inventory.countMatch === true && !inventory.touching &&
        ["single_object", "single_product"].includes(inventory.rule) &&
        inventory.unmatchedItems.length === 0 && inventory.unmatchedProducts.length === 0 &&
        inventory.items[0].status !== "removed";
      const hadPlannedSource = rows.some((row) => storedShot(row.qc)?.sourceMediaId === key);
      if (reason === "add_angle" && !hadPlannedSource && !keptAddition && !source.targetBox && !inventory && !singleIntake) {
        // Known multi-product intake is an ambiguity, not permission to
        // reinterpret it as one connected cutout. Without intake, the
        // priced shot's cutout supplies the existing geometric inventory.
        if (intake.success) throw new SourceSelectionUnavailableError();
        if (priorSelections.length === 0) throw new SourceSelectionUnavailableError();
        selections[key] = { version: 1, sourceMediaId: key, target: null, exclude: priorExclude, otherItems: false };
        resolveAddedSources.push(key);
        continue;
      }
      // A legacy selected box or conflicting inventory cannot be replaced
      // by a generic single-product preflight answer. Existing sources need
      // reliable stored evidence; they never enter the added-photo fallback.
      if (!keptAddition && (source.targetBox || (inventory ? !singleInventory : !singleIntake))) {
        throw new SourceSelectionUnavailableError();
      }
      const label = singleInventory ? inventory!.items[0].label : intake.success ? intake.data.products?.[0]?.label : undefined;
      selections[key] = {
        version: 1,
        sourceMediaId: key,
        basis: keptAddition ? "added_original_photo" : singleInventory ? "single_product_inventory" : "single_product_intake",
        target: label && !keptAddition ? { label, box: null, others: [] } : null,
        exclude: priorExclude,
        otherItems: keptAddition && !singleIntake,
      };
    }
    return { sourceSelections: selections, ...(resolveAddedSources.length ? { resolveAddedSources } : {}) };
  }

  /**
   * The product box per source photo of the follow up shots, for the P1
   * crop fit of kept photos: the seller's tap (source_media.target_box),
   * else the upload preflight's productBox. The same rule as a first run.
   */
  private async productBoxesFor(
    workspaceId: string,
    shots: Shot[],
  ): Promise<{ productBoxes?: Record<string, { x: number; y: number; width: number; height: number }> }> {
    const keys = [...new Set(shots.map((s) => s.sourceMediaId).filter((k): k is string => typeof k === "string" && k.length > 0))];
    if (keys.length === 0) {
      return {};
    }
    try {
      const [rows, preflights] = await Promise.all([
        this.db.query.sourceMedia.findMany({
          where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.r2Key, keys)),
          columns: { r2Key: true, targetBox: true },
        }),
        preflightRowsFor(this.db, workspaceId, keys),
      ]);
      const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const key of keys) {
        const box = rows.find((r) => r.r2Key === key)?.targetBox ?? preflightProductBoxOf(preflights.get(key));
        if (box) {
          boxes[key] = box;
        }
      }
      return Object.keys(boxes).length > 0 ? { productBoxes: boxes } : {};
    } catch (err) {
      // A crop without a box falls back to added space with a note, so a
      // failed read never stops the follow up.
      console.warn(`[jobs] could not read the product boxes of workspace ${workspaceId}`, err);
      return {};
    }
  }

  /** The follow up shots' source photos whose stored copy was written again
   * at upload (source_media.ingest), so the runner checks a kept photo
   * against that copy (PHASE_15). */
  private async reencodedSources(workspaceId: string, shots: Shot[]): Promise<{ reencoded?: string[] }> {
    const keys = [...new Set(shots.map((s) => s.sourceMediaId).filter((k): k is string => typeof k === "string" && k.length > 0))];
    if (keys.length === 0) {
      return {};
    }
    const rows = await this.db.query.sourceMedia.findMany({
      where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.r2Key, keys)),
      columns: { r2Key: true, ingest: true },
    });
    const reencoded = rows.filter((r) => ingestRecordOf(r.ingest)?.reencoded === true).map((r) => r.r2Key);
    return reencoded.length > 0 ? { reencoded } : {};
  }

  /**
   * The kept photos of the follow up shots that the upload preflight saw
   * added text, borders or watermarks on, so the runner leaves them off the
   * channels that refuse those (applyAddedOverlays) whatever the plan says.
   * A failed read sends none: the web plan already left them out.
   */
  private async addedOverlaySources(workspaceId: string, shots: Shot[]): Promise<{ addedOverlays?: string[] }> {
    const keys = [
      ...new Set(
        shots
          .filter((s) => s.type === "original_photo")
          .map((s) => s.sourceMediaId)
          .filter((k): k is string => typeof k === "string" && k.length > 0),
      ),
    ];
    if (keys.length === 0) {
      return {};
    }
    try {
      const rows = await preflightRowsFor(this.db, workspaceId, keys);
      const flagged = keys.filter((key) => preflightAddedOverlaysOf(rows.get(key)) === true);
      return flagged.length > 0 ? { addedOverlays: flagged } : {};
    } catch (err) {
      console.warn(`[jobs] could not read the preflights of workspace ${workspaceId}`, err);
      return {};
    }
  }

  /**
   * Whether the upload preflight saw text, borders or watermarks added on an
   * added photo. A stored verdict of any age is read first; without one the
   * preflight runs now, the same check (and the same workspace booked
   * spend) as an upload in the new pack form, and its row is kept for the
   * payload. A preflight that cannot run answers false, as a first run whose
   * intake verdicts cannot be mapped ships the photo as before.
   */
  private async addedPhotoOverlays(workspaceId: string, key: string): Promise<boolean> {
    try {
      const known = preflightAddedOverlaysOf((await preflightRowsFor(this.db, workspaceId, [key])).get(key));
      if (known !== null) {
        return known;
      }
      const preflight = await runPreflightUpload(this.preflightDeps(), workspaceId, { key });
      return preflight.addedOverlays === true;
    } catch (err) {
      console.warn(`[jobs] could not check an added photo for added text in workspace ${workspaceId}`, err);
      return false;
    }
  }

  /** The preflight service's deps: the worker runtime and R2, or the test
   * overrides. */
  private preflightDeps(): PreflightServiceDeps {
    const overrides = this.deps.preflight ?? {};
    const storage = isR2Configured();
    return {
      db: this.db,
      ...(overrides.run ? { run: overrides.run } : {}),
      putObject: overrides.putObject !== undefined ? overrides.putObject : storage ? putGeneratedObject : null,
      sign: overrides.sign ?? (storage ? (key: string) => presignObjectGet(key) : undefined),
      ...(overrides.now ? { now: overrides.now } : {}),
    };
  }

  /** Undoes a follow up that could not be queued: returns its hold (the
   * first run settled its own, so all the job holds is this one), puts the
   * job back to done under a run key no runner holds, and drops the rerun
   * rows so the cards read as before. The release and the status change
   * run under the workspace row lock and only while the job still carries
   * this follow up's run key, so a cancel that settled it first, or a newer
   * follow up, is never undone. Best effort; the stale run reconciler is
   * the backstop for the hold. */
  private async abandonFollowUp(workspaceId: string, jobId: string, rerunIds: string[], runKey: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        const moved = await tx
          .update(generationJobs)
          .set({ status: "done", logicalRunOutcome: "failed", runKey: sql`gen_random_uuid()::text`, restartPayload: null, runnerId: null, heartbeatAt: null, finishedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(generationJobs.id, jobId),
              eq(generationJobs.workspaceId, workspaceId),
              eq(generationJobs.status, "generating"),
              eq(generationJobs.runKey, runKey),
            ),
          )
          .returning({ id: generationJobs.id });
        if (moved.length > 0) {
          await tx.execute(sql`select release_credits(${workspaceId}::uuid, ${jobId}::uuid)`);
        }
      });
      if (rerunIds.length > 0) {
        await this.db
          .delete(jobSteps)
          .where(
            and(
              eq(jobSteps.workspaceId, workspaceId),
              sql`${jobSteps.id} = any(${`{${rerunIds.join(",")}}`}::uuid[])`,
            ),
          );
      }
    } catch (err) {
      console.error(`[jobs] could not undo the follow up on job ${jobId}`, err);
    }
  }

  /** The replay or conflict answer for a reused Idempotency-Key, or null
   * when the key is new. A replay must match the request body (plan 4.4.1);
   * a "new" product resolved to a real id on the first attempt, so a retry
   * can only match on the rest. Keys are unique per workspace (0019), so
   * only this workspace's jobs are looked at: another workspace using the
   * same key is neither a conflict nor visible here. */
  private async replayFor(workspaceId: string, input: CreateJobInput, skipProvenMismatch = false): Promise<CreateJobResult | null> {
    const existing = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.idempotencyKey, input.idempotencyKey)),
    });
    if (!existing) {
      return null;
    }
    // A legacy row never saved its complete input. Mutable product/source
    // rows cannot prove that a retry is the same request, so return the
    // existing pack as a conflict without creating another hold.
    const verifiable = typeof existing.requestFingerprint === "string" && /^[0-9a-f]{64}$/.test(existing.requestFingerprint);
    let sameBody = false;
    try {
      sameBody = verifiable && existing.requestFingerprint === jobRequestFingerprint(input);
    } catch {
      // Malformed options cannot match a previously accepted request.
    }
    if (sameBody) {
      const job = await this.getJob(workspaceId, existing.id);
      if (job) {
        return { outcome: "replayed", job };
      }
    }
    if (skipProvenMismatch && verifiable && !sameBody) return null;
    return { outcome: "conflict", existingJobId: existing.id };
  }

  /**
   * The checks every pack request meets first, in createJob's order: the
   * caller's seat, the mode, the plan's entitlements (from the seed) and the
   * product. Shared with estimateJob (PHASE_19 P19-16). Reads only.
   */
  private async packGate(
    workspaceId: string,
    input: Pick<CreateJobInput, "mode" | "channels" | "productId">,
  ): Promise<{ ok: false; rejection: CreateJobRejection } | { ok: true; tier: TierKey; existingProduct: ProductRow | null }> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return {
        ok: false,
        rejection: {
          outcome: "rejected",
          reason: "role_forbidden",
          message: "Client seats can review assets but cannot start packs or spend credits.",
        },
      };
    }

    if (input.mode === "concept" && !CONCEPT_MODE_AVAILABLE) {
      return {
        ok: false,
        rejection: {
          outcome: "rejected",
          reason: "mode_unavailable",
          message: "Concept Mode is not available yet. Start a Listing Mode pack from a real photo.",
        },
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
      return { ok: false, rejection: { outcome: "rejected", reason: entitled.reason, message: entitled.message } };
    }

    let existingProduct: ProductRow | null = null;
    if (input.productId !== "new") {
      existingProduct = isUuid(input.productId)
        ? ((await this.db.query.products.findFirst({
            where: (t, { and, eq }) => and(eq(t.id, input.productId), eq(t.workspaceId, workspaceId)),
          })) ?? null)
        : null;
      if (!existingProduct) {
        return {
          ok: false,
          rejection: { outcome: "rejected", reason: "unknown_product", message: "That product does not exist in this workspace." },
        };
      }
    }
    return { ok: true, tier, existingProduct };
  }

  /** The photos a pack of this product already has: stored images in this
   * workspace's source prefix, newest first, at most MAX_PACK_MEDIA. */
  private async storedPackMedia(workspaceId: string, existingProduct: ProductRow | null): Promise<PackMedia[]> {
    if (!existingProduct) {
      return [];
    }
    return (
      await this.db.query.sourceMedia.findMany({
        where: (t, { and, eq, like }) =>
          and(eq(t.productId, existingProduct.id), eq(t.workspaceId, workspaceId), like(t.r2Key, `ws/${workspaceId}/src/%`)),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
        limit: MAX_PACK_MEDIA,
      })
    )
      .filter((m) => isWorkspaceSourceKey(workspaceId, m.r2Key))
      .map(
        (m): PackMedia => ({
          r2Key: m.r2Key,
          kind: m.kind,
          angle: isAngleRole(m.angle) ? m.angle : null,
          targetBox: m.targetBox ?? null,
          width: m.width,
          height: m.height,
          reencoded: ingestRecordOf(m.ingest)?.reencoded ?? null,
        }),
      );
  }

  /**
   * The hold createJob takes for a request, from the pack's photos: the
   * seller inputs the product will hold, the brand kit, the resolved output
   * options and the seed estimate (outputEstimateInputs), in createJob's
   * order with its refusals. Shared with estimateJob (PHASE_19 P19-16), so
   * an estimate is the hold by construction. Reads only.
   */
  private async holdFor(
    workspaceId: string,
    input: HoldRequest,
    tier: TierKey,
    existingProduct: ProductRow | null,
    media: PackMedia[],
    options: { cutoutPause: boolean },
  ): Promise<{ ok: false; rejection: CreateJobRejection } | ({ ok: true } & PackHold)> {
    const reject = (reason: CreateJobRejection["reason"], message: string) =>
      ({ ok: false, rejection: { outcome: "rejected", reason, message } }) as const;
    // Seller inputs this request saves on the product, and what the product
    // then holds. The hold covers the shots they unlock (the photo angles,
    // in_the_box and comparison), so the worker's budget trim keeps them.
    const sellerUpdates = sellerInputUpdates(input);
    const sellerInputs = {
      boxContents: sellerUpdates.boxContents ?? printableSellerLines(existingProduct?.boxContents),
      comparisonFacts: sellerUpdates.comparisonFacts ?? printableSellerLines(existingProduct?.comparisonFacts),
      endorsements: sellerUpdates.endorsements ?? printableEndorsements(existingProduct?.endorsements),
    };

    // Plan 2.7: Listing Mode requires at least one real photo. Angles that
    // were not photographed are skipped by the planner, never invented.
    if (input.mode === "listing" && !media.some((m) => m.kind !== "video")) {
      return reject("needs_photo", "Listing Mode needs at least one real photo of this product. Upload one first.");
    }

    // The brand kit is read before the estimate, because a brand color is
    // resolved and snapshotted from it. It stays optional styling: a failed
    // read falls back to the default colors, unless the seller picked a
    // brand color, which then cannot be resolved.
    let brandColors: string[] = [];
    let brandKit: PayloadBrandKit | null = null;
    let brandKitRead = true;
    try {
      const kit = await this.db.query.brandKits.findFirst({ where: (t, { eq }) => eq(t.workspaceId, workspaceId) });
      brandColors = Array.isArray(kit?.colors) ? kit.colors.filter((c): c is string => typeof c === "string") : [];
      brandKit = kit ? { fonts: kit.fonts ?? null, logoKey: kit.logoR2Key, stylePreset: kit.stylePreset } : null;
    } catch (err) {
      brandKitRead = false;
      console.warn(`[jobs] brand kit lookup failed for workspace ${workspaceId}; using default colors`, err);
    }

    // The seller's output options (PHASE_15 item 24), resolved against the
    // flags, the plan and the kit. Kept photos are this pack's photos by R2
    // key, with the stored sizes, so the hold knows which channels each one
    // can reach.
    const photos: OutputPhoto[] = media
      .filter((m) => m.kind !== "video")
      .map((m) => ({ id: m.r2Key, angle: m.angle, width: m.width ?? null, height: m.height ?? null }));
    if (!brandKitRead && input.outputOptions?.color?.kind === "brand") {
      return reject("unavailable", UNAVAILABLE_MESSAGE);
    }
    const photoBackgrounds = photoBackgroundsOf(input.uploads);
    const wantsOptions =
      input.mode !== "concept" &&
      (isNonDefaultRequest(input.outputOptions) || hasPhotoBackgroundOverride(input.outputOptions, photoBackgrounds));
    const output = resolveJobOutput({
      input: input.outputOptions,
      mode: input.mode,
      enabled: wantsOptions ? await this.outputOptionsEnabled() : true,
      brandColors,
      brandKitsAllowed: entitlementsFor(tier).brandKits > 0,
      photos,
      photoBackgrounds,
    });
    if (!output.ok) {
      return reject(output.reason, output.message);
    }

    // While every cutout provider is down, only a pack that needs no cutout
    // may start (a Keep pack with no white required channel and no extras),
    // or one whose every cutout is already in the upload cache.
    if (options.cutoutPause && packNeedsCutout(input.channels, output.flags)) {
      const paused = await this.cutoutPauseRefusal(
        workspaceId,
        cutoutMediaIds(output.flags.photos, input.channels, output.flags),
      );
      if (paused) {
        return reject("unavailable", paused);
      }
    }

    // Reservation is a seed cost estimate that leaves out shots production
    // cannot deliver; the worker's planner recomputes the exact plan and
    // charge_credits bills only the assets that pass QC. The same estimate
    // inputs as the form and the demo (outputEstimateInputs).
    const estimateInputs: EstimateSellerInputs = {
      angles: media.filter((m) => m.kind !== "video").flatMap((m) => (m.angle ? [m.angle] : [])),
      hasBoxContents: sellerInputs.boxContents.length > 0,
      hasComparisonFacts: sellerInputs.comparisonFacts.length > 0,
      hasEndorsements: sellerInputs.endorsements.length > 0,
      ...outputEstimateInputs(output.resolved, photos),
    };
    const creditsReserved = estimatePackCredits(input.channels, input.mode, tier, estimateInputs).total;
    return { ok: true, sellerUpdates, brandColors, brandKit, output, estimateInputs, creditsReserved };
  }

  /** estimate_pack (PHASE_19 P19-16): createJob's gate and hold for the same
   * request, the balance and the channels left out. Snapshot callers opt
   * out of the normal balance read's stale job recovery. */
  async estimateJob(workspaceId: string, input: EstimateJobInput, options: ServiceReadOptions = {}): Promise<EstimateJobResult> {
    const gate = await this.packGate(workspaceId, input);
    if (!gate.ok) {
      return gate.rejection;
    }
    const { tier, existingProduct } = gate;
    // The uploads as createJob registers them, with the sizes its ingest
    // records for the same bytes (the caller measured them upright).
    const uploads: PackMedia[] = [
      ...new Map(
        (input.uploads ?? []).filter((u) => isWorkspaceSourceKey(workspaceId, u.key)).map((u) => [u.key, u]),
      ).values(),
    ].map((u) => ({
      r2Key: u.key,
      kind: u.kind,
      angle: u.angle ?? null,
      targetBox: null,
      width: u.width,
      height: u.height,
    }));
    const media = mergePackMedia(uploads, await this.storedPackMedia(workspaceId, existingProduct));
    const hold = await this.holdFor(workspaceId, input, tier, existingProduct, media, { cutoutPause: false });
    if (!hold.ok) {
      return hold.rejection;
    }
    if (hold.creditsReserved <= 0) {
      return { outcome: "rejected", reason: "empty_plan", message: NO_BILLABLE_SHOTS_MESSAGE };
    }
    const coverage = estimatedSpecCoverage(input.channels, input.mode, tier, hold.estimateInputs);
    return {
      outcome: "estimated",
      creditsNeeded: hold.creditsReserved,
      creditsAvailable: await this.creditBalance(workspaceId, options),
      creditBudget: await readCreditBudget(this.db, workspaceId),
      channels: coverage.made,
      leftOut: [
        ...coverage.comingSoon.map((specId) => ({ specId, reason: "coming_soon" as const })),
        ...coverage.notMade.map((specId) => ({ specId, reason: "not_made" as const })),
      ],
    };
  }

  async workspaceBalance(workspaceId: string): Promise<number | null> {
    if ((await this.currentRole(workspaceId)) === null) {
      return null;
    }
    return this.creditBalance(workspaceId);
  }

  /** The replay or conflict answer for this request's key, after a replay
   * under one of its previous keys (PHASE_19 P19-16). Only a provably
   * different request under a previous key is passed over. Legacy receipts
   * cannot prove that, so they conflict without taking another hold. */
  private async replayForAny(workspaceId: string, input: CreateJobInput): Promise<CreateJobResult | null> {
    for (const key of input.previousIdempotencyKeys ?? []) {
      if (key === input.idempotencyKey) {
        continue;
      }
      const earlier = await this.replayFor(workspaceId, { ...input, idempotencyKey: key }, true);
      if (earlier) {
        return earlier;
      }
    }
    return this.replayFor(workspaceId, input);
  }

  /**
   * Creates a pack job (Update.md 6.3). Everything that can reject the
   * request is checked before anything is written: role, mode, product,
   * uploads, photo requirement, the credit estimate and, for an assistant,
   * its credit cap (PHASE_19 P19-16). The product (when new), the uploads,
   * the job row and the credit hold are then written in one transaction, so
   * rollback leaves no partial product, source, job or credit records.
   * Uploads insert with ON CONFLICT DO NOTHING against the
   * (workspace_id, r2_key) unique index, so a retry never duplicates a photo.
   */
  async createJob(workspaceId: string, input: CreateJobInput, lifecycle?: CreateJobLifecycle): Promise<CreateJobResult> {
    const replay = await this.replayForAny(workspaceId, input);
    if (replay) {
      return replay;
    }

    const maintenance = await getPackMaintenance(this.db);
    if (maintenance.paused) return { outcome: "rejected", reason: "maintenance", message: maintenance.message };
    const gate = await this.packGate(workspaceId, input);
    if (!gate.ok) {
      return gate.rejection;
    }
    const { tier, existingProduct } = gate;
    let requestFingerprint: string;
    try {
      requestFingerprint = jobRequestFingerprint(input);
    } catch {
      return { outcome: "rejected", reason: "invalid_options", message: INVALID_OPTIONS_MESSAGE };
    }
    const today = new Date().toISOString().slice(0, 10);
    const counters = await this.db.select().from(spendCapCounters).where(inArray(spendCapCounters.key, [`caps:workspace:${workspaceId}:${today}`, `caps:global:${today}`]));
    const spent = (key: string) => Number(counters.find((r) => r.key === key)?.totalMicros ?? 0);
    if (spent(`caps:workspace:${workspaceId}:${today}`) >= costCaps.workspaceExpectedDailyMicrosByTier[tier] * costCaps.workspaceDailyMultiplier) return {
      outcome: "rejected", reason: "workspace_day_cap", message: "This workspace reached its daily limit. It resets tomorrow, or email support@curvi.ai.",
    };
    if (spent(`caps:global:${today}`) >= await resolveGlobalHardStop(this.db)) return {
      outcome: "rejected", reason: "unavailable", message: "New packs are paused for today. Please try again tomorrow.",
    };

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
    // Every upload is read back and checked before anything is written; the
    // stored hash and size are the server's, never the client's. One at a
    // time, so a pack of large photos never holds them all in memory.
    const checked = new Map<
      string,
      { sha256: string; width: number | null; height: number | null; ingest: SourceMediaIngest | null }
    >();
    for (const upload of uploadRows) {
      const outcome = await this.ingest(upload.key, upload.kind);
      if (outcome && !outcome.ok) {
        return {
          outcome: "rejected",
          reason: outcome.retryable ? "unavailable" : "invalid_upload",
          message: outcome.notice,
        };
      }
      if (outcome?.ok) {
        checked.set(upload.key, {
          sha256: outcome.sha256 ?? upload.sha256,
          width: outcome.width,
          height: outcome.height,
          ingest: outcome.ingest ?? null,
        });
      }
    }
    const uploads: PackMedia[] = uploadRows.map((u) => ({
      r2Key: u.key,
      kind: u.kind,
      angle: u.angle ?? null,
      targetBox: u.targetBox ?? null,
      width: checked.get(u.key)?.width ?? null,
      height: checked.get(u.key)?.height ?? null,
    }));
    const merged = mergePackMedia(uploads, await this.storedPackMedia(workspaceId, existingProduct));

    // The preflight at upload (PHASE_14.md workstream 4): a photo it found a
    // blocking problem in never starts a pack, so nothing is held for it,
    // and each photo's intake answer rides the payload for the runner to
    // reuse. A lookup that fails (for example before migration 0022 is
    // applied) changes nothing: the runner checks every photo itself.
    const preflights = await preflightRowsFor(
      this.db,
      workspaceId,
      merged.map((m) => m.r2Key),
    ).catch((err: unknown): Map<string, UploadPreflight> => {
      console.warn(`[jobs] could not read the preflights of workspace ${workspaceId}`, err);
      return new Map();
    });
    // Each upload's source_media.ingest record: the preflight at upload
    // checked it first, and a photo it turned upright reads as unchanged by
    // the time this request checks it again.
    const ingestByKey = new Map(
      uploadRows.map((u) => [u.key, mergeIngestRecords(preflightIngestOf(preflights.get(u.key)), checked.get(u.key)?.ingest)]),
    );
    const media: PackMedia[] = merged.map((m) =>
      ingestByKey.has(m.r2Key) ? { ...m, reencoded: ingestByKey.get(m.r2Key)?.reencoded ?? null } : m,
    );
    // The question step's taps, resolved against the questions stored for
    // that upload (PHASE_16 workstream 4). Never a reason to refuse a pack.
    // An API caller has no preflight and sends seed choice values instead.
    const sellerAnswers = input.sellerAnswers
      ? sellerAnswersFor(
          preflights,
          merged.map((m) => m.r2Key),
          input.sellerAnswers,
        )
      : sellerAnswersFromChoices(input.answers);
    const blocked = uploadRows
      .filter((u) => u.kind === "image")
      .map((u) => preflights.get(u.key))
      .find((row) => row?.status === "blocked");
    if (blocked) {
      const problem = (blocked.result as { problem?: { title?: string; fix?: string } }).problem;
      return {
        outcome: "rejected",
        reason: "invalid_upload",
        message:
          problem?.title && problem.fix
            ? `${problem.title} ${problem.fix}`
            : "One of these photos cannot be used for a pack. Remove it and upload another.",
      };
    }

    const hold = await this.holdFor(workspaceId, input, tier, existingProduct, media, { cutoutPause: true });
    if (!hold.ok) {
      return hold.rejection;
    }
    const { sellerUpdates, brandColors, brandKit, output, creditsReserved } = hold;
    if (creditsReserved <= 0) {
      return { outcome: "rejected", reason: "empty_plan", message: NO_BILLABLE_SHOTS_MESSAGE };
    }
    // An assistant's cap (PHASE_19 P19-16, founder decision 5): never hold
    // more than the estimate it showed the seller, or its max_credits.
    if (input.maxCredits !== undefined && creditsReserved > input.maxCredits) {
      return overMaxCreditsRejection(creditsReserved, input.maxCredits);
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

    // Product, source rows, job and reservation commit together, so rollback
    // leaves no partial database records behind (Update.md 6.3).
    // The run key goes on the job row in the same transaction and rides the
    // payload, so the runner's liveness checks name this run (0019).
    const runKey = crypto.randomUUID();
    let created: { product: ProductRow; jobId: string; insertedMediaIds: string[]; payload: ReturnType<typeof buildGeneratePackInput> };
    // A commit may become visible even if the driver loses its acknowledgment.
    // Relinquish request cleanup before persistence can publish source keys.
    // Rolled-back attempts leave unreferenced objects for normal retention.
    if (lifecycle) lifecycle.retainUploads = true;
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
        const sourceKeys = media.map((item) => item.r2Key);
        const logoKeys = brandKit?.logoKey ? [brandKit.logoKey] : [];
        await assertSourceKeysAvailable(tx, workspaceId, [...sourceKeys, ...logoKeys]);
        // An upload key already registered to a different product cannot be
        // silently borrowed: that product's retention policy would own it.
        if (uploadRows.length) {
          const registered = await tx.select({ productId: sourceMedia.productId }).from(sourceMedia)
            .where(and(eq(sourceMedia.workspaceId, workspaceId), inArray(sourceMedia.r2Key, uploadRows.map((upload) => upload.key))));
          if (registered.some((row) => row.productId !== existingProduct?.id)) throw new MediaConflictError();
        }
        if (existingProduct) await assertRegisteredSources(tx, workspaceId, existingProduct.id,
          sourceKeys.filter((key) => !uploadRows.some((upload) => upload.key === key)));
        await this.assertSourceObjects([...sourceKeys, ...logoKeys]);
        // A new product starts with this request's seller inputs; an existing
        // one takes only the ones this request sent.
        const product = existingProduct
          ? Object.keys(sellerUpdates).length > 0
            ? ((
                await tx
                  .update(products)
                  .set({ ...sellerUpdates, updatedAt: new Date() })
                  .where(and(eq(products.id, existingProduct.id), eq(products.workspaceId, workspaceId)))
                  .returning()
              )[0] ?? existingProduct)
            : existingProduct
          : (
              await tx
                .insert(products)
                .values({
                  workspaceId,
                  title: input.newProductTitle?.trim() || "New product",
                  mode: input.mode,
                  ...sellerUpdates,
                })
                .returning()
            )[0];
        // The seller's choice, remembered on the product for the form's
        // next prefill (PHASE_15 P1). Never read back by createJob.
        await saveOutputDefaults(tx, workspaceId, product.id, input);
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
                    sha256: checked.get(u.key)?.sha256 ?? u.sha256,
                    angle: u.angle ?? null,
                    width: checked.get(u.key)?.width ?? null,
                    height: checked.get(u.key)?.height ?? null,
                    ingest: ingestColumnOf(ingestByKey.get(u.key)),
                  })),
                )
                .onConflictDoNothing({ target: [sourceMedia.workspaceId, sourceMedia.r2Key] })
                .returning({ id: sourceMedia.id })
            : [];
        // The product the seller tapped in the chooser, saved on the photo
        // (0020) so follow ups and later packs keep it.
        for (const upload of uploadRows) {
          if (upload.targetBox) {
            await tx
              .update(sourceMedia)
              .set({ targetBox: upload.targetBox })
              .where(and(eq(sourceMedia.workspaceId, workspaceId), eq(sourceMedia.r2Key, upload.key)));
          }
        }
        const [inserted] = await tx
          .insert(generationJobs)
          .values({
            workspaceId,
            productId: product.id,
            status: "queued",
            idempotencyKey: input.idempotencyKey,
            requestFingerprint,
            channels: input.channels,
            mode: input.mode,
            runKey,
            // The seller's note as typed (0020), so follow ups and retries
            // keep it; the runner saves the intent it parses next to it.
            sellerNote: input.userDescription?.trim() ? input.userDescription : null,
            // The resolved options with the color snapshot (0023), which
            // the payload, the follow ups and the job page read back.
            outputOptions: { ...output.resolved },
            // The seller's answers (0024), as the server resolved them.
            ...(sellerAnswers ? { sellerAnswers: { ...sellerAnswers } } : {}),
          })
          .returning({ id: generationJobs.id });
        const payload = {
        workspaceExpectedDailyMicros: costCaps.workspaceExpectedDailyMicrosByTier[tier],
        ...buildGeneratePackInput({
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
            sku: product.sku,
            boxContents: product.boxContents,
            comparisonFacts: product.comparisonFacts,
            endorsements: product.endorsements,
          },
          media: media.map((m) => ({
            ...m,
            preflight: reusableIntakeOf(preflights.get(m.r2Key), new Date()),
            productBox: preflightProductBoxOf(preflights.get(m.r2Key)),
          })),
          userDescription: input.userDescription,
          brandColors,
          brandKit,
          outputOptions: output.resolved,
          ...(sellerAnswers ? { sellerAnswers } : {}),
          ...(input.audience ? { audience: input.audience } : {}),
        }),
        runKey,
      };
        const { runKey: _savedRunKey, ...restartPayload } = payload;
        void _savedRunKey;
        await tx.update(generationJobs).set({ restartPayload, runnerId: runnerId(), heartbeatAt: new Date() }).where(eq(generationJobs.id, inserted.id));
        try {
          await tx.execute(
            sql`select reserve_credits(${workspaceId}::uuid, ${creditsReserved}::numeric, ${inserted.id}::uuid)`,
          );
        } catch (err) {
          throw new ReservationError(err);
        }
        return { product, jobId: inserted.id, insertedMediaIds: insertedMedia.map((m) => m.id), payload };
      });
    } catch (err) {
      if (err instanceof SourceUnavailableError) return { outcome: "rejected", reason: "invalid_upload", message: err.message };
      if (err instanceof MediaConflictError) {
        // A concurrent identical request may have registered this same key
        // on its newly created product. Its immutable receipt decides replay.
        const winner = await this.replayForAny(workspaceId, input);
        if (winner) return winner;
        return { outcome: "rejected", reason: "invalid_upload", message: "That photo is already saved to another product." };
      }
      if (err instanceof ReservationError && isInsufficientCreditsError(err.original)) {
        // The transaction rolled back, so nothing was reserved or written.
        // Both numbers ride along for an assistant (PHASE_19 P19-14); the
        // web keeps its own line.
        return {
          outcome: "rejected",
          reason: "insufficient_credits",
          message: INSUFFICIENT_CREDITS_MESSAGE,
          creditsNeeded: creditsReserved,
          creditsAvailable: await this.creditBalance(workspaceId),
        };
      }
      if (err instanceof ReservationError && isCreditBudgetExceeded(err.original)) return creditBudgetRejection(creditsReserved);
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
    const { jobId, insertedMediaIds } = created;

    try {
      await enqueueGeneratePack(created.payload);
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
      // API sources were published at commit and can already be reused by
      // another pack, including when this request created the product. Keep
      // those rows and objects. Browser retries reuse their original upload
      // keys, so release only still-unshared new-product rows for the retry.
      await this.abandonJob(workspaceId, jobId, "The pack could not be queued.", existingProduct || input.origin === "api" ? [] : insertedMediaIds);
      return { outcome: "rejected", reason: "unavailable", message: restarting ? RESTARTING_MESSAGE : UNAVAILABLE_MESSAGE };
    }

    // The server side funnel (P18-02): every started pack, and the
    // workspace's first once. Never throws.
    await recordFunnelEvent(this.db, {
      workspaceId,
      name: "pack_started",
      first: true,
      props: {
        channels: input.channels.length,
        bundle: bundleOf(output.resolved),
        mode: input.mode,
        from: input.origin ?? "upload",
      },
    });

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
   * - Frees still-unshared photo rows in releaseMediaIds (a new browser
   *   product pack inserted), so an ordinary retry can save them to its new
   *   product. A source already accepted by another pack stays registered.
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
      // Acceptance may have reused them after this job committed but before
      // enqueue failed. Decide under the same lock those writers hold, and
      // keep any uncertain ownership instead of breaking an accepted pack.
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        await tx.execute(sql`delete from source_media sm
          where sm.workspace_id = ${workspaceId}::uuid
            and sm.id = any(${`{${releaseMediaIds.join(",")}}`}::uuid[])
            and exists (select 1 from generation_jobs abandoned
              where abandoned.id = ${jobId}::uuid and abandoned.workspace_id = sm.workspace_id
                and abandoned.product_id = sm.product_id and abandoned.status = 'failed')
            and not exists (select 1 from generation_jobs j
              where j.workspace_id = sm.workspace_id and j.id <> ${jobId}::uuid
                and (j.product_id = sm.product_id or exists (
                  select 1 from (
                    select j.restart_payload -> 'brand' ->> 'logoKey' as key
                    union all select image ->> 'mediaId' from jsonb_array_elements(
                      case when jsonb_typeof(j.restart_payload -> 'images') = 'array'
                        then j.restart_payload -> 'images' else '[]'::jsonb end) image
                    union all select shot ->> 'sourceMediaId' from jsonb_array_elements(
                      case when jsonb_typeof(j.restart_payload -> 'shots') = 'array'
                        then j.restart_payload -> 'shots' else '[]'::jsonb end) shot
                  ) reference where reference.key in (sm.r2_key, sm.mask_r2_key))))
            and not exists (select 1 from share_links s where s.before_media_id = sm.id)
            and not exists (select 1 from brand_kits b where b.workspace_id = sm.workspace_id
              and b.logo_r2_key in (sm.r2_key, sm.mask_r2_key))
            and not exists (select 1 from source_media other
              where other.workspace_id = sm.workspace_id and other.id <> sm.id
                and (other.r2_key in (sm.r2_key, sm.mask_r2_key) or other.mask_r2_key in (sm.r2_key, sm.mask_r2_key)))`);
      });
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
    return productSummaryOf(row);
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
    // The upload is read back and checked before it is recorded; when the
    // check ran, its hash and upright size replace the client's.
    const checked = await this.ingest(input.r2Key, input.kind);
    if (checked && !checked.ok) {
      return { ok: false, reason: checked.retryable ? "unavailable" : "invalid_upload", notice: checked.notice };
    }
    const ingestRecord = checked?.ok ? await this.uploadIngestRecord(workspaceId, input.r2Key, checked.ingest) : null;
    // One row per uploaded object: registering the same upload again is a
    // no op, and an upload saved to another product stays there.
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        await assertSourceKeysAvailable(tx, workspaceId, [input.r2Key]);
        await this.assertSourceObjects([input.r2Key]);
        const inserted = await tx
          .insert(sourceMedia)
          .values({
            workspaceId,
            productId: input.productId,
            r2Key: input.r2Key,
            kind: input.kind,
            width: checked?.ok ? checked.width : (input.width ?? null),
            height: checked?.ok ? checked.height : (input.height ?? null),
            sha256: (checked?.ok ? checked.sha256 : null) ?? input.sha256,
            ingest: ingestColumnOf(ingestRecord),
          })
          .onConflictDoNothing({ target: [sourceMedia.workspaceId, sourceMedia.r2Key] })
          .returning({ id: sourceMedia.id });
        if (inserted.length === 0) {
          const existing = await tx.query.sourceMedia.findFirst({
            where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.r2Key, input.r2Key)),
          });
          if (existing && existing.productId !== input.productId) {
            return { ok: false, reason: "conflict", notice: "That photo is already saved to another product." };
          }
        }
        return { ok: true, notice: "Photo saved to this product." };
      });
    } catch (err) {
      if (err instanceof SourceUnavailableError) return { ok: false, reason: "invalid_upload", notice: err.message };
      throw err;
    }
  }

  async preflightUpload(workspaceId: string, input: PreflightUploadInput): Promise<PreflightOutcome> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return { ok: false, reason: "forbidden", message: "Client seats cannot upload product photos." };
    }
    if (!isWorkspaceSourceKey(workspaceId, input.key)) {
      return { ok: false, reason: "foreign_key", message: "That upload does not belong to this workspace." };
    }
    // The same server side check a pack runs on the file, before any model
    // sees it.
    const checked = await this.ingest(input.key, "image");
    if (checked && !checked.ok) {
      return checked.retryable
        ? { ok: false, reason: "unavailable", message: checked.notice }
        : { ok: false, reason: "invalid_upload", message: checked.notice };
    }
    const ingestRecord = checked?.ok ? await this.uploadIngestRecord(workspaceId, input.key, checked.ingest) : null;
    try {
      const preflight = await runPreflightUpload(this.preflightDeps(), workspaceId, input);
      await this.keepPreflightIngest(workspaceId, input.key, ingestRecord);
      return { ok: true, preflight };
    } catch (err) {
      console.error(`[preflight] could not check a photo in workspace ${workspaceId}`, err);
      return {
        ok: false,
        reason: "unavailable",
        message: "We could not check this photo right now. You can still start the pack, and it will check the photo when it runs.",
      };
    }
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
    let storedReport: unknown = null;
    const reportRow = packRows.find((p) => p.kind === "report" && p.channel === null && isWorkspaceKey(workspaceId, p.r2Key));
    if (canSign && reportRow) {
      try { const bytes = await readStoredReportBytes(reportRow.r2Key); storedReport = bytes ? JSON.parse(bytes.toString("utf8")) : null; } catch { /* Missing reports provide no fidelity claim. */ }
    }
    const files: JobFileView[] = [];
    // DbJobStore records each asset's shot id in its qc verdict (as getJob
    // reads it), so an image can carry its shot's check to an assistant.
    const shotIdByAssetId = new Map(
      assetRows.flatMap((a) => (a.qc && typeof a.qc.shotId === "string" ? [[a.id, a.qc.shotId] as const] : [])),
    );
    // Only picked files ship: an extra scene version the seller has not
    // picked is shown on its card, never in the pack's files.
    const variants = variantRows
      .filter((v) => v.picked && isWorkspaceKey(workspaceId, v.r2Key))
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
        shotId: shotIdByAssetId.get(variant.assetId) ?? null,
        fidelity: fidelityForVariant(storedReport, { ...variant, workspaceId, jobId: job.id }, assetRows.find((a) => a.id === variant.assetId)?.qc),
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

  async getJobFileDownload(workspaceId: string, jobId: string, fileId: string, options: JobFileDownloadOptions = {}): Promise<JobFileDownload | null> {
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
      if (pack?.kind === "report" && isWorkspaceKey(workspaceId, pack.r2Key)) {
        if (options.report === "snapshot") {
          const snapshot = await prepareReportSnapshot(this.db, workspaceId, job.id, pack.id);
          return snapshot ? { url: await presignDownload(snapshot.key, pack.filename), filename: pack.filename, bytes: snapshot.selected.body.length } : null;
        }
        const selected = await readSelectedReport(this.db, workspaceId, job.id, pack.id);
        if (!selected) return null;
        if (options.report === "inline") {
          return { url: null, filename: pack.filename, body: selected.body.toString("utf8"), bytes: selected.body.length };
        }
        const key = await existingReportKey(selected);
        return key ? { url: await presignDownload(key, pack.filename), filename: pack.filename } : null;
      }
      file = pack ? { r2Key: pack.r2Key, filename: pack.filename } : null;
    }
    if (!file || !isWorkspaceKey(workspaceId, file.r2Key)) {
      return null;
    }
    return { url: await presignDownload(file.r2Key, file.filename), filename: file.filename };
  }

  /** Reads the pack's stored compliance-report.json (the pack level report
   * row, inside this workspace's prefix) and returns the readable view. */
  async getComplianceReport(workspaceId: string, jobId: string): Promise<ComplianceReportView | null> {
    if (!isUuid(jobId)) {
      return null;
    }
    const job = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
    });
    if (!job) {
      return null;
    }
    const product = await this.db.query.products.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, job.productId), eq(t.workspaceId, workspaceId)),
    });
    const meta = { jobId: job.id, productTitle: product?.title ?? "Untitled product" };
    if (!servesFiles(job)) {
      return unavailableComplianceReport(meta, REPORT_NOT_READY);
    }
    // A Keep pack's white required files had their background removed for
    // that file only, and the report says so.
    const keptBackground = readStoredOutputOptions(job.outputOptions)?.background === "keep";
    const selected = await readSelectedReport(this.db, workspaceId, job.id).catch(() => null);
    const view = selected ? buildComplianceReportView(selected.report, meta, { keptBackground }) : null;
    if (!view) {
      console.error(`[jobs] compliance report for job ${job.id} has no readable saved checks`);
      return unavailableComplianceReport(meta, REPORT_NOT_STORED);
    }
    return view;
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
    // A kit saved before "auto" existed keeps its preset; anything unknown
    // reads as auto, which lets the planner pick from the product.
    const stylePreset =
      row?.stylePreset && Object.hasOwn(presets, row.stylePreset) ? row.stylePreset : AUTO_STYLE_PRESET;
    return {
      name: row?.name ?? "Default",
      colors: row?.colors ?? [],
      // Kits saved before the font list held free text; a name that matches
      // a catalog font reads as that font, anything else as the default.
      fonts: {
        heading: normalizeFontChoice(row?.fonts?.heading) ?? "",
        body: normalizeFontChoice(row?.fonts?.body) ?? "",
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
    // A newly uploaded logo gets the same server side check as a product
    // photo, metadata strip included.
    if (input.logoKey && input.logoKey !== existing?.logoR2Key) {
      const checked = await this.ingest(input.logoKey, "image");
      if (checked && !checked.ok) {
        return { ok: false, notice: checked.notice };
      }
    }
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        const existing = await tx.query.brandKits.findFirst({ where: (t, { eq }) => eq(t.workspaceId, workspaceId) });
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
        const keys = values.logoR2Key ? [values.logoR2Key] : [];
        await assertSourceKeysAvailable(tx, workspaceId, keys);
        await this.assertSourceObjects(keys);
        if (!existing) {
          await tx.insert(brandKits).values({ workspaceId, ...values });
        } else {
          await tx
            .update(brandKits)
            .set(values)
            .where(and(eq(brandKits.id, existing.id), eq(brandKits.workspaceId, workspaceId)));
        }
        return { ok: true, notice: "Brand kit saved." };
      });
    } catch (err) {
      if (err instanceof SourceUnavailableError) return { ok: false, notice: err.message };
      throw err;
    }
  }

  /** PHASE_16 workstream 7: the same role, prefix and plan checks as
   * saving the kit, and the same server side check of the upload, before
   * the worker runtime reads the logo. Suggestion only; nothing is saved. */
  async suggestBrandPalette(workspaceId: string, logoKey: string): Promise<BrandPaletteOutcome> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return { ok: false, reason: "forbidden", notice: "Only owners, admins and editors can change the brand kit." };
    }
    if (!isWorkspaceSourceKey(workspaceId, logoKey)) {
      return { ok: false, reason: "foreign_key", notice: brandKitCopy.paletteMissing };
    }
    const workspace = await this.db.query.workspaces.findFirst({ where: (t, { eq }) => eq(t.id, workspaceId) });
    const allowance = checkBrandKitEntitlement(tierKeyOf(workspace?.plan), 0, false);
    if (!allowance.ok) {
      return { ok: false, reason: "upgrade_required", notice: allowance.message };
    }
    const checked = await this.ingest(logoKey, "image");
    if (checked && !checked.ok) {
      return { ok: false, reason: checked.retryable ? "unavailable" : "invalid_upload", notice: checked.notice };
    }
    try {
      const run = await (this.deps.brandPalette ?? defaultBrandPaletteRun)({
        requestId: crypto.randomUUID(),
        workspaceId,
        logoKey,
      });
      if (run.costMicros > 0) {
        console.info(`[brand-palette] workspace ${workspaceId} palette namer spend ${run.costMicros} micros`);
      }
      return brandPaletteOutcomeOf(run);
    } catch (err) {
      console.error(`[brand-palette] could not read a logo in workspace ${workspaceId}`, err);
      return { ok: false, reason: "unavailable", notice: brandKitCopy.paletteUnavailable };
    }
  }

  /** Favorite asset ids among these, for this workspace. */
  private async favoriteAssetIds(workspaceId: string, assetIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) {
      return new Set();
    }
    const rows = await this.db.query.favorites.findMany({
      columns: { assetId: true },
      where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.assetId, ids)),
    });
    return new Set(rows.map((row) => row.assetId));
  }

  async getReusePrefill(workspaceId: string, jobId: string): Promise<ReusePrefill | null> {
    if (!isUuid(jobId)) {
      return null;
    }
    const job = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
    });
    if (!job) {
      return null;
    }
    return reusePrefillOf({
      id: job.id,
      productId: job.productId,
      mode: job.mode ?? null,
      channels: job.channels ?? null,
      outputOptions: job.outputOptions,
      sellerAnswers: job.sellerAnswers,
      sellerNote: job.sellerNote,
      createdAt: job.createdAt,
    });
  }

  /**
   * The library's images: the workspace's delivered assets, newest first,
   * each shown from its first picked file. The scan reads at most
   * LIBRARY_SCAN_LIMIT assets (favorites only reads the favorites), then
   * the filters apply and one page is signed.
   */
  async listLibrary(workspaceId: string, filters: GalleryFilters): Promise<LibraryView> {
    const favoriteIds = filters.favorites
      ? [
          ...(await this.db.query.favorites.findMany({
            columns: { assetId: true },
            where: (t, { eq }) => eq(t.workspaceId, workspaceId),
          })),
        ].map((row) => row.assetId)
      : null;
    if (favoriteIds && favoriteIds.length === 0) {
      return { items: [], facets: { channels: [], shotTypes: [] }, truncated: false };
    }
    const assetRows = await this.db.query.assets.findMany({
      where: (t, { and, eq, inArray }) =>
        and(
          eq(t.workspaceId, workspaceId),
          eq(t.approved, true),
          ...(favoriteIds ? [inArray(t.id, favoriteIds)] : []),
        ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: LIBRARY_SCAN_LIMIT,
    });
    if (assetRows.length === 0) {
      return { items: [], facets: { channels: [], shotTypes: [] }, truncated: false };
    }
    const jobIds = [...new Set(assetRows.map((a) => a.jobId))];
    const assetIds = assetRows.map((a) => a.id);
    const [jobRows, variantRows, favored] = await Promise.all([
      this.db.query.generationJobs.findMany({
        columns: { id: true, productId: true, status: true, creditsCharged: true },
        where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.id, jobIds)),
      }),
      this.db.query.assetVariants.findMany({
        where: (t, { and, eq, inArray }) =>
          and(eq(t.workspaceId, workspaceId), eq(t.picked, true), inArray(t.assetId, assetIds)),
      }),
      this.favoriteAssetIds(workspaceId, assetIds),
    ]);
    // Files are served only for a finished or charged pack (servesFiles).
    const serving = jobRows.filter((job) => servesFiles(job));
    const productIds = [...new Set(serving.map((job) => job.productId))];
    const productRows =
      productIds.length > 0
        ? await this.db.query.products.findMany({
            columns: { id: true, title: true },
            where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.id, productIds)),
          })
        : [];
    const titles = new Map(productRows.map((p) => [p.id, p.title ?? "Untitled product"]));
    const titleOfJob = new Map(serving.map((job) => [job.id, titles.get(job.productId) ?? "Untitled product"]));
    const all = galleryItemsOf({
      assets: assetRows.filter((a) => titleOfJob.has(a.jobId)),
      variants: variantRows.filter((v) => isWorkspaceKey(workspaceId, v.r2Key)),
      productTitleOfJob: titleOfJob,
      favoriteAssetIds: favored,
    });
    const filtered = filterGallery(all, filters);
    const page = filtered.slice(0, LIBRARY_PAGE_SIZE);
    const canSign = isR2Configured();
    const items = await Promise.all(
      page.map(async ({ r2Key, variantId, ...item }) => {
        if (!canSign) {
          return item;
        }
        let imageUrl: string | null = null;
        try {
          imageUrl = await presignObjectGet(r2Key);
        } catch {
          imageUrl = null;
        }
        return { ...item, imageUrl, downloadUrl: fileDownloadPath(item.jobId, `v_${variantId}`) };
      }),
    );
    return {
      items,
      facets: galleryFacets(all),
      truncated: filtered.length > page.length || assetRows.length >= LIBRARY_SCAN_LIMIT,
    };
  }

  async setFavorite(workspaceId: string, assetId: string, favorite: boolean): Promise<FavoriteResult> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return { outcome: "rejected", reason: "role_forbidden", message: CLIENT_SEAT_MESSAGE };
    }
    if (!isUuid(assetId)) {
      return { outcome: "rejected", reason: "not_found", message: ASSET_NOT_FOUND };
    }
    const asset = await this.db.query.assets.findFirst({
      columns: { id: true },
      where: (t, { and, eq }) => and(eq(t.id, assetId), eq(t.workspaceId, workspaceId)),
    });
    if (!asset) {
      return { outcome: "rejected", reason: "not_found", message: ASSET_NOT_FOUND };
    }
    try {
      if (favorite) {
        const userId = await this.deps.getUserId();
        await this.db
          .insert(favorites)
          .values({ workspaceId, assetId, createdBy: userId ?? null })
          .onConflictDoNothing({ target: [favorites.workspaceId, favorites.assetId] });
      } else {
        await this.db
          .delete(favorites)
          .where(and(eq(favorites.workspaceId, workspaceId), eq(favorites.assetId, assetId)));
      }
    } catch (err) {
      console.error(`[favorites] could not save a favorite in workspace ${workspaceId}`, err);
      return { outcome: "rejected", reason: "unavailable", message: "We could not save that favorite. Try again." };
    }
    return { outcome: "saved", favorite };
  }

  /**
   * Picks or unpicks one version of a scene on a delivered pack. Its files
   * are flagged together (asset_variants.picked). Picking is refused when a
   * channel has no room left for it. The channel zips of the channels it
   * touches no longer match the picked files, so their rows go, as after a
   * follow up; the all files zip and the file list read asset_variants and
   * stay right. Runs under the workspace row lock, so two picks at once
   * never both take a channel's last slot. Never touches the ledger.
   */
  async pickShotVersion(workspaceId: string, jobId: string, shotId: string, picked: boolean): Promise<VersionPickResult> {
    const role = await this.currentRole(workspaceId);
    if (role === null || role === "client") {
      return { outcome: "rejected", reason: "role_forbidden", message: CLIENT_SEAT_MESSAGE };
    }
    const job = isUuid(jobId)
      ? await this.db.query.generationJobs.findFirst({
          where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
        })
      : undefined;
    if (!job) {
      return { outcome: "rejected", reason: "not_found", message: "This pack does not exist in your workspace." };
    }
    if (job.status !== "done") {
      return { outcome: "rejected", reason: "not_ready", message: VERSION_COPY.notReady };
    }
    type Refusal = Extract<VersionPickResult, { outcome: "rejected" }>;
    let refusal: Refusal | null = null;
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        const assetRows = await tx.query.assets.findMany({
          where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspaceId), eq(t.approved, true)),
          orderBy: (t, { asc }) => [asc(t.createdAt)],
        });
        // The newest passing asset of each shot, as the board shows it.
        const assetOfShot = new Map<string, string>();
        for (const row of assetRows) {
          const id = row.qc && typeof row.qc.shotId === "string" ? row.qc.shotId : null;
          if (id) assetOfShot.set(id, row.id);
        }
        const versions = shotVersionsOf([...assetOfShot.keys()], () => undefined);
        const assetId = assetOfShot.get(shotId);
        if (!assetId) {
          refusal = { outcome: "rejected", reason: "not_found", message: "This shot has no files in this pack." };
          return;
        }
        if (!versions.has(shotId)) {
          refusal = { outcome: "rejected", reason: "not_a_version", message: VERSION_COPY.notAVersion };
          return;
        }
        const jobAssetIds = [...assetOfShot.values()];
        const variantRows = await tx.query.assetVariants.findMany({
          where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.assetId, jobAssetIds)),
        });
        const own = variantRows.filter((v) => v.assetId === assetId);
        if (own.length === 0) {
          refusal = { outcome: "rejected", reason: "not_found", message: "This shot has no files in this pack." };
          return;
        }
        if (picked) {
          const pickedOnSpec = new Map<string, number>();
          for (const v of variantRows) {
            if (v.assetId !== assetId && v.picked) {
              pickedOnSpec.set(v.channelSpecId, (pickedOnSpec.get(v.channelSpecId) ?? 0) + 1);
            }
          }
          const full = overLimitSpec(
            own.map((v) => v.channelSpecId),
            pickedOnSpec,
          );
          if (full) {
            refusal = { outcome: "rejected", reason: "channel_full", message: VERSION_COPY.channelFull(full) };
            return;
          }
        }
        await tx
          .update(assetVariants)
          .set({ picked })
          .where(and(eq(assetVariants.workspaceId, workspaceId), eq(assetVariants.assetId, assetId)));
        const channels = [...new Set(own.map((v) => v.channelSpecId.split(".")[0]))];
        await tx
          .delete(packFiles)
          .where(
            and(
              eq(packFiles.jobId, job.id),
              eq(packFiles.workspaceId, workspaceId),
              eq(packFiles.kind, "zip"),
              inArray(packFiles.channel, channels),
            ),
          );
      });
    } catch (err) {
      console.error(`[versions] could not pick a version on job ${job.id}`, err);
      return { outcome: "rejected", reason: "unavailable", message: VERSION_COPY.failed };
    }
    if (refusal) {
      return refusal;
    }
    const view = await this.getJob(workspaceId, job.id);
    return view
      ? { outcome: "saved", job: view }
      : { outcome: "rejected", reason: "not_found", message: "This pack does not exist in your workspace." };
  }

  async listMembers(workspaceId: string): Promise<MemberView[]> {
    if ((await this.currentRole(workspaceId)) === null) return [];
    const result = await this.db.execute(sql`
      select m.user_id, m.role, u.email from members m
      left join auth.users u on u.id = m.user_id
      where m.workspace_id = ${workspaceId}::uuid order by m.created_at, m.user_id`);
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{ user_id: string; role: WorkspaceRole; email: string | null }>;
    return rows.map((row) => ({ id: row.user_id, label: row.email?.trim() || `Member ${row.user_id.slice(0, 8)}`, role: row.role }));
  }

  async listIntegrations(workspaceId: string): Promise<IntegrationView[]> {
    const rows = await this.db.query.integrations.findMany({
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    });
    const kinds: IntegrationView["kind"][] = ["shopify", "amazon"];
    return kinds.map((kind) => {
      const row = rows.find((r) => r.kind === kind);
      if (row?.encryptedToken) {
        return { kind, status: "connected", detail: "Connected." };
      }
      return { kind, status: "not_connected", ...(kind === "shopify" ? SHOPIFY_NOT_CONNECTED : AMAZON_NOT_CONNECTED) };
    });
  }
}
