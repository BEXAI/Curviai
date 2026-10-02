/**
 * The service layer contract. Every page and API route reads and writes data
 * through this interface. getServices() in ./index picks DemoService when no
 * database is configured and DbService when DATABASE_URL plus Supabase exist.
 * This file stays free of server only imports so client components can share
 * the view types.
 */

import type { StoredFidelity } from "@curvi/pipeline/fidelity-record";
import type { FileProofView } from "@/lib/proof-view";
import type { OutputOptionsInput, PhotoBackgroundChoice } from "@curvi/pipeline/output-options";
import type { ComplianceReportView } from "@/lib/compliance-report";
import type { OutputOptionsSummary } from "@/lib/job-copy";
import type { BrandPaletteOutcome } from "@/lib/brand/types";
import type { GalleryFilters, GalleryItem } from "@/lib/library";
import type { ReusePrefill } from "@/lib/reuse";
import type { PreflightBox, PreflightOutcome } from "@/lib/preflight/types";
import type { SellerAnswer, SellerProfile } from "@/lib/seller-profile";
import type { CreditBudgetView } from "@/lib/billing/credit-planning";

export type {
  ComplianceCheckView,
  ComplianceFileView,
  ComplianceReportView,
} from "@/lib/compliance-report";

export type ServiceMode = "demo" | "db";

export type JobStatus =
  | "queued"
  | "analyzing"
  | "planning"
  | "generating"
  | "qc"
  | "packaging"
  | "done"
  | "failed"
  | "canceled";

/** "skipped" is a shot the planner left out, shown with its reason. A shot
 * that did not pass is "needs_review": released at no charge, never shown
 * as failed. */
export type ShotStatus = "pending" | "generating" | "qc" | "done" | "failed" | "needs_review" | "skipped";

export type PackMode = "listing" | "concept";

export type WorkspaceRole = "owner" | "admin" | "editor" | "client";

export interface WorkspaceSummary {
  id: string;
  name: string;
  plan: string;
  creditBalance: number;
  /** The signed in member's role. The client role reads assets but cannot
   * generate or bill (plan 4.3). */
  role: WorkspaceRole;
}

/** The role a seller gave a photo (@curvi/pipeline/seller-inputs). */
export type PhotoAngle = "front" | "back" | "side" | "detail" | "in_the_box" | "scale";

export interface ProductSummary {
  id: string;
  title: string;
  mode: PackMode;
  category: string;
  createdAt: string;
  /** The seller's SKU, used to name delivered files. */
  sku: string | null;
  /** What is in the box, one printable line per item. */
  boxContents: string[];
  /** Comparison facts the seller can back up, one printable line each. */
  comparisonFacts: string[];
  /** Press quotes or awards for the A+ endorsement module, one printable line
   * each (PHASE_16 workstream 2). Absent reads as none. */
  endorsements?: string[];
  /** Stored photos a pack of this product would run on, capped at
   * MAX_PACK_PHOTOS. Set by listProducts, so the form can estimate a Keep
   * pack that sends no new uploads. */
  storedPhotoCount?: number;
  /** The seller's last choices for this product (products.output_defaults,
   * PHASE_15 P1), for the form's prefill only. Set by listProducts. */
  outputDefaults?: Record<string, unknown> | null;
}

/** One pack in a product's history. */
export interface ProductPackView {
  id: string;
  status: JobStatus;
  channels: string[];
  createdAt: string;
  creditsReserved: number;
  creditsCharged: number;
}

/** A product in the library with its photos and its packs, newest first. */
export interface ProductLibraryEntry extends ProductSummary {
  photoCount: number;
  packs: ProductPackView[];
}

export interface ShotCompliance {
  pass: boolean;
  /** Measured product fill as a percentage of the frame, when the channel has a fill rule. */
  fillPct: number | null;
  /** Measured background color, when the channel has a background rule. */
  background: [number, number, number] | null;
  /** The color inside the product measured on the shot's file (P18-08):
   * null when nothing was measured, absent on views built before it. */
  fidelity?: StoredFidelity | null;
  /** Each delivered file's measured proof, for "See the proof" (P18-16).
   * Absent for shots saved before Phase 18. */
  files?: FileProofView[];
}

export interface JobShotView {
  shotId: string;
  shotType: string;
  /** Neutral provider stage label, e.g. "image model" or "template engine". */
  providerStage: string;
  status: ShotStatus;
  channels: string[];
  credits: number;
  compliance: ShotCompliance | null;
  /** Short lived signed URL of the generated image, when one is stored. */
  imageUrl?: string | null;
  /** Same origin link that downloads this shot's file under its channel
   * file name, signing a fresh url on every click (Update.md 6.6). */
  downloadUrl?: string | null;
  /** Chip text that overrides the status label, e.g. "Needs photo". */
  label?: string | null;
  /** Plain spoken reason for a skipped or needs review shot. */
  note?: string | null;
  /** What the seller can do with this card on a delivered pack: run a shot
   * that needs review again, or add the photo a skipped shot waits for. */
  action?: ShotAction | null;
  /** A delivered scene whose original photo is still available. */
  regenerate?: { credits: number };
  /** How the board names the angle an add_photo card waits for, e.g. "back". */
  angle?: string | null;
  /** The delivered asset behind a finished card, for favorites (PHASE_16
   * workstream 6). Absent before the pack serves files. */
  assetId?: string | null;
  /** The asset is in the workspace's favorites. */
  favorite?: boolean;
  /** Set on every version of a lifestyle scene made in more than one
   * version: which version this card is (1 is the scene itself) and whether
   * its files ship. */
  version?: ShotVersionView | null;
  /** Pixel size of the preview file, for its true aspect ratio. */
  width?: number | null;
  height?: number | null;
}

export interface ShotVersionView {
  number: number;
  /** The shot id of the scene itself, shared by all its versions. */
  sceneShotId: string;
  picked: boolean;
}

export type ShotAction = "retry" | "add_photo";

export interface JobView {
  id: string;
  productId: string;
  productTitle: string;
  status: JobStatus;
  mode: PackMode;
  channels: string[];
  creditsReserved: number;
  creditsCharged: number;
  createdAt: string;
  shots: JobShotView[];
  /** Plain spoken failure line when status is failed. Raw worker errors
   * never reach the client. */
  error?: string | null;
  /** Short lived signed URL of the seller's original photo for the before
   * and after reveal. Set only once the pack serves files and the photo is
   * stored; null or absent hides the reveal. */
  sourceImageUrl?: string | null;
  /** True when the signed in member may cancel the pack, run shots again or
   * add photos (every role but client seats). */
  canManage?: boolean;
  /** True while shots run again on a pack that was already delivered: its
   * files stay available and only the new shots are held. */
  followUpRunning?: boolean;
  /** What the product inventory found in each photo, in photo order, and
   * which product the pack featured. Null or absent when none ran. */
  inventory?: InventoryPhotoView[] | null;
  /** The "Your choices" card: the look and one line per choice
   * (outputOptionsSummary in lib/job-copy.ts). Absent when the stored
   * options could not be read. */
  outputOptions?: OutputOptionsSummary;
  /** True when a deploy stopped the pack mid run and it started again
   * (generation_jobs.restart_count, P18-23): the page says so once. */
  restarted?: boolean;
  /** Queue position contains no other workspace identifiers. */
  queue?: { position: number; etaSeconds: number };
}

/** One product the inventory found in a photo, as the pack page lists it. */
export interface InventoryItemView {
  label: string;
  color: string;
  shape: string;
  status: "featured" | "removed" | "kept";
}

export interface InventoryPhotoView {
  items: InventoryItemView[];
  /** The short reason the vision picker gave, when it chose the featured
   * product because the rules alone could not. */
  pickedReason?: string | null;
}

export interface JobSummary {
  id: string;
  productTitle: string;
  status: JobStatus;
  creditsReserved: number;
  /** What the pack charged once it settled; 0 while it runs. */
  creditsCharged: number;
  createdAt: string;
}

export interface BrandKitView {
  name: string;
  colors: string[];
  fonts: { heading: string; body: string };
  stylePreset: string;
  hasLogo: boolean;
  /** Signed preview URL of the stored logo, read side only. */
  logoUrl?: string | null;
  /** R2 key of the uploaded logo to persist, write side only. */
  logoKey?: string | null;
}

export interface MemberView {
  id: string;
  label: string;
  role: string;
}

export interface IntegrationView {
  kind: "shopify" | "amazon";
  status: "connected" | "not_connected";
  detail: string;
  /** A help link shown after the detail, for a row that is not connected. */
  link?: { href: string; label: string };
}

export interface CreateJobInput {
  /** An existing product id, or "new" to create one from this pack. */
  productId: string;
  channels: string[];
  mode: PackMode;
  idempotencyKey: string;
  /** R2 objects uploaded for this pack; registered as source media in db
   * mode. angle is the role the seller picked for a photo. */
  uploads?: Array<{
    key: string;
    sha256: string;
    kind: "image" | "video";
    angle?: PhotoAngle;
    /** The product the seller tapped in the chooser, saved as
     * source_media.target_box and sent to the runner as the photo's target. */
    targetBox?: PreflightBox;
    /** Background per photo (PHASE_15 P1), resolved into keepMediaIds:
     * pack (or absent) follows the pack's switch. */
    background?: PhotoBackgroundChoice;
  }>;
  /** Title for the product created when productId is "new". */
  newProductTitle?: string;
  /** Seller notes passed to the analyzer as untrusted description text. */
  userDescription?: string;
  /** Saved on the product. Undefined keeps what the product has; an empty
   * string or list clears it. */
  sku?: string;
  boxContents?: string[];
  comparisonFacts?: string[];
  /** Press quotes or awards the A+ endorsement module prints as typed. */
  endorsements?: string[];
  /** The seller's output options (PHASE_15). Absent means today's pack. */
  outputOptions?: OutputOptionsInput;
  /** The question step's taps (PHASE_16 workstream 4): the upload the
   * questions were asked about and question id to option value. Resolved
   * against the questions stored for that upload; absent or skipped means
   * the note alone. */
  sellerAnswers?: { key: string; picks: Record<string, string> };
  /** The question step's answers from a caller with no upload preflight
   * (the v1 API and MCP, PHASE_16 workstream 5): seed choice values by
   * question kind, resolved against the seed's full choices. Used only
   * when sellerAnswers is absent. */
  answers?: { channels?: string; mood?: string };
  /** The most credits the pack may hold (PHASE_19 P19-16): the smaller of
   * an assistant's signed estimate and its max_credits. A pack whose hold
   * would be larger is refused with over_max_credits before anything is
   * written or reserved. Absent (the web form, the REST API) means no cap. */
  maxCredits?: number;
  /** Earlier Idempotency-Keys a retry of this same request may have used
   * (PHASE_19 P19-16: an assistant's derived key of the previous 10 minute
   * window). A matching receipt replays first. A provably different request
   * is skipped, but a legacy receipt whose input cannot be verified returns
   * a conflict rather than risking another credit hold. */
  previousIdempotencyKeys?: string[];
  /** "assistant" for a pack started through /api/mcp (PHASE_19 P19-29):
   * the worker then stops it at intake when the product is one of OpenAI's
   * prohibited goods, with nothing charged. Absent (the web form, the REST
   * API) keeps today's behavior. */
  audience?: "assistant";
  /** Where the pack was started from, for the server side funnel's
   * pack_started step (docs/phases/PHASE_18.md P18-02). Absent is the web
   * form. */
  origin?: PackOrigin;
}

/** Why createJob refused a pack. */
export type CreateJobRejectionReason =
  | "maintenance"
  | "workspace_day_cap"
  | "empty_plan"
  | "unknown_product"
  | "insufficient_credits"
  | "credit_budget_exceeded"
  | "role_forbidden"
  | "needs_photo"
  | "no_media"
  /** A requested feature is not live yet (for example video). */
  | "feature_unavailable"
  /** A requested feature is live but not in the workspace's plan. */
  | "upgrade_required"
  /** Not a credit problem: the database or the queue failed. Retry. */
  | "unavailable"
  /** The requested mode is not offered yet (Concept Mode). */
  | "mode_unavailable"
  /** An upload failed the server side ingest check (wrong type,
   * over a cap, unreadable). The seller uploads a different file. */
  | "invalid_upload"
  /** The output options name something that is not there, such as a
   * brand color the kit no longer has. The seller picks again. */
  | "invalid_options"
  /** The hold is larger than input.maxCredits (PHASE_19 P19-16). */
  | "over_max_credits";

export interface CreateJobRejection {
  outcome: "rejected";
  reason: CreateJobRejectionReason;
  message: string;
  /** insufficient_credits and over_max_credits: what the pack would hold
   * (PHASE_19 P19-14), so an assistant can say both numbers. */
  creditsNeeded?: number;
  /** insufficient_credits: the workspace's balance when it was refused. */
  creditsAvailable?: number;
  /** over_max_credits: the cap the request named. */
  maxCredits?: number;
}

/** upload: the web form; import: a product link (P18-11); preview: a
 * claimed free preview (P18-12); claim: a prospect claim (P18-04); api: the
 * v1 API or MCP. */
export type PackOrigin = "upload" | "import" | "preview" | "claim" | "api";

export type CreateJobResult =
  | { outcome: "created"; job: JobView }
  | { outcome: "replayed"; job: JobView }
  /** existingJobId is only present when the caller may see that job. */
  | { outcome: "conflict"; existingJobId?: string }
  | CreateJobRejection;

/** Internal upload ownership receipt, passed separately from request data.
 * The caller starts false. The service sets true before persistence may
 * publish a source key, because a commit can succeed while its acknowledgment
 * fails. Once true, request cleanup must never delete those objects, even on
 * rejection or an unexpected exception. Normal retention collects any
 * unreferenced objects left by a rolled-back transaction. */
export interface CreateJobLifecycle {
  retainUploads: boolean;
}

/**
 * What estimateJob reads (PHASE_19 P19-16): a createJob request whose photos
 * are not stored. Each upload names the key and hash createJob would get for
 * the same photo, with the upright size the server side ingest records, so
 * the estimate plans exactly what the hold plans.
 */
export interface EstimateJobInput
  extends Omit<CreateJobInput, "idempotencyKey" | "uploads" | "maxCredits" | "previousIdempotencyKeys" | "sellerAnswers"> {
  uploads?: Array<{
    key: string;
    sha256: string;
    kind: "image";
    angle?: PhotoAngle;
    width: number | null;
    height: number | null;
  }>;
}

/** A requested channel spec the estimated pack would not make. coming_soon:
 * its images do not ship yet (0 credits); not_made: no image is planned for
 * it with these photos and choices, for example a kept photo too small for
 * the channel. */
export interface EstimateLeftOut {
  specId: string;
  reason: "coming_soon" | "not_made";
}

export type EstimateJobResult =
  | {
      outcome: "estimated";
      /** Exactly what createJob would hold for the same request. */
      creditsNeeded: number;
      /** The workspace's balance now. */
      creditsAvailable: number;
      /** Current owner budget headroom; reservation rechecks it under the workspace lock. */
      creditBudget?: CreditBudgetView;
      /** The requested specs the pack would make files for. */
      channels: string[];
      leftOut: EstimateLeftOut[];
    }
  | CreateJobRejection;

/** Why a retry or an added photo was refused. Routes map each to a status:
 * not_found 404, role_forbidden 403, foreign_key 403, not_ready 409,
 * not_retryable 409, channel_full 409, conflict 409, insufficient_credits
 * 402, unavailable 503, invalid_upload 422, demo 400. */
export type ShotOpRejection =
  | "not_found"
  | "role_forbidden"
  | "foreign_key"
  | "not_ready"
  | "not_retryable"
  | "channel_full"
  | "conflict"
  | "insufficient_credits"
  | "credit_budget_exceeded"
  | "unavailable"
  | "invalid_upload"
  | "demo";

export type ShotOpResult =
  | { outcome: "started"; job: JobView; creditsHeld: number }
  | { outcome: "rejected"; reason: ShotOpRejection; message: string };

export interface AddShotPhotoInput {
  /** The uploaded photo, inside this workspace's source prefix. */
  key: string;
  sha256: string;
}

export type CancelJobResult =
  /** The pack stopped before anything was delivered. */
  | { outcome: "canceled"; job: JobView; refundedCredits: number; notice: string }
  /** The pack was delivered (its first run, or shots running again on it):
   * what still ran was stopped and its hold returned. */
  | { outcome: "stopped"; job: JobView; refundedCredits: number; notice: string }
  /** The pack had already finished; nothing changed. */
  | { outcome: "finished"; job: JobView; notice: string }
  | { outcome: "rejected"; reason: "not_found" | "role_forbidden" | "unavailable"; message: string };

export interface CreateProductInput {
  title: string;
  mode: PackMode;
}

export interface RegisterSourceMediaInput {
  productId: string;
  r2Key: string;
  kind: "image" | "video";
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
}

/** The photo the preflight at upload checks, and the note it reads. */
export interface PreflightUploadInput {
  key: string;
  note?: string;
}

export interface JobFileView {
  /** Stable id for the download route: "v_<asset variant id>" or
   * "p_<pack file id>". */
  id: string;
  name: string;
  /** Channel family, e.g. "amazon"; null for the pack level report. */
  channel: string | null;
  specId: string | null;
  kind: "image" | "zip" | "report";
  bytes: number | null;
  /** Preview url for images (signed for an hour, or an inline demo image);
   * null for zips and reports, or when files are not stored. */
  url: string | null;
  /** Same origin download link that signs a fresh url on every click and
   * names the file; null when files are not stored (demo mode or R2 unset). */
  downloadUrl: string | null;
  /** The shot that made an image, so an assistant's view can carry its
   * channel check (PHASE_19 P19-14). Null or absent for zips, the report
   * and files whose shot is not recorded. */
  shotId?: string | null;
  /** Only the QC report for these exact delivered bytes, never a shot aggregate. */
  fidelity?: StoredFidelity | null;
}

export interface JobFilesView {
  jobId: string;
  status: JobStatus;
  files: JobFileView[];
  notice?: string;
}

export interface JobFileDownload {
  url: string | null;
  filename: string;
  /** Fresh selected JSON for an explicit browser download. */
  body?: string;
  bytes?: number;
}

export interface JobFileDownloadOptions {
  /** Defaults to readOnly: never create objects while listing MCP tools. */
  report?: "inline" | "snapshot" | "readOnly";
}

export interface SaveResult {
  ok: boolean;
  notice: string;
  /** Why a save was refused, so routes can answer with the right status:
   * forbidden 403, unknown_product 404, foreign_key 403, conflict 409,
   * upgrade_required 402 (the plan does not include it), invalid_upload 422
   * (the upload failed the server side ingest check), unavailable 503 (that
   * check could not run; retry). */
  reason?:
    | "forbidden"
    | "unknown_product"
    | "foreign_key"
    | "conflict"
    | "upgrade_required"
    | "invalid_upload"
    | "unavailable";
}

/** Favorites (PHASE_16 workstream 6). not_found 404, role_forbidden 403,
 * unavailable 503, demo 400. */
export type FavoriteResult =
  | { outcome: "saved"; favorite: boolean }
  | { outcome: "rejected"; reason: "not_found" | "role_forbidden" | "unavailable" | "demo"; message: string };

/** Picking which versions of a scene ship. not_found 404, role_forbidden
 * 403, not_ready 409, not_a_version 409, channel_full 409, unavailable 503,
 * demo 400. */
export type VersionPickResult =
  | { outcome: "saved"; job: JobView }
  | {
      outcome: "rejected";
      reason: "not_found" | "role_forbidden" | "not_ready" | "not_a_version" | "channel_full" | "unavailable" | "demo";
      message: string;
    };

/** /app/library: the workspace's delivered images, newest first. */
export interface LibraryView {
  items: GalleryItem[];
  /** Filter choices over every listed image, before the filters apply. */
  facets: {
    channels: Array<{ value: string; label: string }>;
    shotTypes: Array<{ value: string; label: string }>;
  };
  /** True when more images exist than one page lists. */
  truncated: boolean;
}

/** Internal read policy. Snapshot callers must not recover jobs, settle
 * credits or advance demo work as a side effect of retrieving a result. */
export interface ServiceReadOptions {
  reconcile?: boolean;
}

export interface Services {
  readonly mode: ServiceMode;
  /** The caller's workspace, or null when nobody is signed in (db mode only). */
  getCurrentWorkspace(): Promise<WorkspaceSummary | null>;
  /**
   * The caller's workspace, bootstrapping one when a signed in user has none
   * (safety net behind the auth.users trigger). Null only when signed out.
   */
  ensureWorkspace(): Promise<WorkspaceSummary | null>;
  /** Renames the workspace. Owner and admin only in db mode. */
  renameWorkspace(workspaceId: string, name: string): Promise<SaveResult>;
  /** The first run answers (P18-20), or null when none were saved. */
  getSellerProfile(workspaceId: string): Promise<SellerProfile | null>;
  /** Saves the first run answers (P18-20). Owners, admins and editors in db
   * mode; the answer is already checked against the seed. */
  saveSellerProfile(workspaceId: string, answer: SellerAnswer): Promise<SaveResult>;
  listProducts(workspaceId: string): Promise<ProductSummary[]>;
  /** The products library: every product with its photo count and pack
   * history, newest product first. */
  listProductLibrary(workspaceId: string): Promise<ProductLibraryEntry[]>;
  getProduct(workspaceId: string, productId: string): Promise<ProductSummary | null>;
  listRecentJobs(workspaceId: string, limit?: number): Promise<JobSummary[]>;
  /** Default reads recover stale jobs and advance the demo simulation.
   * reconcile: false returns the current snapshot without either effect. */
  getJob(workspaceId: string, jobId: string, options?: ServiceReadOptions): Promise<JobView | null>;
  createJob(workspaceId: string, input: CreateJobInput, lifecycle?: CreateJobLifecycle): Promise<CreateJobResult>;
  /** What createJob would hold for the same request, the balance and the
   * channels left out, without creating a product, photo, job or hold
   * (PHASE_19 P19-16, estimate_pack). Default balance reads recover stale
   * jobs; reconcile: false leaves jobs and credits unchanged.
   * Refuses exactly as createJob refuses before its hold. */
  estimateJob(workspaceId: string, input: EstimateJobInput, options?: ServiceReadOptions): Promise<EstimateJobResult>;
  /** The workspace's credit balance, or null when the caller is not a
   * member of it (PHASE_19 P19-16). Never the "current" workspace: an
   * assistant names the workspace its connection is bound to. */
  workspaceBalance(workspaceId: string): Promise<number | null>;
  /** Cancels a running pack: owner, admin and editor only. Stops remaining
   * shots at the runner's next checkpoint and returns every credit held for
   * shots that were not delivered. */
  cancelJob(workspaceId: string, jobId: string): Promise<CancelJobResult>;
  /** Runs one shot that needs review again on a delivered pack, holding its
   * credits by the pack rules and returning them if it does not pass. */
  retryShot(workspaceId: string, jobId: string, shotId: string): Promise<ShotOpResult>;
  regenerateShot(workspaceId: string, jobId: string, shotId: string): Promise<ShotOpResult>;
  /** Adds the photo a skipped "needs photo" shot waits for, then plans and
   * runs the shots it unlocks on the delivered pack. */
  addShotPhoto(workspaceId: string, jobId: string, shotId: string, input: AddShotPhotoInput): Promise<ShotOpResult>;
  /** Delivered files for a finished job, with previews and download links. */
  listJobFiles(workspaceId: string, jobId: string): Promise<JobFilesView | null>;
  /** A freshly signed download url for one delivered file of a job in this
   * workspace, or null when the file does not exist or is not stored. */
  getJobFileDownload(workspaceId: string, jobId: string, fileId: string, options?: JobFileDownloadOptions): Promise<JobFileDownload | null>;
  /** The readable compliance report of a job in this workspace, or null
   * when the job does not exist there. A job whose report is not ready or
   * not stored answers a view with available false and a notice. */
  getComplianceReport(workspaceId: string, jobId: string): Promise<ComplianceReportView | null>;
  createProduct(workspaceId: string, input: CreateProductInput): Promise<ProductSummary | null>;
  /** Records an uploaded source file against a product after the R2 PUT. */
  registerSourceMedia(workspaceId: string, input: RegisterSourceMediaInput): Promise<SaveResult>;
  /** Checks an uploaded photo before any pack or credit hold
   * (docs/phases/PHASE_14.md workstream 4): intake, moderation, the product
   * inventory with the chooser, and the size gate. Demo mode simulates it. */
  preflightUpload(workspaceId: string, input: PreflightUploadInput): Promise<PreflightOutcome>;
  getBrandKit(workspaceId: string): Promise<BrandKitView>;
  /** True when packs may carry output options other than today's pack: the
   * NEXT_PUBLIC_OUTPUT_OPTIONS flag is on and, in db mode, the
   * ops:output_options_enabled operator switch too (cached briefly per
   * process, docs/phases/PHASE_20.md P20-20). */
  outputOptionsEnabled(): Promise<boolean>;
  saveBrandKit(workspaceId: string, kit: BrandKitView): Promise<SaveResult>;
  /** Suggests brand colors from an uploaded logo (PHASE_16 workstream 7).
   * Owners, admins and editors on a plan with a brand kit; the logo key
   * must sit in this workspace's source prefix. Never saves the kit: the
   * seller confirms the suggestion and saves through saveBrandKit. */
  suggestBrandPalette(workspaceId: string, logoKey: string): Promise<BrandPaletteOutcome>;
  listMembers(workspaceId: string): Promise<MemberView[]>;
  listIntegrations(workspaceId: string): Promise<IntegrationView[]>;
  /** "Make this pack again" (PHASE_16 workstream 6): a pack's channels,
   * options, answers and note for the new pack form's prefill, or null when
   * the job is not in this workspace. Reads only; never starts a pack. */
  getReusePrefill(workspaceId: string, jobId: string): Promise<ReusePrefill | null>;
  /** The workspace's delivered images for /app/library, picked files only,
   * filtered, newest first, at most LIBRARY_PAGE_SIZE. */
  listLibrary(workspaceId: string, filters: GalleryFilters): Promise<LibraryView>;
  /** Adds an asset of this workspace to its favorites, or removes it.
   * Owners, admins and editors. */
  setFavorite(workspaceId: string, assetId: string, favorite: boolean): Promise<FavoriteResult>;
  /** Picks or unpicks one version of a lifestyle scene on a delivered pack:
   * a picked version's files ship (the all files zip, the file list, the
   * share page), an unpicked one's do not. Owners, admins and editors.
   * Never charges: every version was charged when it was made. */
  pickShotVersion(workspaceId: string, jobId: string, shotId: string, picked: boolean): Promise<VersionPickResult>;
}
