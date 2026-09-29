/**
 * DemoService: the in memory implementation that powers zero env development
 * and e2e runs. Reads are deterministic fixture data. The mutations are job
 * creation, which starts a simulated pack that advances one state per poll
 * of getJob, so the progress board is alive without any provider or
 * database, and canceling that simulated pack. Everything else is read only.
 */

import { createHash } from "node:crypto";
import {
  backgroundFor,
  canvasSizeFor,
  originalFitFor,
  originalScale,
  outputOptionsKey,
  rgbToHex,
  type ResolvedOutputOptions,
} from "@curvi/pipeline/output-options";
import type { Shot } from "@curvi/pipeline/schemas";
import { backgroundSwatches, entitlementsFor, stillStyle, tierByKey, type TierKey } from "@curvi/pipeline/seed";
import { isAngleRole, printableSellerLines } from "@curvi/pipeline/seller-inputs";
import type { PackAssetTreatment } from "@curvi/pipeline/treatment";
import { filenameFor, getSpec, requiresWhiteBackground } from "@curvi/specs";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import { beforeDemoImage } from "@/components/marketing/demo-images";
import type { BrandPaletteOutcome } from "@/lib/brand/types";
import {
  demoComplianceReport,
  REPORT_NOT_READY,
  unavailableComplianceReport,
  type ComplianceReportView,
} from "@/lib/compliance-report";
import { checkChannelEntitlements } from "@/lib/entitlements";
import { CONCEPT_MODE_AVAILABLE, outputOptionsAvailable } from "@/lib/features";
import { outputOptionsSummary } from "@/lib/job-copy";
import { demoPreflight } from "@/lib/preflight/demo";
import type { PreflightOutcome } from "@/lib/preflight/types";
import { MAX_PACK_PHOTOS } from "@/lib/validation/seller-inputs";
import { planDemoShots } from "./demo-plan";
import { outputDefaultsFor } from "./output-defaults";
import {
  INVALID_OPTIONS_MESSAGE,
  outputEstimateInputs,
  photoBackgroundsOf,
  resolveJobOutput,
  type OutputPhoto,
} from "./output-options";
import { cancelNotice } from "./shot-ops";
import type {
  AddShotPhotoInput,
  BrandKitView,
  CancelJobResult,
  CreateJobInput,
  CreateJobResult,
  CreateProductInput,
  IntegrationView,
  JobFileDownload,
  JobFilesView,
  JobFileView,
  JobShotView,
  JobStatus,
  JobSummary,
  JobView,
  MemberView,
  ProductLibraryEntry,
  ProductSummary,
  PreflightUploadInput,
  RegisterSourceMediaInput,
  SaveResult,
  Services,
  ShotCompliance,
  ShotOpResult,
  ShotStatus,
  WorkspaceSummary,
} from "./types";

export const DEMO_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_WORKSPACE_NAME = "Demo Workspace";
export const DEMO_TIER: TierKey = "growth";

const READ_ONLY_NOTICE =
  "Demo mode is read only. Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and DATABASE_URL to save changes.";

/** Polls spent in the generating and qc window of the simulation. */
const GENERATING_POLLS = 4;

const DEMO_PRODUCTS: ProductSummary[] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    title: "Juniper glass water bottle",
    mode: "listing",
    category: "home_kitchen",
    createdAt: "2026-09-20T09:00:00.000Z",
    sku: "JUNIPER-750",
    boxContents: ["Glass bottle", "Bamboo lid", "Silicone sleeve"],
    comparisonFacts: [],
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    title: "Trailhead merino running socks",
    mode: "listing",
    category: "apparel",
    createdAt: "2026-09-22T14:30:00.000Z",
    sku: null,
    boxContents: [],
    comparisonFacts: [],
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    title: "Lumen fold flat desk lamp",
    mode: "concept",
    category: "electronics",
    createdAt: "2026-09-25T11:15:00.000Z",
    sku: null,
    boxContents: [],
    comparisonFacts: [],
  },
];

const DEMO_BRAND_KIT: BrandKitView = {
  name: "Default",
  colors: ["#1D2433", "#FD7F11", "#F6F7F9"],
  fonts: { heading: "", body: "" },
  stylePreset: "minimal_studio",
  hasLogo: false,
};

const DEMO_MEMBERS: MemberView[] = [
  { id: "00000000-0000-4000-8000-000000000201", label: "You", role: "owner" },
  { id: "00000000-0000-4000-8000-000000000202", label: "Demo teammate", role: "editor" },
];

const DEMO_INTEGRATIONS: IntegrationView[] = [
  { kind: "shopify", status: "not_connected", detail: "Connect a store to get auto packs for new products." },
  { kind: "amazon", status: "not_connected", detail: "Amazon publishing arrives after launch. Packs download to convention names today." },
];

interface DemoJobRecord {
  id: string;
  productId: string;
  channels: string[];
  mode: CreateJobInput["mode"];
  idempotencyKey: string;
  bodyHash: string;
  createdAt: string;
  creditsReserved: number;
  shots: Shot[];
  /** The pack's resolved output options, as db mode stores them. */
  output: ResolvedOutputOptions;
  /** Photos the pack ran on. */
  photoCount: number;
  /** How many times getJob has observed this job. Drives the simulation. */
  polls: number;
  /** The poll count at which the seller canceled it; the simulation stops
   * there and its hold goes back to the balance. */
  canceledAt?: number;
}

/** Shared in memory state. Lives on globalThis so every route bundle in one
 * server process sees the same jobs. */
export class DemoStore {
  readonly jobs = new Map<string, DemoJobRecord>();
  readonly jobIdByIdempotencyKey = new Map<string, string>();
  readonly extraProducts: ProductSummary[] = [];
  /** Seller inputs saved by demo packs, over the fixture values. */
  readonly productEdits = new Map<string, Pick<ProductSummary, "sku" | "boxContents" | "comparisonFacts" | "outputDefaults">>();
  /** Photos each demo pack uploaded, per product. */
  readonly photoCounts = new Map<string, number>();
  /** Rename override for the demo workspace; null keeps the default name. */
  workspaceName: string | null = null;
  private counter = 0;

  nextJobId(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-9${String(this.counter).padStart(11, "0")}`;
  }

  nextProductId(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-8${String(this.counter).padStart(11, "0")}`;
  }
}

const globalScope = globalThis as typeof globalThis & { __curviDemoStore?: DemoStore };

export function getDemoStore(): DemoStore {
  globalScope.__curviDemoStore ??= new DemoStore();
  return globalScope.__curviDemoStore;
}

/** The request body a replay must match. The options count by their
 * canonical key, so no options and explicit defaults are the same body, and
 * a concept pack's options always read as the defaults. The uploads' own
 * backgrounds (P1) count too, as in db mode's replay, and only when some
 * upload has one, so a body without them hashes as before. Throws on
 * options the schema refuses. */
export function hashBody(
  input: Pick<CreateJobInput, "productId" | "channels" | "mode" | "outputOptions" | "uploads">,
): string {
  const options = outputOptionsKey(input.mode === "concept" ? null : (input.outputOptions ?? null));
  const own = input.mode === "concept" ? {} : photoBackgroundsOf(input.uploads);
  const backgrounds = Object.entries(own)
    .filter(([, choice]) => choice !== "pack")
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(
      JSON.stringify({
        productId: input.productId,
        channels: [...input.channels].sort(),
        mode: input.mode,
        options,
        ...(backgrounds.length > 0 ? { backgrounds } : {}),
      }),
    )
    .digest("hex");
}

function providerStageFor(method: Shot["method"]): string {
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
  }
}

function complianceFor(shot: Shot): ShotCompliance {
  for (const channelId of shot.channels) {
    try {
      const spec = getSpec(channelId);
      if (spec.fill || spec.background) {
        return {
          pass: true,
          fillPct: spec.fill ? Math.round(((spec.fill.min + spec.fill.max) / 2) * 100) : null,
          background: spec.background?.rgb ?? null,
        };
      }
    } catch {
      // Unknown channel on a demo shot: fall through to the generic badge.
    }
  }
  return { pass: true, fillPct: null, background: null };
}

interface ShotTimeline {
  generatingAt: number;
  qcAt: number;
  doneAt: number;
}

function shotTimeline(index: number, count: number): ShotTimeline {
  const generatingAt = 3 + Math.floor((index * GENERATING_POLLS) / Math.max(count, 1));
  return { generatingAt, qcAt: generatingAt + 1, doneAt: generatingAt + 2 };
}

function shotStatusAt(polls: number, timeline: ShotTimeline): ShotStatus {
  if (polls < timeline.generatingAt) return "pending";
  if (polls < timeline.qcAt) return "generating";
  if (polls < timeline.doneAt) return "qc";
  return "done";
}

function recordStatus(record: DemoJobRecord): JobStatus {
  return record.canceledAt !== undefined ? "canceled" : jobStatusAt(record.polls, record.shots);
}

function jobStatusAt(polls: number, shots: Shot[]): JobStatus {
  if (polls <= 0) return "queued";
  if (polls === 1) return "analyzing";
  if (polls === 2) return "planning";
  const count = shots.length;
  if (count === 0) return "done";
  const maxDoneAt = Math.max(...shots.map((_, i) => shotTimeline(i, count).doneAt));
  if (polls >= maxDoneAt + 1) return "done";
  if (polls >= maxDoneAt) return "packaging";
  const statuses = shots.map((_, i) => shotStatusAt(polls, shotTimeline(i, count)));
  return statuses.every((s) => s === "qc" || s === "done") ? "qc" : "generating";
}

function projectJob(record: DemoJobRecord, productTitle: string): JobView {
  const count = record.shots.length;
  const status = recordStatus(record);
  const polls = record.canceledAt ?? record.polls;
  const shots: JobShotView[] = record.shots.map((shot, i) => {
    const reached = shotStatusAt(polls, shotTimeline(i, count));
    // A canceled simulation delivers nothing: unfinished shots were not made.
    const shotStatus = record.canceledAt !== undefined && reached !== "done" ? "pending" : reached;
    return {
      shotId: shot.id,
      shotType: shot.type,
      providerStage: providerStageFor(shot.method),
      status: shotStatus,
      channels: shot.channels,
      credits: shot.credits,
      compliance: shotStatus === "done" ? complianceFor(shot) : null,
      // The same inline drawing the files list previews, so the before and
      // after reveal works with zero stored files.
      imageUrl: shotStatus === "done" ? demoShotImage(shot.type, shot.channels[0], record.output) : null,
    };
  });
  return {
    id: record.id,
    productId: record.productId,
    productTitle,
    status,
    mode: record.mode,
    channels: record.channels,
    creditsReserved: record.creditsReserved,
    creditsCharged: status === "done" ? record.creditsReserved : 0,
    createdAt: record.createdAt,
    shots,
    // Demo packs have no stored photo: the reveal uses the labeled
    // illustration the marketing site shows, never a fake seller photo.
    sourceImageUrl: status === "done" ? beforeDemoImage : null,
    canManage: true,
    followUpRunning: false,
    outputOptions: outputOptionsSummary(record.output, { specIds: record.channels, photoCount: record.photoCount }),
  };
}

const DEMO_FOLLOW_UP_MESSAGE =
  "Demo packs cannot run shots again. Connect a database and storage to use this on a real pack.";

export class DemoService implements Services {
  readonly mode = "demo" as const;

  constructor(
    private readonly store: DemoStore = getDemoStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private balance(): number {
    const grant = tierByKey(DEMO_TIER).creditsPerMonth;
    let held = 0;
    for (const record of this.store.jobs.values()) {
      // A canceled simulation returned its hold.
      if (record.canceledAt === undefined) {
        held += record.creditsReserved;
      }
    }
    return grant - held;
  }

  async getCurrentWorkspace(): Promise<WorkspaceSummary> {
    return {
      id: DEMO_WORKSPACE_ID,
      name: this.store.workspaceName ?? DEMO_WORKSPACE_NAME,
      plan: DEMO_TIER,
      creditBalance: this.balance(),
      role: "owner",
    };
  }

  async ensureWorkspace(): Promise<WorkspaceSummary> {
    return this.getCurrentWorkspace();
  }

  async renameWorkspace(_workspaceId: string, name: string): Promise<SaveResult> {
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) {
      return { ok: false, notice: "Workspace name cannot be empty." };
    }
    this.store.workspaceName = trimmed;
    return { ok: true, notice: "Workspace name saved for this demo session." };
  }

  /** Every product with the seller inputs demo packs saved on it. */
  private allProducts(): ProductSummary[] {
    return [...this.store.extraProducts, ...DEMO_PRODUCTS].map((p) => ({
      ...p,
      ...(this.store.productEdits.get(p.id) ?? {}),
    }));
  }

  async listProducts(_workspaceId: string): Promise<ProductSummary[]> {
    return this.allProducts().map((product) => ({
      ...product,
      storedPhotoCount: Math.min(this.storedPhotoCount(product.id), MAX_PACK_PHOTOS),
    }));
  }

  /** Photos a product holds: fixture products stand for a product
   * photographed once, plus what demo packs uploaded. */
  private storedPhotoCount(productId: string): number {
    const fixture = DEMO_PRODUCTS.some((p) => p.id === productId) ? 1 : 0;
    return fixture + (this.store.photoCounts.get(productId) ?? 0);
  }

  async listProductLibrary(_workspaceId: string): Promise<ProductLibraryEntry[]> {
    const records = [...this.store.jobs.values()].reverse();
    return this.allProducts().map((product) => {
      const packs = records
        .filter((record) => record.productId === product.id)
        .map((record) => {
          const view = projectJob(record, product.title);
          return {
            id: view.id,
            status: view.status,
            channels: view.channels,
            createdAt: view.createdAt,
            creditsReserved: view.creditsReserved,
            creditsCharged: view.creditsCharged,
          };
        });
      return { ...product, photoCount: this.storedPhotoCount(product.id), packs };
    });
  }

  async getProduct(_workspaceId: string, productId: string): Promise<ProductSummary | null> {
    return this.allProducts().find((p) => p.id === productId) ?? null;
  }

  async createProduct(_workspaceId: string, input: CreateProductInput): Promise<ProductSummary> {
    const product: ProductSummary = {
      id: this.store.nextProductId(),
      title: input.title,
      mode: input.mode,
      category: "other",
      createdAt: this.now().toISOString(),
      sku: null,
      boxContents: [],
      comparisonFacts: [],
    };
    this.store.extraProducts.unshift(product);
    return product;
  }

  /** A simulated preflight: no provider is called and nothing is stored. */
  async preflightUpload(_workspaceId: string, input: PreflightUploadInput): Promise<PreflightOutcome> {
    return { ok: true, preflight: demoPreflight(input.key, input.note) };
  }

  async registerSourceMedia(_workspaceId: string, _input: RegisterSourceMediaInput): Promise<SaveResult> {
    return {
      ok: true,
      notice: "Demo mode noted the upload. Files are stored once R2 is configured.",
    };
  }

  async listJobFiles(_workspaceId: string, jobId: string): Promise<JobFilesView | null> {
    const record = this.store.jobs.get(jobId);
    if (!record) {
      return null;
    }
    const status = recordStatus(record);
    if (status !== "done") {
      return { jobId, status, files: [] };
    }
    const files: JobFileView[] = [];
    const counters = new Map<string, number>();
    const channels = new Set<string>();
    // A real pack delivers one file per channel a shot is made for, so a
    // shot shared by several channels lists one file for each of them.
    for (const shot of record.shots) {
      shot.channels.forEach((specId, index) => {
        const spec = tryGetSpec(specId);
        if (!spec) {
          return;
        }
        const channel = specId.split(".")[0];
        channels.add(channel);
        const n = (counters.get(specId) ?? 0) + 1;
        counters.set(specId, n);
        files.push({
          id: demoFileId(shot.id, index),
          name: demoFileName(specId, n),
          channel,
          specId,
          kind: "image",
          bytes: null,
          url: demoShotImage(shot.type, specId, record.output),
          downloadUrl: null,
        });
      });
    }
    for (const channel of channels) {
      files.push({
        id: `demo_zip_${channel}`,
        name: `${channel}.zip`,
        channel,
        specId: null,
        kind: "zip",
        bytes: null,
        url: null,
        downloadUrl: null,
      });
    }
    files.push({
      id: "demo_report",
      name: "compliance-report.json",
      channel: null,
      specId: null,
      kind: "report",
      bytes: null,
      url: null,
      downloadUrl: null,
    });
    return {
      jobId,
      status,
      files,
      notice:
        "Demo mode renders previews only. Zip and report downloads switch on once R2 and a database are configured.",
    };
  }

  /** Demo packs store no files, so the report lists each file with the
   * checks its channel applies and says nothing was measured. */
  async getComplianceReport(workspaceId: string, jobId: string): Promise<ComplianceReportView | null> {
    const record = this.store.jobs.get(jobId);
    if (!record) {
      return null;
    }
    const meta = { jobId, productTitle: this.productTitle(record.productId) };
    const view = await this.listJobFiles(workspaceId, jobId);
    if (!view || view.status !== "done") {
      return unavailableComplianceReport(meta, REPORT_NOT_READY);
    }
    const images = view.files.filter((file) => file.kind === "image" && file.specId);
    const shotsByFileId = new Map(
      record.shots.flatMap((shot) => shot.channels.map((_, index) => [demoFileId(shot.id, index), shot] as const)),
    );
    return demoComplianceReport(
      meta,
      images.map((file) => {
        const shot = shotsByFileId.get(file.id);
        const specId = file.specId as string;
        return { name: file.name, specId, treatment: shot ? demoTreatment(shot, specId, record.output) : null };
      }),
      { keptBackground: record.output.background === "keep" },
    );
  }

  /** Demo packs keep no stored files, so there is never anything to sign. */
  async getJobFileDownload(_workspaceId: string, _jobId: string, _fileId: string): Promise<JobFileDownload | null> {
    return null;
  }

  async listRecentJobs(_workspaceId: string, limit = 10): Promise<JobSummary[]> {
    const records = [...this.store.jobs.values()].reverse().slice(0, limit);
    return records.map((record) => ({
      id: record.id,
      productTitle: this.productTitle(record.productId),
      status: recordStatus(record),
      creditsReserved: record.creditsReserved,
      createdAt: record.createdAt,
    }));
  }

  async getJob(_workspaceId: string, jobId: string): Promise<JobView | null> {
    const record = this.store.jobs.get(jobId);
    if (!record) {
      return null;
    }
    if (record.canceledAt === undefined) {
      record.polls += 1;
    }
    return projectJob(record, this.productTitle(record.productId));
  }

  /** Cancels the simulated pack before it finishes; its whole hold goes
   * back, since a demo pack charges only once it is done. */
  async cancelJob(_workspaceId: string, jobId: string): Promise<CancelJobResult> {
    const record = this.store.jobs.get(jobId);
    if (!record) {
      return { outcome: "rejected", reason: "not_found", message: "This pack does not exist in your workspace." };
    }
    const title = this.productTitle(record.productId);
    const status = recordStatus(record);
    if (status === "done" || status === "failed" || status === "canceled") {
      return { outcome: "finished", job: projectJob(record, title), notice: cancelNotice("finished", 0) };
    }
    record.canceledAt = record.polls;
    return {
      outcome: "canceled",
      job: projectJob(record, title),
      refundedCredits: record.creditsReserved,
      notice: cancelNotice("canceled", record.creditsReserved),
    };
  }

  async retryShot(_workspaceId: string, jobId: string, _shotId: string): Promise<ShotOpResult> {
    return this.store.jobs.has(jobId)
      ? { outcome: "rejected", reason: "demo", message: DEMO_FOLLOW_UP_MESSAGE }
      : { outcome: "rejected", reason: "not_found", message: "This pack does not exist in your workspace." };
  }

  async addShotPhoto(
    _workspaceId: string,
    jobId: string,
    _shotId: string,
    _input: AddShotPhotoInput,
  ): Promise<ShotOpResult> {
    return this.retryShot(_workspaceId, jobId, _shotId);
  }

  async createJob(_workspaceId: string, input: CreateJobInput): Promise<CreateJobResult> {
    // A replay must match the body as sent: "new" stays "new" in the hash,
    // so a retry of a new product pack replays instead of making another.
    let bodyHash: string;
    try {
      bodyHash = hashBody(input);
    } catch {
      return { outcome: "rejected", reason: "invalid_options", message: INVALID_OPTIONS_MESSAGE };
    }
    const existingId = this.store.jobIdByIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.store.jobs.get(existingId);
      if (existing && existing.bodyHash === bodyHash) {
        return { outcome: "replayed", job: projectJob(existing, this.productTitle(existing.productId)) };
      }
      return { outcome: "conflict", existingJobId: existingId };
    }

    if (input.mode === "concept" && !CONCEPT_MODE_AVAILABLE) {
      return {
        outcome: "rejected",
        reason: "mode_unavailable",
        message: "Concept Mode is not available yet. Start a Listing Mode pack from a real photo.",
      };
    }

    // The same seed entitlement check as db mode, so the demo never starts a
    // pack production would refuse (video channels while video is coming soon).
    const entitled = checkChannelEntitlements(input.channels, DEMO_TIER);
    if (!entitled.ok) {
      return { outcome: "rejected", reason: entitled.reason, message: entitled.message };
    }

    // Products made through /api/products live in extraProducts (Update.md 6.7).
    const existingProduct =
      input.productId === "new" ? null : (this.allProducts().find((p) => p.id === input.productId) ?? null);
    if (input.productId !== "new" && !existingProduct) {
      return { outcome: "rejected", reason: "unknown_product", message: "That product does not exist in this workspace." };
    }

    // The seller inputs the product will hold after this pack, as in db mode:
    // a field the request sent replaces the saved one.
    const sellerInputs = {
      sku: input.sku !== undefined ? input.sku.trim() || null : (existingProduct?.sku ?? null),
      boxContents:
        input.boxContents !== undefined ? printableSellerLines(input.boxContents) : (existingProduct?.boxContents ?? []),
      comparisonFacts:
        input.comparisonFacts !== undefined
          ? printableSellerLines(input.comparisonFacts)
          : (existingProduct?.comparisonFacts ?? []),
    };
    const photos = (input.uploads ?? []).filter((u) => u.kind === "image");

    // The pack's photos as db mode merges them: this request's uploads, or
    // the product's stored photos (synthetic ids here, since the demo
    // stores none). Sizes are unknown, so every photo is taken to fit.
    const storedCount = existingProduct ? Math.min(this.storedPhotoCount(existingProduct.id), MAX_PACK_PHOTOS) : 0;
    const packPhotos: OutputPhoto[] =
      photos.length > 0
        ? photos.slice(0, MAX_PACK_PHOTOS).map((u) => ({ id: u.key, angle: isAngleRole(u.angle) ? u.angle : null }))
        : Array.from({ length: storedCount }, (_, i) => ({ id: `demo_photo_${i + 1}` }));
    const output = resolveJobOutput({
      input: input.outputOptions,
      mode: input.mode,
      enabled: outputOptionsAvailable(),
      brandColors: DEMO_BRAND_KIT.colors,
      brandKitsAllowed: entitlementsFor(DEMO_TIER).brandKits > 0,
      photos: packPhotos,
      photoBackgrounds: photoBackgroundsOf(photos),
    });
    if (!output.ok) {
      return { outcome: "rejected", reason: output.reason, message: output.message };
    }

    const balance = this.balance();
    const shots = planDemoShots(input.channels, DEMO_TIER, input.mode, {
      angles: photos.flatMap((u) => (isAngleRole(u.angle) ? [u.angle] : [])),
      boxContents: sellerInputs.boxContents,
      comparisonFacts: sellerInputs.comparisonFacts,
      output: outputEstimateInputs(output.resolved, packPhotos),
    });
    const creditsReserved = Math.ceil(shots.reduce((sum, shot) => sum + shot.credits, 0));
    if (creditsReserved <= 0 || creditsReserved > balance) {
      return {
        outcome: "rejected",
        reason: "insufficient_credits",
        message:
          creditsReserved <= 0
            ? "This selection plans no shots. Pick at least one channel."
            : "Not enough credits for this pack. Top up or pick fewer channels.",
      };
    }

    // A new product is created only once the pack is accepted, as in db mode.
    const product =
      existingProduct ??
      (await this.createProduct(DEMO_WORKSPACE_ID, {
        title: input.newProductTitle?.trim() || "New product",
        mode: input.mode,
      }));
    // The choice is remembered on the product for the form's prefill, as in db mode.
    const remembered = outputDefaultsFor(input) ?? this.store.productEdits.get(product.id)?.outputDefaults;
    this.store.productEdits.set(product.id, { ...sellerInputs, ...(remembered ? { outputDefaults: remembered } : {}) });
    if (photos.length > 0) {
      this.store.photoCounts.set(product.id, (this.store.photoCounts.get(product.id) ?? 0) + photos.length);
    }

    const record: DemoJobRecord = {
      id: this.store.nextJobId(),
      productId: product.id,
      channels: input.channels,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
      bodyHash,
      createdAt: this.now().toISOString(),
      creditsReserved,
      shots,
      output: output.resolved,
      photoCount: packPhotos.length,
      polls: 0,
    };
    this.store.jobs.set(record.id, record);
    this.store.jobIdByIdempotencyKey.set(input.idempotencyKey, record.id);
    return { outcome: "created", job: projectJob(record, product.title) };
  }

  async getBrandKit(_workspaceId: string): Promise<BrandKitView> {
    return DEMO_BRAND_KIT;
  }

  /** The demo has no platform_settings table, so the env flag decides. */
  async outputOptionsEnabled(): Promise<boolean> {
    return outputOptionsAvailable();
  }

  async saveBrandKit(_workspaceId: string, _kit: BrandKitView): Promise<SaveResult> {
    return { ok: false, notice: READ_ONLY_NOTICE };
  }

  /** The demo stores no uploads, so there is no logo to read. */
  async suggestBrandPalette(_workspaceId: string, _logoKey: string): Promise<BrandPaletteOutcome> {
    return { ok: false, reason: "unavailable", notice: brandKitCopy.paletteUnavailable };
  }

  async listMembers(_workspaceId: string): Promise<MemberView[]> {
    return DEMO_MEMBERS;
  }

  async listIntegrations(_workspaceId: string): Promise<IntegrationView[]> {
    return DEMO_INTEGRATIONS;
  }

  private productTitle(productId: string): string {
    return this.allProducts().find((p) => p.id === productId)?.title ?? "Product";
  }
}

function tryGetSpec(specId: string): ReturnType<typeof getSpec> | null {
  try {
    return getSpec(specId);
  } catch {
    return null;
  }
}

/** A demo file's id: the shot's first channel keeps the plain id. */
function demoFileId(shotId: string, index: number): string {
  return index === 0 ? `demo_${shotId}` : `demo_${shotId}_${index}`;
}

function demoFileName(specId: string, n: number): string {
  const spec = tryGetSpec(specId);
  if (spec?.naming) {
    try {
      return filenameFor(spec, { sku: "DEMO123", seoSlug: "demo-product", n });
    } catch {
      // Fall through to the generic name.
    }
  }
  return `${specId.replaceAll(".", "_")}_${String(n).padStart(2, "0")}.jpg`;
}

/** The photo a demo pack stands for: a 12 megapixel phone photo. */
export const DEMO_PHOTO_SIZE = { width: 4032, height: 3024 } as const;

/** Shot types drawn as the cut out product on the pack's background. */
const ON_BACKGROUND_TYPES: ReadonlySet<string> = new Set(["amazon_main", "alt_angle_white", "collection_thumb"]);

/** Long side of a demo preview, in SVG units. */
const PREVIEW_LONG_SIDE = 400;

/**
 * What the demo says was done to a file, the way the packager records it:
 * a kept photo resized (and padded on an exact size channel) from the demo
 * photo, and a cut out product on the pack's color, or on white where the
 * channel requires it. Null for everything else.
 */
export function demoTreatment(shot: Shot, specId: string, output: ResolvedOutputOptions): PackAssetTreatment | null {
  const spec = tryGetSpec(specId);
  if (!spec) {
    return null;
  }
  if (shot.type === "original_photo") {
    const fit = originalFitFor(spec, output);
    const scale = originalScale(DEMO_PHOTO_SIZE, spec, output);
    return {
      kind: "original",
      scale: scale.scale,
      sourceWidth: DEMO_PHOTO_SIZE.width,
      sourceHeight: DEMO_PHOTO_SIZE.height,
      ...(fit === "pad" ? { padHex: rgbToHex(backgroundFor(spec, output).rgb) } : {}),
    };
  }
  if (!ON_BACKGROUND_TYPES.has(shot.type)) {
    return null;
  }
  const background = backgroundFor(spec, output);
  // On a Keep pack the background of a white required file was removed
  // for that file only, which is the white required note too.
  const forcedWhite = background.forcedWhite || (output.background === "keep" && requiresWhiteBackground(spec));
  return forcedWhite ? { kind: "background", forcedWhite: true } : { kind: "background", colorHex: rgbToHex(background.rgb) };
}

/** A preview canvas in the spec's aspect, long side PREVIEW_LONG_SIDE. */
function previewSize(width: number, height: number): { w: number; h: number } {
  const scale = PREVIEW_LONG_SIDE / Math.max(width, height, 1);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

/** The product illustration, centered in a box. */
function productArt(x: number, y: number, w: number, h: number, card: string): string {
  const s = Math.min(w / 400, h / 400);
  const ox = x + (w - 400 * s) / 2;
  const oy = y + (h - 400 * s) / 2;
  return `<g transform="translate(${ox.toFixed(1)} ${oy.toFixed(1)}) scale(${s.toFixed(4)})"><rect x="130" y="90" width="140" height="220" rx="14" fill="#64708c"/><rect x="150" y="150" width="100" height="90" rx="8" fill="${card}" stroke="#c5cbd8"/><rect x="162" y="166" width="76" height="10" rx="4" fill="#384153"/><rect x="162" y="186" width="58" height="7" rx="3" fill="#8494ad"/><rect x="162" y="206" width="66" height="7" rx="3" fill="#8494ad"/></g>`;
}

/**
 * Tiny inline SVG preview so the reveal works with zero stored files. It is
 * drawn in the spec's aspect: a kept photo in the demo photo's own shape
 * (or padded with the pack's color where the channel's shape needs it), a
 * cut out product on the pack's color (white where the channel requires
 * it), and anything else on white.
 */
export function demoShotImage(shotType: string, specId?: string, output?: ResolvedOutputOptions | null): string {
  const label = shotType.replaceAll("_", " ");
  const spec = specId ? tryGetSpec(specId) : null;
  const white = stillStyle.whiteHex;
  const card = white;
  let body: string;
  let size: { w: number; h: number };
  if (shotType === "original_photo" && spec) {
    // The seller's own photo: a scene backdrop, never a flat studio color.
    const scene = backgroundSwatches.sand.hex;
    const floor = backgroundSwatches.studio_gray.hex;
    const photo = (x: number, y: number, w: number, h: number) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${scene}"/><rect x="${x}" y="${(y + h * 0.7).toFixed(1)}" width="${w}" height="${(h * 0.3).toFixed(1)}" fill="${floor}"/>${productArt(x, y, w, h, card)}`;
    if (originalFitFor(spec, output) === "pad") {
      const canvas = canvasSizeFor(spec);
      size = previewSize(canvas.width, canvas.height);
      const fit = Math.min(size.w / DEMO_PHOTO_SIZE.width, size.h / DEMO_PHOTO_SIZE.height);
      const pw = Math.round(DEMO_PHOTO_SIZE.width * fit);
      const ph = Math.round(DEMO_PHOTO_SIZE.height * fit);
      const pad = rgbToHex(backgroundFor(spec, output).rgb);
      body = `<rect width="${size.w}" height="${size.h}" fill="${pad}"/>${photo(Math.round((size.w - pw) / 2), Math.round((size.h - ph) / 2), pw, ph)}`;
    } else {
      size = previewSize(DEMO_PHOTO_SIZE.width, DEMO_PHOTO_SIZE.height);
      body = photo(0, 0, size.w, size.h);
    }
  } else {
    const canvas = spec ? canvasSizeFor(spec) : { width: PREVIEW_LONG_SIDE, height: PREVIEW_LONG_SIDE };
    size = previewSize(canvas.width, canvas.height);
    const fill = spec && ON_BACKGROUND_TYPES.has(shotType) ? rgbToHex(backgroundFor(spec, output).rgb) : white;
    body = `<rect width="${size.w}" height="${size.h}" fill="${fill}"/>${productArt(0, 0, size.w, size.h * 0.85, card)}`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}">${body}<text x="${Math.round(size.w / 2)}" y="${Math.round(size.h - 16)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="20" fill="#5b6474">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
