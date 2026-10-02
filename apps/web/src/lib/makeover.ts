/**
 * Before and after reveal on a finished pack: which shots it can show, where
 * "Share this makeover" links point, and which stored photo counts as the
 * seller's original. Pure and free of server only imports, so the board, the
 * makeover download route and the db service share it and it is unit
 * testable.
 */

import type { JobShotView, JobView } from "@/lib/services/types";

/** The reveal's note under a workspace only Copy link. */
export const PACK_WORKSPACE_LINK_COPY =
  "The link opens this pack for people in your workspace. To share it with anyone, publish a share page in Share this makeover below.";
export const MAKEOVER_WORKSPACE_LINK_COPY =
  "The link opens this pack for people in your workspace. To share it with anyone, publish a share page in Share this makeover below, or download the side by side image.";

export interface RevealShot {
  shotId: string;
  shotType: string;
  title: string;
  imageUrl: string;
  /** The spec ids the shot shipped on, for the preview box shape. */
  channels: string[];
}

/** "Amazon main" from "amazon_main". Matches the shot card titles. */
export function shotTitle(shotType: string): string {
  const pretty = shotType.replaceAll("_", " ").replaceAll(":", " ").replaceAll(".", " ").trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** Finished shots that have a preview, in board order. Needs review, skipped
 * and unfinished shots never appear in a before and after. */
export function revealShots(shots: readonly JobShotView[]): RevealShot[] {
  return shots
    .filter((s): s is JobShotView & { imageUrl: string } => s.status === "done" && typeof s.imageUrl === "string" && s.imageUrl.length > 0)
    .map((s) => ({
      shotId: s.shotId,
      shotType: s.shotType,
      title: shotTitle(s.shotType),
      imageUrl: s.imageUrl,
      channels: [...s.channels],
    }));
}

/** True when the board should show the reveal: a finished pack with the
 * original photo and at least one finished shot to compare it with. */
export function canReveal(job: Pick<JobView, "status" | "sourceImageUrl" | "shots">): boolean {
  return job.status === "done" && Boolean(job.sourceImageUrl) && revealShots(job.shots).length > 0;
}

export interface ShareLink {
  url: string;
  /** "public" when anyone with the link can open it, "workspace" when only
   * members of the pack's workspace can. */
  audience: "public" | "workspace";
}

/**
 * The link "Copy link" puts on the clipboard: the pack page, which opens only
 * for members of the workspace. Public pages sit at /s/{slug} for a slug the
 * owner publishes from the "Share this makeover" panel under the board
 * (lib/shares), not at the job id, so the reveal's note points the seller at
 * that panel for a public link.
 */
export function makeoverShareLink(origin: string, jobId: string): ShareLink {
  const base = origin.replace(/\/+$/, "");
  return { url: `${base}/app/jobs/${encodeURIComponent(jobId)}`, audience: "workspace" };
}

/** Same origin route that renders the side by side image for one shot. */
export function makeoverDownloadPath(jobId: string, shotId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/makeover?shot=${encodeURIComponent(shotId)}`;
}

/** "juniper-glass-water-bottle-before-after-amazon-main.jpg". */
export function makeoverFilename(productTitle: string, shotType: string): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/g, "");
  const parts = [slug(productTitle) || "product", "before-after", slug(shotType)].filter(Boolean);
  return `${parts.join("-")}.jpg`;
}

export interface SourceCandidate {
  r2Key: string;
  kind: string | null;
  createdAt: Date;
}

/**
 * The seller's original photo for a pack: the newest still photo of the
 * product stored no later than the pack started, which is the photo the
 * planner used first (uploads with the pack are saved in the same
 * transaction as the job, so they share its timestamp). A photo added after
 * the pack is never shown as its before, so null when there is no such
 * photo.
 * `allowed` re-checks each key belongs to the workspace before it is signed.
 */
export function pickSourcePhoto(
  rows: readonly SourceCandidate[],
  jobCreatedAt: Date,
  allowed: (key: string) => boolean,
): SourceCandidate | null {
  const stills = rows.filter((r) => r.kind !== "video" && allowed(r.r2Key));
  const started = jobCreatedAt.getTime();
  const before = stills
    .filter((r) => r.createdAt.getTime() <= started)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return before[0] ?? null;
}
