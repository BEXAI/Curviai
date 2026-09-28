/**
 * Share pages over the owner connection (DATABASE_URL). Like DbService, the
 * owner connection bypasses RLS, so every query here is scoped by hand:
 * owner reads and writes by the caller's workspace, public reads by a slug
 * whose row is public, and every object key is checked against the row's
 * workspace prefix before it is served (Update.md 4.1).
 *
 * The public page gets images through /s/{slug}/image/{ref}, which re-encodes
 * each one without metadata, so the seller's photo never leaves with its
 * EXIF, and no signed bucket url or row id is ever put on a public page.
 */

import { type Db, galleryItems, shareLinks, sql, eq, and } from "@curvi/db";
import { isWorkspaceKey, isWorkspaceSourceKey } from "@/lib/r2";
import { isUuid } from "@/lib/validation/ids";
import { isShareSlug, newShareSlug, pickDisplayVariant, pickHeroAsset, shotLabel } from "./pick";
import {
  canPublishShares,
  sharePath,
  shareImagePath,
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

type JobRow = { id: string; workspaceId: string; productId: string; status: string; creditsCharged: number; createdAt: Date };
type AssetRow = { id: string; shotType: string; createdAt: Date };
type VariantRow = { id: string; assetId: string; r2Key: string; width: number | null; height: number | null; createdAt: Date };

/** Mirrors DbService's servesFiles: a finished pack, or one that charged for
 * files it delivered. Nothing else has files to show. */
function servesFiles(job: { status: string; creditsCharged: number | null }): boolean {
  return job.status === "done" || Number(job.creditsCharged ?? 0) > 0;
}

const SLUG_ATTEMPTS = 4;

export class DbShareStore implements ShareStore {
  constructor(private readonly db: Db) {}

  private async findJob(workspaceId: string, jobId: string): Promise<JobRow | null> {
    if (!isUuid(jobId)) {
      return null;
    }
    const job = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
    });
    return job ?? null;
  }

  /** One displayable file per delivered shot, keys checked, hero first. */
  private async shotFiles(job: JobRow): Promise<Array<{ asset: AssetRow; variant: VariantRow }>> {
    if (!servesFiles(job)) {
      return [];
    }
    const assetRows = await this.db.query.assets.findMany({
      where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, job.workspaceId)),
    });
    if (assetRows.length === 0) {
      return [];
    }
    const variantRows = await this.db.query.assetVariants.findMany({
      where: (t, { and, eq, inArray }) =>
        and(
          eq(t.workspaceId, job.workspaceId),
          inArray(
            t.assetId,
            assetRows.map((a) => a.id),
          ),
        ),
    });
    const files: Array<{ asset: AssetRow; variant: VariantRow }> = [];
    for (const asset of assetRows) {
      const variant = pickDisplayVariant(
        variantRows.filter((v) => v.assetId === asset.id && isWorkspaceKey(job.workspaceId, v.r2Key)),
      );
      if (variant) {
        files.push({ asset, variant });
      }
    }
    const hero = pickHeroAsset(files.map((f) => f.asset));
    return files.sort((a, b) => (a.asset === hero ? -1 : b.asset === hero ? 1 : 0));
  }

  /** The photo the pack was made from: the product's newest image uploaded
   * before the job started, else its newest image. */
  private async beforeMedia(job: JobRow): Promise<{ id: string; r2Key: string } | null> {
    const media = await this.db.query.sourceMedia.findMany({
      where: (t, { and, eq }) => and(eq(t.productId, job.productId), eq(t.workspaceId, job.workspaceId)),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 20,
    });
    const images = media.filter(
      (m) => (m.kind === "image" || m.kind === null) && isWorkspaceSourceKey(job.workspaceId, m.r2Key),
    );
    const chosen = images.find((m) => m.createdAt <= job.createdAt) ?? images[0];
    return chosen ? { id: chosen.id, r2Key: chosen.r2Key } : null;
  }

  private async statusFor(workspace: ShareWorkspace, job: JobRow): Promise<ShareStatus> {
    const [files, share] = await Promise.all([
      this.shotFiles(job),
      this.db.query.shareLinks.findFirst({
        where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspace.id)),
      }),
    ]);
    const gallery = share
      ? await this.db.query.galleryItems.findFirst({
          where: (t, { and, eq }) => and(eq(t.shareSlug, share.slug), eq(t.workspaceId, workspace.id)),
        })
      : undefined;
    const hasBefore = share ? share.beforeMediaId !== null : (await this.beforeMedia(job)) !== null;
    const published = share?.isPublic === true;
    return {
      jobId: job.id,
      eligible: files.length > 0,
      canPublish: canPublishShares(workspace.role),
      published,
      slug: share?.slug ?? null,
      path: published && share ? sharePath(share.slug) : null,
      kind: share?.kind ?? "before_after",
      inGallery: published && gallery?.published === true,
      hasBefore,
      views: share?.views ?? 0,
    };
  }

  async getStatus(workspace: ShareWorkspace, jobId: string): Promise<ShareStatus | null> {
    const job = await this.findJob(workspace.id, jobId);
    return job ? this.statusFor(workspace, job) : null;
  }

  async publish(workspace: ShareWorkspace, jobId: string, input: PublishShareInput): Promise<ShareActionResult> {
    if (!canPublishShares(workspace.role)) {
      return { ok: false, reason: "forbidden", message: "Only owners and admins can publish a share page." };
    }
    const job = await this.findJob(workspace.id, jobId);
    if (!job) {
      return { ok: false, reason: "not_found", message: "Pack not found." };
    }
    const files = await this.shotFiles(job);
    if (files.length === 0) {
      return {
        ok: false,
        reason: "not_ready",
        message: "This pack has no finished images to share yet.",
      };
    }
    const hero = files[0];
    const before = await this.beforeMedia(job);
    const product = await this.db.query.products.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, job.productId), eq(t.workspaceId, workspace.id)),
    });
    const title = (product?.title ?? "").trim().slice(0, 120) || null;
    const category = typeof product?.profile?.category === "string" ? product.profile.category : null;
    const now = new Date();

    const existing = await this.db.query.shareLinks.findFirst({
      where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspace.id)),
    });
    let slug = existing?.slug ?? null;
    const values = {
      kind: input.kind as ShareKind,
      title,
      assetId: hero.asset.id,
      beforeMediaId: before?.id ?? null,
      isPublic: true,
      publishedAt: now,
      updatedAt: now,
    };
    if (existing) {
      await this.db.update(shareLinks).set(values).where(eq(shareLinks.slug, existing.slug));
    } else {
      for (let attempt = 0; attempt < SLUG_ATTEMPTS && !slug; attempt++) {
        const candidate = newShareSlug();
        const inserted = await this.db
          .insert(shareLinks)
          .values({ slug: candidate, workspaceId: workspace.id, jobId: job.id, ...values })
          .onConflictDoNothing()
          .returning({ slug: shareLinks.slug });
        if (inserted.length > 0) {
          slug = candidate;
          continue;
        }
        // A concurrent publish of the same job won the job's unique index.
        const raced = await this.db.query.shareLinks.findFirst({
          where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspace.id)),
        });
        if (raced) {
          await this.db.update(shareLinks).set(values).where(eq(shareLinks.slug, raced.slug));
          slug = raced.slug;
        }
      }
    }
    if (!slug) {
      return { ok: false, reason: "unavailable", message: "We could not publish this just now. Try again." };
    }
    const publishedSlug: string = slug;

    if (input.gallery) {
      // Publishing to the gallery is the owner's consent, recorded now.
      await this.db
        .insert(galleryItems)
        .values({ workspaceId: workspace.id, shareSlug: publishedSlug, category, published: true, consentAt: now })
        .onConflictDoUpdate({
          target: galleryItems.shareSlug,
          targetWhere: sql`share_slug is not null`,
          set: { published: true, consentAt: now, category },
        });
    } else {
      await this.db
        .update(galleryItems)
        .set({ published: false })
        .where(and(eq(galleryItems.shareSlug, publishedSlug), eq(galleryItems.workspaceId, workspace.id)));
    }
    return { ok: true, status: await this.statusFor(workspace, job) };
  }

  async unpublish(workspace: ShareWorkspace, jobId: string): Promise<ShareActionResult> {
    if (!canPublishShares(workspace.role)) {
      return { ok: false, reason: "forbidden", message: "Only owners and admins can take a share page down." };
    }
    const job = await this.findJob(workspace.id, jobId);
    if (!job) {
      return { ok: false, reason: "not_found", message: "Pack not found." };
    }
    const share = await this.db.query.shareLinks.findFirst({
      where: (t, { and, eq }) => and(eq(t.jobId, job.id), eq(t.workspaceId, workspace.id)),
    });
    if (share) {
      await this.db
        .update(shareLinks)
        .set({ isPublic: false, updatedAt: new Date() })
        .where(eq(shareLinks.slug, share.slug));
      await this.db
        .update(galleryItems)
        .set({ published: false })
        .where(and(eq(galleryItems.shareSlug, share.slug), eq(galleryItems.workspaceId, workspace.id)));
    }
    return { ok: true, status: await this.statusFor(workspace, job) };
  }

  /** A public share row with its job, or null when either is gone or private. */
  private async publicShare(slug: string) {
    if (!isShareSlug(slug)) {
      return null;
    }
    const share = await this.db.query.shareLinks.findFirst({
      where: (t, { and, eq }) => and(eq(t.slug, slug), eq(t.isPublic, true)),
    });
    if (!share?.jobId) {
      return null;
    }
    const job = await this.findJob(share.workspaceId, share.jobId);
    if (!job || !servesFiles(job)) {
      return null;
    }
    return { share, job };
  }

  private async beforeKey(share: { workspaceId: string; beforeMediaId: string | null }): Promise<string | null> {
    if (!share.beforeMediaId) {
      return null;
    }
    const media = await this.db.query.sourceMedia.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, share.beforeMediaId!), eq(t.workspaceId, share.workspaceId)),
    });
    return media && isWorkspaceSourceKey(share.workspaceId, media.r2Key) ? media.r2Key : null;
  }

  async getPublic(slug: string): Promise<PublicShare | null> {
    const found = await this.publicShare(slug);
    if (!found) {
      return null;
    }
    const { share, job } = found;
    const files = await this.shotFiles(job);
    const heroFile = files.find((f) => f.asset.id === share.assetId) ?? files[0];
    if (!heroFile) {
      return null;
    }
    const title = share.title ?? "A product photo makeover";
    const image = (file: { asset: AssetRow; variant: VariantRow }): PublicShareImage => ({
      ref: `v_${file.variant.id}`,
      src: shareImagePath(slug, `v_${file.variant.id}`),
      alt: `${title}, ${shotLabel(file.asset.shotType).toLowerCase()}`,
    });
    const hasBefore = (await this.beforeKey(share)) !== null;
    const [gallery, product] = await Promise.all([
      this.db.query.galleryItems.findFirst({
        where: (t, { and, eq }) => and(eq(t.shareSlug, share.slug), eq(t.published, true)),
      }),
      this.db.query.products.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, job.productId), eq(t.workspaceId, job.workspaceId)),
      }),
    ]);
    return {
      slug,
      kind: share.kind,
      title,
      category: typeof product?.profile?.category === "string" ? product.profile.category : null,
      before: hasBefore ? { ref: "before", src: shareImagePath(slug, "before"), alt: `${title}, the original photo` } : null,
      after: image(heroFile),
      images: share.kind === "pack" ? [heroFile, ...files.filter((f) => f !== heroFile)].map(image) : [],
      inGallery: gallery !== undefined,
      illustration: false,
    };
  }

  async imageKey(slug: string, ref: string): Promise<string | null> {
    const found = await this.publicShare(slug);
    if (!found) {
      return null;
    }
    const { share, job } = found;
    if (ref === "before") {
      return this.beforeKey(share);
    }
    const match = /^v_(.+)$/.exec(ref);
    if (!match || !isUuid(match[1])) {
      return null;
    }
    const files = await this.shotFiles(job);
    const heroFile = files.find((f) => f.asset.id === share.assetId) ?? files[0];
    // A before and after page serves only its hero; a pack page serves the
    // one displayed file of each shot. Nothing else in the job is reachable.
    const allowed = share.kind === "pack" ? files : heroFile ? [heroFile] : [];
    const file = allowed.find((f) => f.variant.id === match[1]);
    return file && isWorkspaceKey(share.workspaceId, file.variant.r2Key) ? file.variant.r2Key : null;
  }

  async listGallery(limit: number): Promise<GalleryEntry[]> {
    const rows = await this.db
      .select({ slug: shareLinks.slug })
      .from(galleryItems)
      .innerJoin(shareLinks, eq(galleryItems.shareSlug, shareLinks.slug))
      .where(and(eq(galleryItems.published, true), eq(shareLinks.isPublic, true)))
      .orderBy(sql`${galleryItems.consentAt} desc`)
      .limit(Math.max(1, Math.min(limit, 60)));
    const entries: GalleryEntry[] = [];
    for (const row of rows) {
      const share = await this.getPublic(row.slug);
      if (share?.after) {
        entries.push({ slug: share.slug, title: share.title, category: share.category, before: share.before, after: share.after });
      }
    }
    return entries;
  }

  async recordView(slug: string): Promise<void> {
    if (!isShareSlug(slug)) {
      return;
    }
    try {
      await this.db
        .update(shareLinks)
        .set({ views: sql`${shareLinks.views} + 1` })
        .where(and(eq(shareLinks.slug, slug), eq(shareLinks.isPublic, true)));
    } catch (err) {
      console.error("[shares] could not count a view", err instanceof Error ? err.message : err);
    }
  }
}
