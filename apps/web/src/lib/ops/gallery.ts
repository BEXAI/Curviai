import { and, eq, galleryItems, shareLinks, sql, type Db } from "@curvi/db";
import { opsAlertPolicy } from "@curvi/pipeline/seed";
import { isOperator, type OpsCandidate } from "@/lib/ops";
import { clearGalleryCache } from "@/lib/shares/db-store";
import { isUuid } from "@/lib/validation/ids";
import { writeOpsAudit } from "./audit";

export async function listGalleryQueue(db: Db) {
  return db.select({
    id: galleryItems.id,
    workspaceId: galleryItems.workspaceId,
    slug: shareLinks.slug,
    title: shareLinks.title,
    category: galleryItems.category,
    submittedAt: galleryItems.consentAt,
  }).from(galleryItems).innerJoin(shareLinks, and(
    eq(galleryItems.shareSlug, shareLinks.slug), eq(galleryItems.workspaceId, shareLinks.workspaceId),
  )).where(and(eq(galleryItems.reviewStatus, "pending"), eq(galleryItems.published, true), eq(shareLinks.isPublic, true)))
    .orderBy(galleryItems.consentAt).limit(opsAlertPolicy.galleryPageSize);
}

/** Callers supply the verified operator session, never request fields. */
export async function reviewGalleryItem(db: Db, input: {
  itemId: string;
  decision: "approved" | "rejected";
  operator: OpsCandidate;
  aal: string;
  now?: Date;
}): Promise<void> {
  if (input.aal !== "aal2" || !isOperator(input.operator)) throw new Error("Operator verification required");
  if (!isUuid(input.itemId) || !["approved", "rejected"].includes(input.decision)) throw new Error("Invalid gallery review");
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const found = await tx.execute(sql`select g.id, g.workspace_id, g.review_status
      from gallery_items g join share_links s on s.slug = g.share_slug and s.workspace_id = g.workspace_id
      where g.id = ${input.itemId}::uuid and g.published and s.public for update of g`);
    const rows = (Array.isArray(found) ? found : (found as unknown as { rows: unknown[] }).rows) as Array<{ id: string; workspace_id: string; review_status: string }>;
    if (!rows[0]) throw new Error("Gallery submission is no longer available");
    await tx.update(galleryItems).set({ reviewStatus: input.decision, reviewedAt: now, reviewedBy: input.operator.email! }).where(eq(galleryItems.id, input.itemId));
    await writeOpsAudit(tx, {
      operatorEmail: input.operator.email!, action: `gallery.${input.decision === "approved" ? "approve" : "reject"}`,
      targetKind: "gallery_item", targetId: input.itemId, workspaceId: rows[0].workspace_id,
      detail: { previousStatus: rows[0].review_status, reviewStatus: input.decision },
    }, now);
  });
  clearGalleryCache(db);
}
