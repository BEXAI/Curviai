import type { InventoryItemView, InventoryPhotoView } from "@/lib/services/types";

/** The job row's inventory (generation_jobs.inventory) as the board shows
 * it: labels, colors, shapes and statuses only, never boxes or media keys.
 * Anything malformed is left out. */
export function inventoryView(raw: unknown): InventoryPhotoView[] | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const photos = (raw as { photos?: unknown }).photos;
  if (!Array.isArray(photos)) {
    return null;
  }
  const views = photos.map((photo): InventoryPhotoView => {
    const items = Array.isArray((photo as { items?: unknown })?.items) ? (photo as { items: unknown[] }).items : [];
    const p = photo as { rule?: unknown; vision?: { reason?: unknown } | null } | null;
    const reason = p?.rule === "vision" && typeof p.vision?.reason === "string" ? p.vision.reason.trim().slice(0, 200) : "";
    return {
      ...(reason ? { pickedReason: reason } : {}),
      items: items.flatMap((item): InventoryItemView[] => {
        const i = item as Partial<Record<keyof InventoryItemView | "colorName", unknown>>;
        const status = i.status === "featured" || i.status === "removed" || i.status === "kept" ? i.status : null;
        if (typeof i.label !== "string" || !status) {
          return [];
        }
        return [
          {
            label: i.label.slice(0, 120),
            color: typeof i.colorName === "string" ? i.colorName : "",
            shape: typeof i.shape === "string" ? i.shape : "",
            status,
          },
        ];
      }),
    };
  });
  return views.length > 0 ? views : null;
}

const STATUS_WORD: Record<InventoryItemView["status"], string> = {
  featured: "featured",
  removed: "removed",
  kept: "kept",
};

/** The line saying the featured product was picked by the vision picker,
 * with its short reason, or null when the rules picked it. */
export function pickedLine(photo: InventoryPhotoView): string | null {
  return photo.pickedReason ? `Picked by looking at the photo: ${photo.pickedReason}` : null;
}

/**
 * One plain line per photo that showed more than one product, for example
 * "Found 2 products: Blue Gatorade bottle (featured), red tall object
 * (removed)". With several such photos each line names its photo. Photos
 * with a single product need no line.
 */
export function inventoryLines(inventory: InventoryPhotoView[] | null | undefined): string[] {
  if (!inventory) {
    return [];
  }
  const multi = inventory
    .map((photo, i) => ({ photo, number: i + 1 }))
    .filter(({ photo }) => photo.items.length > 1);
  return multi.map(({ photo, number }) => {
    const list = photo.items.map((item) => `${item.label} (${STATUS_WORD[item.status]})`).join(", ");
    const found = `Found ${photo.items.length} products: ${list}`;
    return multi.length > 1 ? `Photo ${number}. ${found}` : found;
  });
}
