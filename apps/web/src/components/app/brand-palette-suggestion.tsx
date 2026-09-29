"use client";

import { useState } from "react";
import { Button, cn } from "@curvi/ui";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import { confirmedColors } from "@/lib/brand/confirm";
import type { BrandKitSuggestion, ContrastPair } from "@/lib/brand/types";

interface BrandPaletteSuggestionProps {
  suggestion: BrandKitSuggestion;
  maxColors: number;
  /** Called with the confirmed colors; the form then holds them until the
   * seller saves the kit. */
  onUse: (colors: string[]) => void;
  onDismiss: () => void;
}

function Swatch({ hex, text, label }: { hex: string; text: ContrastPair; label: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-10 w-14 shrink-0 items-center justify-center rounded-lg border border-ink-200 text-sm font-semibold"
      style={{ backgroundColor: hex, color: text.textHex }}
      title={label}
    >
      Aa
    </span>
  );
}

function ReadabilityNote({ text }: { text: ContrastPair }) {
  return (
    <span className={cn("text-xs", text.passes ? "text-ink-400" : "text-amber-700")}>
      {text.passes ? brandKitCopy.paletteReadable : brandKitCopy.paletteHardToRead}
    </span>
  );
}

/**
 * The logo palette as suggestions (PHASE_16 workstream 7): every color is
 * checked by default and the seller can uncheck any, plus the pale
 * background. Use these colors only fills the form; the kit is saved by
 * the form's save button.
 */
export function BrandPaletteSuggestion({ suggestion, maxColors, onUse, onDismiss }: BrandPaletteSuggestionProps) {
  const [picked, setPicked] = useState<string[]>(suggestion.colors.map((c) => c.hex));
  const [keepBackground, setKeepBackground] = useState(true);
  const colors = confirmedColors(suggestion, picked, keepBackground, maxColors);

  function toggle(hex: string, on: boolean) {
    setPicked((current) =>
      on ? suggestion.colors.map((c) => c.hex).filter((h) => h === hex || current.includes(h)) : current.filter((h) => h !== hex),
    );
  }

  return (
    <div className="rounded-xl border border-ink-950/10 bg-ink-50 p-4" data-testid="brand-palette-suggestion">
      <p className="text-sm font-semibold text-ink-950">{brandKitCopy.paletteTitle}</p>
      <p className="mt-1 text-xs text-ink-500">{brandKitCopy.paletteIntro}</p>
      {suggestion.source === "vision" ? (
        <p className="mt-1 text-xs text-ink-500">{brandKitCopy.paletteNamedNote}</p>
      ) : null}
      <ul className="mt-3 space-y-2">
        {suggestion.colors.map((color) => (
          <li key={color.hex}>
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={picked.includes(color.hex)}
                onChange={(event) => toggle(color.hex, event.target.checked)}
                aria-label={`Use ${color.name} ${color.hex}`}
              />
              <Swatch hex={color.hex} text={color.text} label={color.hex} />
              <span className="flex flex-col">
                <span className="text-sm text-ink-900">
                  <span className="capitalize">{color.name}</span> <span className="font-mono text-ink-500">{color.hex}</span>
                </span>
                <ReadabilityNote text={color.text} />
              </span>
            </label>
          </li>
        ))}
        <li>
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={keepBackground}
              onChange={(event) => setKeepBackground(event.target.checked)}
              aria-label={brandKitCopy.paletteBackgroundLabel}
            />
            <Swatch hex={suggestion.background.hex} text={suggestion.background.text} label={suggestion.background.hex} />
            <span className="flex flex-col">
              <span className="text-sm text-ink-900">
                {brandKitCopy.paletteBackgroundLabel}{" "}
                <span className="font-mono text-ink-500">{suggestion.background.hex}</span>
              </span>
              <span className="text-xs text-ink-400">{brandKitCopy.paletteBackgroundHint}</span>
            </span>
          </label>
        </li>
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" onClick={() => onUse(colors)} disabled={colors.length === 0}>
          {brandKitCopy.paletteUse}
        </Button>
        <Button type="button" variant="ghost" onClick={onDismiss}>
          {brandKitCopy.paletteDismiss}
        </Button>
      </div>
    </div>
  );
}
