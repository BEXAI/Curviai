/**
 * DemoService: the in memory implementation that powers zero env development
 * and e2e runs. Reads are deterministic fixture data. The only mutation is
 * job creation, which starts a simulated pack that advances one state per
 * poll of getJob, so the progress board is alive without any provider or
 * database. Everything else is read only.
 */

import { createHash } from "node:crypto";
import type { Shot } from "@curvi/pipeline/schemas";
import { tierByKey, type TierKey } from "@curvi/pipeline/seed";
import { filenameFor, getSpec } from "@curvi/specs";
import { planDemoShots } from "./demo-plan";
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
  ShotCompliance,
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
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    title: "Trailhead merino running socks",
    mode: "listing",
    category: "apparel",
    createdAt: "2026-09-22T14:30:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    title: "Lumen fold flat desk lamp",
    mode: "concept",
    category: "electronics",
    createdAt: "2026-09-25T11:15:00.000Z",
  },
];

const DEMO_BRAND_KIT: BrandKitView = {
  name: "Default",
  colors: ["#1D2433", "#FD7F11", "#F6F7F9"],
  fonts: { heading: "Inter", body: "Inter" },
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
  /** How many times getJob has observed this job. Drives the simulation. */
  polls: number;
}

/** Shared in memory state. Lives on globalThis so every route bundle in one
 * server process sees the same jobs. */
export class DemoStore {
  readonly jobs = new Map<string, DemoJobRecord>();
  readonly jobIdByIdempotencyKey = new Map<string, string>();
  readonly extraProducts: ProductSummary[] = [];
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

function hashBody(input: Pick<CreateJobInput, "productId" | "channels" | "mode">): string {
  return createHash("sha256")
    .update(JSON.stringify({ productId: input.productId, channels: [...input.channels].sort(), mode: input.mode }))
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
  const status = jobStatusAt(record.polls, record.shots);
  const shots: JobShotView[] = record.shots.map((shot, i) => {
    const shotStatus = shotStatusAt(record.polls, shotTimeline(i, count));
    return {
      shotId: shot.id,
      shotType: shot.type,
      providerStage: providerStageFor(shot.method),
      status: shotStatus,
      channels: shot.channels,
      credits: shot.credits,
      compliance: shotStatus === "done" ? complianceFor(shot) : null,
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
  };
}

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
      held += record.creditsReserved;
    }
    return grant - held;
  }

  async getCurrentWorkspace(): Promise<WorkspaceSummary> {
    return {
      id: DEMO_WORKSPACE_ID,
      name: DEMO_WORKSPACE_NAME,
      plan: DEMO_TIER,
      creditBalance: this.balance(),
      role: "owner",
    };
  }

  async listProducts(_workspaceId: string): Promise<ProductSummary[]> {
    return [...this.store.extraProducts, ...DEMO_PRODUCTS];
  }

  async getProduct(_workspaceId: string, productId: string): Promise<ProductSummary | null> {
    return (
      this.store.extraProducts.find((p) => p.id === productId) ??
      DEMO_PRODUCTS.find((p) => p.id === productId) ??
      null
    );
  }

  async createProduct(_workspaceId: string, input: CreateProductInput): Promise<ProductSummary> {
    const product: ProductSummary = {
      id: this.store.nextProductId(),
      title: input.title,
      mode: input.mode,
      category: "other",
      createdAt: this.now().toISOString(),
    };
    this.store.extraProducts.unshift(product);
    return product;
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
    const status = jobStatusAt(record.polls, record.shots);
    if (status !== "done") {
      return { jobId, status, files: [] };
    }
    const files: JobFileView[] = [];
    const counters = new Map<string, number>();
    const channels = new Set<string>();
    for (const shot of record.shots) {
      const specId = shot.channels[0];
      const spec = tryGetSpec(specId);
      if (!spec) {
        continue;
      }
      const channel = specId.split(".")[0];
      channels.add(channel);
      const n = (counters.get(specId) ?? 0) + 1;
      counters.set(specId, n);
      files.push({
        name: demoFileName(specId, n),
        channel,
        specId,
        kind: "image",
        bytes: null,
        url: demoShotImage(shot.type),
      });
    }
    for (const channel of channels) {
      files.push({ name: `${channel}.zip`, channel, specId: null, kind: "zip", bytes: null, url: null });
    }
    files.push({ name: "compliance-report.json", channel: null, specId: null, kind: "report", bytes: null, url: null });
    return {
      jobId,
      status,
      files,
      notice:
        "Demo mode renders previews only. Zip and report downloads switch on once R2 and a database are configured.",
    };
  }

  async listRecentJobs(_workspaceId: string, limit = 10): Promise<JobSummary[]> {
    const records = [...this.store.jobs.values()].reverse().slice(0, limit);
    return records.map((record) => ({
      id: record.id,
      productTitle: this.productTitle(record.productId),
      status: jobStatusAt(record.polls, record.shots),
      creditsReserved: record.creditsReserved,
      createdAt: record.createdAt,
    }));
  }

  async getJob(_workspaceId: string, jobId: string): Promise<JobView | null> {
    const record = this.store.jobs.get(jobId);
    if (!record) {
      return null;
    }
    record.polls += 1;
    return projectJob(record, this.productTitle(record.productId));
  }

  async createJob(_workspaceId: string, input: CreateJobInput): Promise<CreateJobResult> {
    const bodyHash = hashBody(input);
    const existingId = this.store.jobIdByIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.store.jobs.get(existingId);
      if (existing && existing.bodyHash === bodyHash) {
        return { outcome: "replayed", job: projectJob(existing, this.productTitle(existing.productId)) };
      }
      return { outcome: "conflict", existingJobId: existingId };
    }

    const product = DEMO_PRODUCTS.find((p) => p.id === input.productId);
    if (!product) {
      return { outcome: "rejected", reason: "unknown_product", message: "That product does not exist in this workspace." };
    }

    const balance = this.balance();
    const shots = planDemoShots(input.channels, DEMO_TIER);
    const creditsReserved = Math.ceil(shots.reduce((sum, shot) => sum + shot.credits, 0));
    if (creditsReserved <= 0 || creditsReserved > balance) {
      return {
        outcome: "rejected",
        reason: "insufficient_credits",
        message: "Not enough credits for this pack. Top up or pick fewer channels.",
      };
    }

    const record: DemoJobRecord = {
      id: this.store.nextJobId(),
      productId: input.productId,
      channels: input.channels,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
      bodyHash,
      createdAt: this.now().toISOString(),
      creditsReserved,
      shots,
      polls: 0,
    };
    this.store.jobs.set(record.id, record);
    this.store.jobIdByIdempotencyKey.set(input.idempotencyKey, record.id);
    return { outcome: "created", job: projectJob(record, product.title) };
  }

  async getBrandKit(_workspaceId: string): Promise<BrandKitView> {
    return DEMO_BRAND_KIT;
  }

  async saveBrandKit(_workspaceId: string, _kit: BrandKitView): Promise<SaveResult> {
    return { ok: false, notice: READ_ONLY_NOTICE };
  }

  async listMembers(_workspaceId: string): Promise<MemberView[]> {
    return DEMO_MEMBERS;
  }

  async listIntegrations(_workspaceId: string): Promise<IntegrationView[]> {
    return DEMO_INTEGRATIONS;
  }

  private productTitle(productId: string): string {
    return (
      this.store.extraProducts.find((p) => p.id === productId)?.title ??
      DEMO_PRODUCTS.find((p) => p.id === productId)?.title ??
      "Product"
    );
  }
}

function tryGetSpec(specId: string): ReturnType<typeof getSpec> | null {
  try {
    return getSpec(specId);
  } catch {
    return null;
  }
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

/** Tiny inline SVG preview so the reveal works with zero stored files. */
function demoShotImage(shotType: string): string {
  const label = shotType.replaceAll("_", " ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="#ffffff"/><rect x="130" y="90" width="140" height="220" rx="14" fill="#64708c"/><rect x="150" y="150" width="100" height="90" rx="8" fill="#ffffff" stroke="#c5cbd8"/><rect x="162" y="166" width="76" height="10" rx="4" fill="#384153"/><rect x="162" y="186" width="58" height="7" rx="3" fill="#8494ad"/><rect x="162" y="206" width="66" height="7" rx="3" fill="#8494ad"/><text x="200" y="360" text-anchor="middle" font-family="system-ui, sans-serif" font-size="20" fill="#5b6474">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
