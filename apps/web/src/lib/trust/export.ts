/**
 * Data export (docs/PENDING.md, "Self serve account deletion and data
 * export"): one JSON document with the workspace, brand kit, products with
 * their source photos, packs with their delivered files, and the credit
 * history. Every stored object is listed with a signed link that works for
 * 24 hours, plus, for pack files, the in app download path that signs a fresh
 * link on every click while the account exists.
 *
 * In db mode every row of the workspace is read directly (no page limits).
 * Demo mode builds the same shape from the Services interface.
 */

import { type Db } from "@curvi/db";
import { isWorkspaceKey } from "@/lib/r2";
import type { JobStatus, Services, WorkspaceSummary } from "@/lib/services/types";

export const EXPORT_FORMAT = "curvi-export-v1";
/** Signed links in the export stay valid this long. */
export const EXPORT_LINK_TTL_SECONDS = 24 * 60 * 60;
export const EXPORT_NOTICE =
  "Links in this file work for 24 hours. Download what you need, or export again for fresh links.";

export interface ExportFile {
  name: string;
  channel: string | null;
  specId: string | null;
  kind: "image" | "zip" | "report";
  bytes: number | null;
  /** Signed link valid for 24 hours; null when storage is not configured. */
  url: string | null;
  /** In app download path; works while you are signed in. */
  appPath: string | null;
}

export interface AccountExport {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  notice: string;
  account: { email: string | null };
  workspace: { id: string; name: string; plan: string; createdAt: string | null };
  brandKit: {
    name: string;
    colors: string[];
    fonts: { heading: string; body: string };
    stylePreset: string | null;
    logoUrl: string | null;
  } | null;
  products: Array<{
    id: string;
    title: string;
    mode: string;
    category: string;
    amazonSku: string | null;
    createdAt: string;
    photos: Array<{
      id: string;
      kind: string | null;
      width: number | null;
      height: number | null;
      sha256: string;
      createdAt: string;
      url: string | null;
    }>;
  }>;
  packs: Array<{
    id: string;
    productId: string;
    status: string;
    mode: string | null;
    channels: string[];
    creditsReserved: number;
    creditsCharged: number;
    createdAt: string;
    files: ExportFile[];
  }>;
  credits: Array<{ delta: number; reason: string; jobId: string | null; createdAt: string }>;
}

/** Signs a stored key for the export, or null when it cannot be signed. */
export type ExportSigner = (key: string) => Promise<string | null>;

function servesFiles(job: { status: string; creditsCharged: number | null }): boolean {
  return job.status === "done" || Number(job.creditsCharged ?? 0) > 0;
}

export async function buildDbExport(
  db: Db,
  workspace: WorkspaceSummary,
  email: string | null,
  sign: ExportSigner | null,
  now: Date = new Date(),
): Promise<AccountExport> {
  const workspaceId = workspace.id;
  const signKey = async (key: string | null | undefined): Promise<string | null> => {
    if (!sign || !key || !isWorkspaceKey(workspaceId, key)) {
      return null;
    }
    try {
      return await sign(key);
    } catch {
      return null;
    }
  };

  const [wsRow, kit, productRows, mediaRows, jobRows, assetRows, variantRows, packRows, ledgerRows] = await Promise.all([
    db.query.workspaces.findFirst({ where: (t, { eq }) => eq(t.id, workspaceId) }),
    db.query.brandKits.findFirst({ where: (t, { eq }) => eq(t.workspaceId, workspaceId) }),
    db.query.products.findMany({ where: (t, { eq }) => eq(t.workspaceId, workspaceId), orderBy: (t, { asc }) => [asc(t.createdAt)] }),
    db.query.sourceMedia.findMany({ where: (t, { eq }) => eq(t.workspaceId, workspaceId), orderBy: (t, { asc }) => [asc(t.createdAt)] }),
    db.query.generationJobs.findMany({ where: (t, { eq }) => eq(t.workspaceId, workspaceId), orderBy: (t, { asc }) => [asc(t.createdAt)] }),
    db.query.assets.findMany({ columns: { id: true, jobId: true }, where: (t, { eq }) => eq(t.workspaceId, workspaceId) }),
    db.query.assetVariants.findMany({ where: (t, { eq }) => eq(t.workspaceId, workspaceId) }),
    db.query.packFiles.findMany({ where: (t, { eq }) => eq(t.workspaceId, workspaceId) }),
    db.query.creditLedger.findMany({ where: (t, { eq }) => eq(t.workspaceId, workspaceId), orderBy: (t, { asc }) => [asc(t.createdAt)] }),
  ]);

  const jobOfAsset = new Map(assetRows.map((a) => [a.id, a.jobId]));
  const filesByJob = new Map<string, ExportFile[]>();
  const push = (jobId: string, file: ExportFile) => filesByJob.set(jobId, [...(filesByJob.get(jobId) ?? []), file]);
  const servedJobs = new Set(jobRows.filter(servesFiles).map((j) => j.id));

  for (const variant of variantRows) {
    const jobId = jobOfAsset.get(variant.assetId);
    if (!jobId || !servedJobs.has(jobId) || !isWorkspaceKey(workspaceId, variant.r2Key)) {
      continue;
    }
    push(jobId, {
      name: variant.filename,
      channel: variant.channelSpecId.split(".")[0],
      specId: variant.channelSpecId,
      kind: "image",
      bytes: variant.bytes,
      url: await signKey(variant.r2Key),
      appPath: `/api/jobs/${jobId}/files/v_${variant.id}`,
    });
  }
  for (const pack of packRows) {
    if (!servedJobs.has(pack.jobId) || !isWorkspaceKey(workspaceId, pack.r2Key)) {
      continue;
    }
    push(pack.jobId, {
      name: pack.filename,
      channel: pack.channel,
      specId: null,
      kind: pack.kind === "report" ? "report" : "zip",
      bytes: pack.bytes,
      url: await signKey(pack.r2Key),
      appPath: `/api/jobs/${pack.jobId}/files/p_${pack.id}`,
    });
  }

  const products: AccountExport["products"] = [];
  for (const product of productRows) {
    const photos: AccountExport["products"][number]["photos"] = [];
    for (const media of mediaRows.filter((m) => m.productId === product.id)) {
      photos.push({
        id: media.id,
        kind: media.kind,
        width: media.width,
        height: media.height,
        sha256: media.sha256,
        createdAt: media.createdAt.toISOString(),
        url: await signKey(media.r2Key),
      });
    }
    products.push({
      id: product.id,
      title: product.title ?? "Untitled product",
      mode: product.mode,
      category: typeof product.profile?.category === "string" ? product.profile.category : "other",
      amazonSku: product.amazonSku,
      createdAt: product.createdAt.toISOString(),
      photos,
    });
  }

  return {
    format: EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    notice: EXPORT_NOTICE,
    account: { email },
    workspace: {
      id: workspaceId,
      name: wsRow?.name ?? workspace.name,
      plan: wsRow?.plan ?? workspace.plan,
      createdAt: wsRow?.createdAt.toISOString() ?? null,
    },
    brandKit: kit
      ? {
          name: kit.name,
          colors: kit.colors ?? [],
          fonts: { heading: kit.fonts?.heading ?? "", body: kit.fonts?.body ?? "" },
          stylePreset: kit.stylePreset,
          logoUrl: await signKey(kit.logoR2Key),
        }
      : null,
    products,
    packs: jobRows.map((job) => ({
      id: job.id,
      productId: job.productId,
      status: job.status,
      mode: job.mode,
      channels: job.channels ?? [],
      creditsReserved: Number(job.creditsReserved),
      creditsCharged: Number(job.creditsCharged),
      createdAt: job.createdAt.toISOString(),
      files: filesByJob.get(job.id) ?? [],
    })),
    credits: ledgerRows.map((row) => ({
      delta: Number(row.delta),
      reason: row.reason,
      jobId: row.jobId,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** The same document from the Services interface, for demo mode. */
export async function buildServicesExport(
  services: Services,
  workspace: WorkspaceSummary,
  now: Date = new Date(),
): Promise<AccountExport> {
  const [products, jobs, kit] = await Promise.all([
    services.listProducts(workspace.id),
    services.listRecentJobs(workspace.id, 500),
    services.getBrandKit(workspace.id),
  ]);
  const packs: AccountExport["packs"] = [];
  for (const summary of jobs) {
    const job = await services.getJob(workspace.id, summary.id);
    const files = await services.listJobFiles(workspace.id, summary.id);
    packs.push({
      id: summary.id,
      productId: job?.productId ?? "",
      status: summary.status as JobStatus,
      mode: job?.mode ?? null,
      channels: job?.channels ?? [],
      creditsReserved: summary.creditsReserved,
      creditsCharged: job?.creditsCharged ?? 0,
      createdAt: summary.createdAt,
      files: (files?.files ?? []).map((f) => ({
        name: f.name,
        channel: f.channel,
        specId: f.specId,
        kind: f.kind,
        bytes: f.bytes,
        // Demo previews are inline sample images, not stored objects.
        url: null,
        appPath: f.downloadUrl,
      })),
    });
  }
  return {
    format: EXPORT_FORMAT,
    exportedAt: now.toISOString(),
    notice: EXPORT_NOTICE,
    account: { email: null },
    workspace: { id: workspace.id, name: workspace.name, plan: workspace.plan, createdAt: null },
    brandKit: {
      name: kit.name,
      colors: kit.colors,
      fonts: kit.fonts,
      stylePreset: kit.stylePreset,
      logoUrl: null,
    },
    products: products.map((p) => ({
      id: p.id,
      title: p.title,
      mode: p.mode,
      category: p.category,
      amazonSku: null,
      createdAt: p.createdAt,
      photos: [],
    })),
    packs,
    credits: [],
  };
}

export function exportFilename(now: Date = new Date()): string {
  return `curvi-export-${now.toISOString().slice(0, 10)}.json`;
}
