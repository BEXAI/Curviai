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

export type ShotStatus = "pending" | "generating" | "qc" | "done" | "failed" | "needs_review";

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
}

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
  /** Failure detail when status is failed. */
  error?: string | null;
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
        | "unavailable";
      message: string;
    };

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
  name: string;
  /** Channel family, e.g. "amazon"; null for the pack level report. */
  channel: string | null;
  specId: string | null;
  kind: "image" | "zip" | "report";
  bytes: number | null;
  /** Signed download url, valid for 15 minutes; null when files are not
   * stored (demo mode or R2 unset). */
  url: string | null;
}

export interface JobFilesView {
  jobId: string;
  status: JobStatus;
  files: JobFileView[];
  notice?: string;
}

export interface SaveResult {
  ok: boolean;
  notice: string;
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
  /** Delivered files for a finished job, with signed download urls. */
  listJobFiles(workspaceId: string, jobId: string): Promise<JobFilesView | null>;
  createProduct(workspaceId: string, input: CreateProductInput): Promise<ProductSummary | null>;
  /** Records an uploaded source file against a product after the R2 PUT. */
  registerSourceMedia(workspaceId: string, input: RegisterSourceMediaInput): Promise<SaveResult>;
  getBrandKit(workspaceId: string): Promise<BrandKitView>;
  saveBrandKit(workspaceId: string, kit: BrandKitView): Promise<SaveResult>;
  listMembers(workspaceId: string): Promise<MemberView[]>;
  listIntegrations(workspaceId: string): Promise<IntegrationView[]>;
}
