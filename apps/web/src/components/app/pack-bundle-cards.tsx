"use client";

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@curvi/ui";
import type { BundleKey } from "@curvi/pipeline/output-options";
import {
  BUNDLE_CARD_COPY,
  BUNDLE_CARD_KEYS,
  BUNDLE_GROUP_LABEL,
  bundleTitle,
  nextLook,
  totalLine,
} from "@/lib/output-options-form";

export interface PackBundleCardsProps {
  /** The picked bundle. */
  bundle: BundleKey;
  onPick: (bundle: BundleKey) => void;
  /** Each card's figure for this pack (bundleEstimates). */
  estimates: Readonly<Record<BundleKey, number>>;
}

/**
 * The bundle cards above the channel list (docs/phases/PHASE_16.md
 * workstream 1): "how much" the pack makes, beside the Looks, which answer
 * "how it looks". A radiogroup in the Phase 15 look card style, each card
 * with its credit figure for the channels picked. Picking a card moves the
 * Extra images switches to the bundle's start; changing one shows the look's
 * Custom chip, as in Phase 15.
 */
export function PackBundleCards({ bundle, onPick, estimates }: PackBundleCardsProps) {
  const cardRefs = useRef<Partial<Record<BundleKey, HTMLDivElement | null>>>({});

  function onKey(event: KeyboardEvent<HTMLDivElement>, key: BundleKey) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      onPick(key);
      return;
    }
    const next = nextLook<BundleKey>(key, event.key, BUNDLE_CARD_KEYS);
    if (next) {
      event.preventDefault();
      onPick(next);
      cardRefs.current[next]?.focus();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={BUNDLE_GROUP_LABEL}
      className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="bundle-cards"
    >
      {BUNDLE_CARD_KEYS.map((key) => {
        const checked = bundle === key;
        return (
          <div
            key={key}
            ref={(node) => {
              cardRefs.current[key] = node;
            }}
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onPick(key)}
            onKeyDown={(event) => onKey(event, key)}
            className={cn(
              "min-h-11 cursor-pointer rounded-xl border bg-white p-4 text-left transition-colors hover:border-ink-400",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600",
              checked ? "border-accent-600 ring-1 ring-accent-600" : "border-ink-200",
            )}
            data-testid={`bundle-${key}`}
          >
            <p className="font-medium text-ink-900">{bundleTitle(key)}</p>
            <p className="mt-1 text-xs text-ink-500">{BUNDLE_CARD_COPY[key]}</p>
            <p className="mt-2 text-xs font-medium text-ink-700" data-testid={`bundle-${key}-credits`}>
              {totalLine(estimates[key])}
            </p>
          </div>
        );
      })}
    </div>
  );
}
