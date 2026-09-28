/**
 * Share pages in demo mode (no database). Publishing snapshots the demo
 * pack's drawn previews into process memory, so the whole flow, publish,
 * view, gallery and take down, works with zero env vars. Every image here is
 * an illustration and the page labels it so. /s/example always shows one
 * illustrated makeover, so the format can be seen without a pack.
 */

import { afterDemoImage, beforeDemoImage } from "@/components/marketing/demo-images";
import type { Services } from "@/lib/services/types";
import { isShareSlug, newShareSlug } from "./pick";
import {
  canPublishShares,
  sharePath,
  type GalleryEntry,
  type PublicShare,
  type PublicShareImage,
  type PublishShareInput,
  type ShareActionResult,
  type ShareKind,
  type ShareStatus,
  type ShareStore,
  type ShareWorkspace,
} from "./types";

export const DEMO_EXAMPLE_SLUG = "example";

interface DemoShareRecord {
  slug: string;
  workspaceId: string;
  jobId: string;
  kind: ShareKind;
  title: string;
  images: PublicShareImage[];
  isPublic: boolean;
  inGallery: boolean;
  views: number;
  publishedAt: number;
}

export class DemoShareState {
  readonly byJob = new Map<string, DemoShareRecord>();
}

const globalScope = globalThis as typeof globalThis & { __curviDemoShares?: DemoShareState };

export function getDemoShareState(): DemoShareState {
  if (!globalScope.__curviDemoShares) {
    globalScope.__curviDemoShares = new DemoShareState();
  }
  return globalScope.__curviDemoShares;
}

function exampleShare(): PublicShare {
  const title = "A product photo makeover";
  return {
    slug: DEMO_EXAMPLE_SLUG,
    kind: "before_after",
    title,
    category: null,
    before: { ref: "before", src: beforeDemoImage, alt: `${title}, the original photo` },
    after: { ref: "after", src: afterDemoImage, alt: `${title}, the result` },
    images: [],
    inGallery: false,
    illustration: true,
  };
}

export class DemoShareStore implements ShareStore {
  constructor(
    private readonly services: Pick<Services, "getJob" | "listJobFiles">,
    private readonly state: DemoShareState = getDemoShareState(),
  ) {}

  private status(workspace: ShareWorkspace, jobId: string, eligible: boolean): ShareStatus {
    const record = this.state.byJob.get(jobId);
    const published = record?.isPublic === true && record.workspaceId === workspace.id;
    return {
      jobId,
      eligible,
      canPublish: canPublishShares(workspace.role),
      published,
      slug: record?.slug ?? null,
      path: published && record ? sharePath(record.slug) : null,
      kind: record?.kind ?? "before_after",
      inGallery: published && record?.inGallery === true,
      hasBefore: true,
      views: record?.views ?? 0,
    };
  }

  private async images(workspaceId: string, jobId: string): Promise<PublicShareImage[] | null> {
    const files = await this.services.listJobFiles(workspaceId, jobId);
    if (!files) {
      return null;
    }
    return files.files
      .filter((f) => f.kind === "image" && f.url)
      .map((f) => ({ ref: f.id, src: f.url!, alt: f.name }));
  }

  async getStatus(workspace: ShareWorkspace, jobId: string): Promise<ShareStatus | null> {
    const images = await this.images(workspace.id, jobId);
    return images ? this.status(workspace, jobId, images.length > 0) : null;
  }

  async publish(workspace: ShareWorkspace, jobId: string, input: PublishShareInput): Promise<ShareActionResult> {
    if (!canPublishShares(workspace.role)) {
      return { ok: false, reason: "forbidden", message: "Only owners and admins can publish a share page." };
    }
    const images = await this.images(workspace.id, jobId);
    if (!images) {
      return { ok: false, reason: "not_found", message: "Pack not found." };
    }
    if (images.length === 0) {
      return { ok: false, reason: "not_ready", message: "This pack has no finished images to share yet." };
    }
    const job = await this.services.getJob(workspace.id, jobId);
    const existing = this.state.byJob.get(jobId);
    this.state.byJob.set(jobId, {
      slug: existing?.slug ?? newShareSlug(),
      workspaceId: workspace.id,
      jobId,
      kind: input.kind,
      title: job?.productTitle ?? "A product photo makeover",
      images,
      isPublic: true,
      inGallery: input.gallery,
      views: existing?.views ?? 0,
      publishedAt: Date.now(),
    });
    return { ok: true, status: this.status(workspace, jobId, true) };
  }

  async unpublish(workspace: ShareWorkspace, jobId: string): Promise<ShareActionResult> {
    if (!canPublishShares(workspace.role)) {
      return { ok: false, reason: "forbidden", message: "Only owners and admins can take a share page down." };
    }
    const images = await this.images(workspace.id, jobId);
    if (!images) {
      return { ok: false, reason: "not_found", message: "Pack not found." };
    }
    const record = this.state.byJob.get(jobId);
    if (record && record.workspaceId === workspace.id) {
      record.isPublic = false;
      record.inGallery = false;
    }
    return { ok: true, status: this.status(workspace, jobId, images.length > 0) };
  }

  private findPublic(slug: string): DemoShareRecord | null {
    for (const record of this.state.byJob.values()) {
      if (record.slug === slug && record.isPublic) {
        return record;
      }
    }
    return null;
  }

  async getPublic(slug: string): Promise<PublicShare | null> {
    if (slug === DEMO_EXAMPLE_SLUG) {
      return exampleShare();
    }
    if (!isShareSlug(slug)) {
      return null;
    }
    const record = this.findPublic(slug);
    if (!record) {
      return null;
    }
    const [after] = record.images;
    return {
      slug,
      kind: record.kind,
      title: record.title,
      category: null,
      before: { ref: "before", src: beforeDemoImage, alt: `${record.title}, the original photo` },
      after,
      images: record.kind === "pack" ? record.images : [],
      inGallery: record.inGallery,
      illustration: true,
    };
  }

  /** Demo images are inline drawings, so there is never an object to serve. */
  async imageKey(): Promise<string | null> {
    return null;
  }

  async listGallery(limit: number): Promise<GalleryEntry[]> {
    const records = [...this.state.byJob.values()]
      .filter((r) => r.isPublic && r.inGallery)
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, limit);
    const entries: GalleryEntry[] = [];
    for (const record of records) {
      const share = await this.getPublic(record.slug);
      if (share?.after) {
        entries.push({ slug: share.slug, title: share.title, category: null, before: share.before, after: share.after });
      }
    }
    return entries;
  }

  async recordView(slug: string): Promise<void> {
    const record = this.findPublic(slug);
    if (record) {
      record.views += 1;
    }
  }
}
