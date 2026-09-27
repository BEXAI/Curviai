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

export type ShotStatus = "pending" | "generating" | "qc" | "done" | "failed";

export type PackMode = "listing" | "concept";

export interface WorkspaceSummary {
  id: string;
  name: string;
  plan: string;
  creditBalance: number;
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
  productId: string;
  channels: string[];
  mode: PackMode;
  idempotencyKey: string;
}

export type CreateJobResult =
  | { outcome: "created"; job: JobView }
  | { outcome: "replayed"; job: JobView }
  | { outcome: "conflict"; existingJobId: string }
  | { outcome: "rejected"; reason: "unknown_product" | "insufficient_credits"; message: string };

export interface SaveResult {
  ok: boolean;
  notice: string;
}

export interface Services {
  readonly mode: ServiceMode;
  /** The caller's workspace, or null when nobody is signed in (db mode only). */
  getCurrentWorkspace(): Promise<WorkspaceSummary | null>;
  listProducts(workspaceId: string): Promise<ProductSummary[]>;
  getProduct(workspaceId: string, productId: string): Promise<ProductSummary | null>;
  listRecentJobs(workspaceId: string, limit?: number): Promise<JobSummary[]>;
  /** Reading a job advances the demo simulation by one tick. */
  getJob(workspaceId: string, jobId: string): Promise<JobView | null>;
  createJob(workspaceId: string, input: CreateJobInput): Promise<CreateJobResult>;
  getBrandKit(workspaceId: string): Promise<BrandKitView>;
  saveBrandKit(workspaceId: string, kit: BrandKitView): Promise<SaveResult>;
  listMembers(workspaceId: string): Promise<MemberView[]>;
  listIntegrations(workspaceId: string): Promise<IntegrationView[]>;
}
