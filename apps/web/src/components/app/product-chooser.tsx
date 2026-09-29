"use client";

import { cn } from "@curvi/ui";
import type { PreflightItemView } from "@/lib/preflight/types";

interface ProductChooserProps {
  items: PreflightItemView[];
  /** The item the pack is for right now: the seller's tap or the note's pick. */
  selected: number | null;
  onChoose: (number: number) => void;
  /** Names the photo for screen readers when a pack has several. */
  photoLabel: string;
}

/**
 * The product chooser at upload (docs/phases/PHASE_14.md 3.2): a thumbnail
 * of each product the preflight found in the photo, cut from the photo
 * itself. One tap says which product the pack is for.
 */
export function ProductChooser({ items, selected, onChoose, photoLabel }: ProductChooserProps) {
  return (
    <div className="mt-2" role="group" aria-label={`Which product in ${photoLabel} is this pack for`} data-testid="product-chooser">
      <p className="text-sm text-ink-800">
        We found {items.length} products in this photo. Which one is this pack for?
      </p>
      <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {items.map((item) => {
          const active = selected === item.number;
          return (
            <button
              key={item.number}
              type="button"
              aria-pressed={active}
              onClick={() => onChoose(item.number)}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border bg-white p-1.5 text-xs transition-colors",
                active ? "border-ink-900 ring-2 ring-ink-900" : "border-ink-200 hover:border-ink-400",
              )}
              data-testid="chooser-item"
            >
              {item.thumbUrl ? (
                <img
                  src={item.thumbUrl}
                  alt={item.label}
                  width={96}
                  height={96}
                  className="h-20 w-20 rounded object-contain"
                />
              ) : (
                <span className="flex h-20 w-20 items-center justify-center rounded bg-ink-50 text-lg font-semibold text-ink-500">
                  {item.number}
                </span>
              )}
              <span className="line-clamp-2 text-center text-ink-700">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
