/**
 * The outreach kit for one prospect pack (docs/phases/PHASE_18.md P18-04):
 * the free main image checker's rows for the prospect's current listing
 * photo (the photo the pack was made from, measured on the server with the
 * checker's own code and the seeded channel's registry rules), the pack's
 * fidelity summary (P18-08), and what the draft note needs. Deterministic:
 * no AI call. Server only.
 */

import { packFidelitySummary, type Db, type PackFidelitySummary } from "@curvi/db";
import { prospectClaims } from "@curvi/pipeline/seed";
import { flatPixelsOnWhite, type FlatPixels } from "@curvi/pipeline/pixels";
import { isWorkspaceSourceKey } from "@/lib/r2";
import { checkerChannelForSpec, defaultCheckerChannel } from "@/lib/tools/checker-rules";
import { checkRows, flattenOnWhite, measurePixels, summaryLine, type CheckRow } from "@/lib/tools/main-image-analysis";

export interface MainImageKitCheck {
  rows: CheckRow[];
  summary: string;
  /** Share of the edge pixels at pure white, as a percent. */
  whitePercent: number;
  /** The product's fill of the frame, as a percent, or null when no product was found. */
  fillPercent: number | null;
}

export interface OutreachKit {
  store: string;
  productTitle: string;
  check: MainImageKitCheck | null;
  fidelity: PackFidelitySummary;
}

export interface KitDeps {
  db: Db;
  /** Reads one stored object; null when it is gone. */
  get: (key: string) => Promise<Buffer | null>;
  decode?: (bytes: Uint8Array) => Promise<FlatPixels>;
}

/** The checker's rows for one photo, or null when it cannot be decoded. */
export async function measureMainImage(
  bytes: Uint8Array,
  decode: (bytes: Uint8Array) => Promise<FlatPixels> = flatPixelsOnWhite,
): Promise<MainImageKitCheck | null> {
  let pixels: FlatPixels;
  try {
    pixels = await decode(bytes);
  } catch {
    return null;
  }
  flattenOnWhite(pixels.data);
  const measured = measurePixels(pixels.data, pixels.width, pixels.height);
  const channel = checkerChannelForSpec(prospectClaims.kitChannelSpec) ?? defaultCheckerChannel();
  const rows = checkRows({ width: pixels.naturalWidth, height: pixels.naturalHeight }, measured, channel.rules);
  return {
    rows,
    summary: summaryLine(rows),
    whitePercent: measured.borderWhiteShare * 100,
    fillPercent: measured.hasProduct ? measured.fillRatio * 100 : null,
  };
}

/** The kit for a claim of the operator's workspace, or null when it is not one. */
export async function buildOutreachKit(
  deps: KitDeps,
  input: { claimId: string; staffWorkspaceId: string },
): Promise<OutreachKit | null> {
  const claim = await deps.db.query.packClaims.findFirst({
    where: (t, { and, eq }) => and(eq(t.id, input.claimId), eq(t.staffWorkspaceId, input.staffWorkspaceId)),
  });
  if (!claim) {
    return null;
  }
  const job = await deps.db.query.generationJobs.findFirst({
    columns: { productId: true, createdAt: true },
    where: (t, { and, eq }) => and(eq(t.id, claim.jobId), eq(t.workspaceId, claim.staffWorkspaceId)),
  });
  if (!job) {
    return null;
  }
  const [product, media, fidelity] = await Promise.all([
    deps.db.query.products.findFirst({
      columns: { title: true },
      where: (t, { and, eq }) => and(eq(t.id, job.productId), eq(t.workspaceId, claim.staffWorkspaceId)),
    }),
    deps.db.query.sourceMedia.findMany({
      columns: { r2Key: true, kind: true, createdAt: true },
      where: (t, { and, eq }) => and(eq(t.productId, job.productId), eq(t.workspaceId, claim.staffWorkspaceId)),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 20,
    }),
    packFidelitySummary(deps.db, { jobId: claim.jobId, workspaceId: claim.staffWorkspaceId }),
  ]);
  const images = media.filter(
    (m) => (m.kind === "image" || m.kind === null) && isWorkspaceSourceKey(claim.staffWorkspaceId, m.r2Key),
  );
  const photo = images.find((m) => m.createdAt <= job.createdAt) ?? images[0];
  let check: MainImageKitCheck | null = null;
  if (photo) {
    try {
      const bytes = await deps.get(photo.r2Key);
      check = bytes ? await measureMainImage(bytes, deps.decode) : null;
    } catch (err) {
      console.warn("[prospects] could not measure the listing photo", err instanceof Error ? err.message : err);
    }
  }
  return {
    store: claim.prospectLabel,
    productTitle: product?.title ?? claim.prospectLabel,
    check,
    fidelity,
  };
}
