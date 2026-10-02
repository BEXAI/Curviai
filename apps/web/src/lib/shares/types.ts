/**
 * Share pages (plan 9.6.1): an owner publishes a finished pack to a public
 * page at /s/{slug}, as a before and after or as the whole pack, can opt it
 * into the public gallery, and can take it down again. These view types are
 * free of server imports so the client share panel can use them.
 */

import type { FileProofView } from "@/lib/proof-view";

export type ShareKind = "before_after" | "pack";

/** What the owner sees about one job's share page. */
export interface ShareStatus {
  jobId: string;
  /** True once the pack is finished with at least one delivered image. */
  eligible: boolean;
  /** Owners and admins publish; other roles only see the status. */
  canPublish: boolean;
  published: boolean;
  slug: string | null;
  /** Same origin path of the public page, "/s/{slug}", while published. */
  path: string | null;
  kind: ShareKind;
  inGallery: boolean;
  /** Owner consent may be waiting for review before it becomes public. */
  galleryRequested?: boolean;
  galleryReviewStatus?: "pending" | "approved" | "rejected" | null;
  /** False when the original photo is gone, so the page shows the results only. */
  hasBefore: boolean;
  views: number;
  /** True when the public page shows each image's measured checks (P18-16). */
  showProof: boolean;
}

export interface PublishShareInput {
  kind: ShareKind;
  /** The owner's opt in to the public gallery at /gallery. */
  gallery: boolean;
  /** Show the measured checks on the public page (P18-16). Off for a new
   * seller share unless asked (founder decision 9); left out, a republish
   * keeps the page's current choice. Operator prospect shares send true. */
  proof?: boolean;
}

export type ShareActionResult =
  | { ok: true; status: ShareStatus }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "not_ready" | "unavailable";
      message: string;
    };

export interface PublicShareImage {
  /** Stable id within the share, e.g. "before" or "v_{variant id}". */
  ref: string;
  src: string;
  alt: string;
  /** The channel spec the file was made for, so the page can show it in
   * its own aspect box (previewAspect). Absent for the before photo and for
   * drawn illustrations. */
  specId?: string | null;
  /** The file's measured proof, only on a page whose owner turned proof on
   * (P18-16). Numbers and check rows only: never a key, id or file name. */
  proof?: FileProofView | null;
}

/** Everything the public page shows, and nothing more (no ids, no keys). */
export interface PublicShare {
  slug: string;
  kind: ShareKind;
  title: string;
  category: string | null;
  before: PublicShareImage | null;
  after: PublicShareImage | null;
  /** Every delivered image, one per shot, for a whole pack share. Empty for a before and after. */
  images: PublicShareImage[];
  inGallery: boolean;
  /** True when the images are drawn illustrations (demo mode), labeled as such. */
  illustration: boolean;
  /** True when the hero is the seller's own kept photo (PHASE_15 item 34):
   * there is no makeover to compare, so the page is titled "Sized for each
   * channel" and never offers a before and after. */
  sizedForChannels: boolean;
  /** True when the owner turned on the measured checks (P18-16): the after
   * image and every pack image carry their proof. */
  proof?: boolean;
}

export interface GalleryEntry {
  slug: string;
  title: string;
  category: string | null;
  before: PublicShareImage | null;
  after: PublicShareImage;
  /** True when the pack was made in an operator's workspace (P18-14,
   * founder decision 15): the gallery says "Made by the Curvi team" instead
   * of "Shared by the seller". */
  madeByTeam?: boolean;
  /** A quote the seller let Curvi use (P18-05), shown under a seller's entry. */
  quote?: { text: string; name: string | null } | null;
}

export interface ShareStore {
  getStatus(workspace: ShareWorkspace, jobId: string): Promise<ShareStatus | null>;
  publish(workspace: ShareWorkspace, jobId: string, input: PublishShareInput): Promise<ShareActionResult>;
  unpublish(workspace: ShareWorkspace, jobId: string): Promise<ShareActionResult>;
  /** The public view of a published share, or null. */
  getPublic(slug: string): Promise<PublicShare | null>;
  /** The object key behind one image of a published share, or null. */
  imageKey(slug: string, ref: string): Promise<string | null>;
  /** Published, opted in makeovers, newest first. */
  listGallery(limit: number): Promise<GalleryEntry[]>;
  /** Counts one view of a published share. Best effort. */
  recordView(slug: string): Promise<void>;
}

/** The caller's workspace and role, as resolved by the services layer. */
export interface ShareWorkspace {
  id: string;
  role: "owner" | "admin" | "editor" | "client";
}

export const PUBLISH_ROLES: readonly ShareWorkspace["role"][] = ["owner", "admin"];

export function canPublishShares(role: ShareWorkspace["role"]): boolean {
  return PUBLISH_ROLES.includes(role);
}

export function sharePath(slug: string): string {
  return `/s/${slug}`;
}

/** Same origin url of one share image, served re-encoded without metadata. */
export function shareImagePath(slug: string, ref: string): string {
  return `/s/${slug}/image/${ref}`;
}
