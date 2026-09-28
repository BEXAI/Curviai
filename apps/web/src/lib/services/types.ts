/**
 * The service layer contract. Every page and API route reads and writes data
 * through this interface. getServices() in ./index picks DemoService when no
 * database is configured and DbService when DATABASE_URL plus Supabase exist.
 * This file stays free of server only imports so client components can share
 * the view types.
 */

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

export interface ProductSummary {
  id: string;
  title: string;
  mode: PackMode;
  category: string;
  createdAt: string;
}

export interface ShotCompliance {
  pass: boolean;
  /** Measured product fill as a percentage of the frame, when the channel has a fill rule. */
  fillPct: number | null;
  /** Measured background color, when the channel has a background rule. */
  background: [number, number, number] | null;
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
  /** How the board names the angle an add_photo card waits for, e.g. "back". */
  angle?: string | null;
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
  /** True when the signed in member may cancel the pack, run shots again or
   * add photos (every role but client seats). */
  canManage?: boolean;
  /** True while shots run again on a pack that was already delivered: its
   * files stay available and only the new shots are held. */
  followUpRunning?: boolean;
}

export interface JobSummary {
  id: string;
  productTitle: string;
  status: JobStatus;
  creditsReserved: number;
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
}

export interface CreateJobInput {
  /** An existing product id, or "new" to create one from this pack. */
  productId: string;
  channels: string[];
  mode: PackMode;
  idempotencyKey: string;
  /** R2 objects uploaded for this pack; registered as source media in db mode. */
  uploads?: Array<{ key: string; sha256: string; kind: "image" | "video" }>;
  /** Title for the product created when productId is "new". */
  newProductTitle?: string;
  /** Seller notes passed to the analyzer as untrusted description text. */
  userDescription?: string;
}

export type CreateJobResult =
  | { outcome: "created"; job: JobView }
  | { outcome: "replayed"; job: JobView }
  /** existingJobId is only present when the caller may see that job. */
  | { outcome: "conflict"; existingJobId?: string }
  | {
      outcome: "rejected";
      reason:
        | "unknown_product"
        | "insufficient_credits"
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
        | "mode_unavailable";
      message: string;
    };

/** Why a retry or an added photo was refused. Routes map each to a status:
 * not_found 404, role_forbidden 403, foreign_key 403, not_ready 409,
 * not_retryable 409, channel_full 409, conflict 409, insufficient_credits
 * 402, unavailable 503, demo 400. */
export type ShotOpRejection =
  | "not_found"
  | "role_forbidden"
  | "foreign_key"
  | "not_ready"
  | "not_retryable"
  | "channel_full"
  | "conflict"
  | "insufficient_credits"
  | "unavailable"
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
}

export interface JobFilesView {
  jobId: string;
  status: JobStatus;
  files: JobFileView[];
  notice?: string;
}

export interface JobFileDownload {
  url: string;
  filename: string;
}

export interface SaveResult {
  ok: boolean;
  notice: string;
  /** Why a save was refused, so routes can answer with the right status:
   * forbidden 403, unknown_product 404, foreign_key 403, conflict 409,
   * upgrade_required 402 (the plan does not include it). */
  reason?: "forbidden" | "unknown_product" | "foreign_key" | "conflict" | "upgrade_required";
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
  listProducts(workspaceId: string): Promise<ProductSummary[]>;
  getProduct(workspaceId: string, productId: string): Promise<ProductSummary | null>;
  listRecentJobs(workspaceId: string, limit?: number): Promise<JobSummary[]>;
  /** Reading a job advances the demo simulation by one tick. */
  getJob(workspaceId: string, jobId: string): Promise<JobView | null>;
  createJob(workspaceId: string, input: CreateJobInput): Promise<CreateJobResult>;
  /** Cancels a running pack: owner, admin and editor only. Stops remaining
   * shots at the runner's next checkpoint and returns every credit held for
   * shots that were not delivered. */
  cancelJob(workspaceId: string, jobId: string): Promise<CancelJobResult>;
  /** Runs one shot that needs review again on a delivered pack, holding its
   * credits by the pack rules and returning them if it does not pass. */
  retryShot(workspaceId: string, jobId: string, shotId: string): Promise<ShotOpResult>;
  /** Adds the photo a skipped "needs photo" shot waits for, then plans and
   * runs the shots it unlocks on the delivered pack. */
  addShotPhoto(workspaceId: string, jobId: string, shotId: string, input: AddShotPhotoInput): Promise<ShotOpResult>;
  /** Delivered files for a finished job, with previews and download links. */
  listJobFiles(workspaceId: string, jobId: string): Promise<JobFilesView | null>;
  /** A freshly signed download url for one delivered file of a job in this
   * workspace, or null when the file does not exist or is not stored. */
  getJobFileDownload(workspaceId: string, jobId: string, fileId: string): Promise<JobFileDownload | null>;
  createProduct(workspaceId: string, input: CreateProductInput): Promise<ProductSummary | null>;
  /** Records an uploaded source file against a product after the R2 PUT. */
  registerSourceMedia(workspaceId: string, input: RegisterSourceMediaInput): Promise<SaveResult>;
  getBrandKit(workspaceId: string): Promise<BrandKitView>;
  saveBrandKit(workspaceId: string, kit: BrandKitView): Promise<SaveResult>;
  listMembers(workspaceId: string): Promise<MemberView[]>;
  listIntegrations(workspaceId: string): Promise<IntegrationView[]>;
}
