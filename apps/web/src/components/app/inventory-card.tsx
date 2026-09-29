import { Badge, Card, CardContent } from "@curvi/ui";
import { inventoryLines } from "@/lib/inventory-copy";
import type { InventoryItemView, InventoryPhotoView } from "@/lib/services/types";

const STATUS_BADGE: Record<InventoryItemView["status"], { text: string; variant: "success" | "outline" | "default" }> = {
  featured: { text: "Featured", variant: "success" },
  removed: { text: "Removed", variant: "outline" },
  kept: { text: "Kept", variant: "default" },
};

/**
 * What the product inventory found in the seller's photos, next to the
 * before and after: one line per photo that showed more than one product,
 * and each product with what the pack did with it. Renders nothing when
 * every photo showed a single product.
 */
export function InventoryCard({ inventory }: { inventory: InventoryPhotoView[] | null | undefined }) {
  const lines = inventoryLines(inventory);
  if (!inventory || lines.length === 0) {
    return null;
  }
  const photos = inventory.filter((photo) => photo.items.length > 1);
  return (
    <Card data-testid="inventory-card">
      <CardContent className="space-y-3 p-5">
        <h2 className="font-display text-base font-bold tracking-tight text-ink-950">What we found in your photo</h2>
        {photos.map((photo, i) => (
          <div key={i} className="space-y-2">
            <p className="text-sm text-ink-600" data-testid="inventory-line">
              {lines[i]}
            </p>
            <ul className="flex flex-wrap gap-2" aria-label="Products found">
              {photo.items.map((item, j) => (
                <li key={j} className="inline-flex items-center gap-2 text-sm text-ink-800">
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 rounded-full ring-1 ring-ink-950/10"
                    style={{ backgroundColor: item.color || undefined }}
                  />
                  <span>{item.label}</span>
                  <Badge variant={STATUS_BADGE[item.status].variant}>{STATUS_BADGE[item.status].text}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
