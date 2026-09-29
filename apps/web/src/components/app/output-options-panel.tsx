"use client";

import { useRef, type KeyboardEvent } from "react";
import Link from "next/link";
import { Switch, cn } from "@curvi/ui";
import { LOOK_KEYS, type LookKey } from "@curvi/pipeline/output-options";
import type { TierKey } from "@curvi/pipeline/seed";
import { LOOK_TITLES, type ConflictLine } from "@/lib/output-options-copy";
import {
  EXTRAS_WITH_KEEP_NOTE,
  LISTING_MODE_LINE,
  LOOK_CARD_COPY,
  PHOTO_SHAPE_OPTIONS,
  SWITCH_LABEL,
  brandLookAvailability,
  customChipText,
  extraRows,
  moreOptionsChanged,
  moreOptionsSummary,
  nextLook,
  switchHelper,
  type OutputFormAction,
  type OutputFormState,
  type PreviewFrame,
} from "@/lib/output-options-form";
import { BackgroundColorSelect } from "./background-color-select";
import { OutputPreviewStrip } from "./output-preview-strip";

export interface OutputOptionsPanelProps {
  state: OutputFormState;
  onAction: (action: OutputFormAction) => void;
  tier: TierKey;
  brandColors: readonly string[];
  brandKitsAllowed: boolean;
  /** The chosen color as a hex (white while a brand color is unavailable). */
  colorHex: string;
  /** "Heads up for your channels", already worded. */
  headsUp: readonly ConflictLine[];
  onLeaveOut: (specIds: readonly string[]) => void;
  /** Some picked spec gives a kept photo flat added space, so the color matters with Keep. */
  addedSpace: boolean;
  frames: readonly PreviewFrame[];
  photoUrl?: string | null;
  hasPhoto: boolean;
  /** Set while scenes are paused: the scenes row is off, disabled and says
   * this instead of its cost (the page passes SCENES_PAUSED_COPY, which
   * lives in a server module). */
  scenesPausedNote?: string | null;
  /** Concept packs hide the switch and the color and always remove the background. */
  conceptMode?: boolean;
  onColorProblem?: (problem: string | null) => void;
}

/**
 * Section 3 "How your images look" (docs/phases/PHASE_15.md, UI): the look
 * cards with the Custom chip, Remove the background, the color, the preview
 * strip, the heads ups, Extra images, More options and the Listing Mode line.
 * The state lives in the form (lib/output-options-form.ts); this only draws
 * it and reports what the seller does.
 */
export function OutputOptionsPanel({
  state,
  onAction,
  tier,
  brandColors,
  brandKitsAllowed,
  colorHex,
  headsUp,
  onLeaveOut,
  addedSpace,
  frames,
  photoUrl,
  hasPhoto,
  scenesPausedNote = null,
  conceptMode = false,
  onColorProblem,
}: OutputOptionsPanelProps) {
  const cardRefs = useRef<Partial<Record<LookKey, HTMLDivElement | null>>>({});
  const brand = brandLookAvailability(tier, brandColors);
  const enabledLooks = LOOK_KEYS.filter((look) => look !== "brand" || brand.available);
  const chip = customChipText(state);
  const { choices } = state;
  const keep = choices.background === "keep";
  const changed = moreOptionsChanged(state);

  function pickLook(look: LookKey) {
    if (look === "brand" && !brand.available) return;
    onAction({ type: "look", look });
  }

  function onLookKey(event: KeyboardEvent<HTMLDivElement>, look: LookKey) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      pickLook(look);
      return;
    }
    const next = nextLook(look, event.key, enabledLooks);
    if (next) {
      event.preventDefault();
      pickLook(next);
      cardRefs.current[next]?.focus();
    }
  }

  return (
    <div className="mt-3 space-y-6" data-testid="output-options">
      {conceptMode ? null : (
        <div>
          <div
            role="radiogroup"
            aria-label="Look"
            className="grid gap-3 sm:grid-cols-3"
            data-testid="look-cards"
          >
            {LOOK_KEYS.map((look) => {
              const checked = state.lookBase === look;
              const disabled = look === "brand" && !brand.available;
              return (
                <div
                  key={look}
                  ref={(node) => {
                    cardRefs.current[look] = node;
                  }}
                  role="radio"
                  aria-checked={checked}
                  aria-disabled={disabled || undefined}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => pickLook(look)}
                  onKeyDown={(event) => onLookKey(event, look)}
                  className={cn(
                    "min-h-11 rounded-xl border bg-white p-4 text-left transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600",
                    checked ? "border-accent-600 ring-1 ring-accent-600" : "border-ink-200",
                    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-ink-400",
                  )}
                  data-testid={`look-${look}`}
                >
                  <p className="font-medium text-ink-900">{LOOK_TITLES[look]}</p>
                  <p className="mt-1 text-xs text-ink-500">{LOOK_CARD_COPY[look]}</p>
                  {look === "brand" && !brand.available ? (
                    <Link
                      href={brand.href}
                      onClick={(event) => event.stopPropagation()}
                      className="mt-2 inline-flex min-h-11 items-center text-xs font-medium text-accent-700 underline"
                      data-testid="brand-look-unavailable"
                    >
                      {brand.text}
                    </Link>
                  ) : null}
                </div>
              );
            })}
          </div>
          {chip ? (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-600" data-testid="custom-chip">
              <span className="rounded-full bg-ink-100 px-2.5 py-1">{chip}</span>
              <button
                type="button"
                onClick={() => onAction({ type: "reset" })}
                className="inline-flex min-h-11 items-center px-1 font-medium text-accent-700 underline"
              >
                Reset
              </button>
            </p>
          ) : null}
        </div>
      )}

      {conceptMode ? null : (
        <div className="rounded-xl border border-ink-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <span id="remove-background-label" className="text-sm font-medium text-ink-900">
              {SWITCH_LABEL}
            </span>
            <Switch
              checked={!keep}
              onCheckedChange={(on) => onAction({ type: "background", background: on ? "remove" : "keep" })}
              aria-labelledby="remove-background-label"
              aria-describedby="remove-background-helper"
              data-testid="remove-background"
            />
          </div>
          <p id="remove-background-helper" className="mt-1 text-xs text-ink-500">
            {switchHelper(choices.background)}
          </p>
          {!keep || addedSpace ? (
            <div className="mt-4">
              <BackgroundColorSelect
                choice={choices.color}
                hex={colorHex}
                background={choices.background}
                brandColors={brandColors}
                brandKitsAllowed={brandKitsAllowed}
                onChange={(color) => onAction({ type: "color", color })}
                onProblem={onColorProblem}
              />
            </div>
          ) : null}
        </div>
      )}

      <OutputPreviewStrip
        frames={frames}
        background={conceptMode ? "remove" : choices.background}
        colorHex={colorHex}
        photoUrl={photoUrl}
        hasPhoto={hasPhoto}
      />

      {headsUp.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4" data-testid="heads-up">
          <h3 className="text-sm font-semibold text-amber-900">Heads up for your channels</h3>
          <ul className="mt-2 space-y-2">
            {headsUp.map((line) => (
              <li key={line.text} className="text-sm text-amber-800" data-testid={`heads-up-${line.code}`}>
                {line.text}
                {line.leaveOutLabel && line.specIds.length > 0 ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={() => onLeaveOut(line.specIds)}
                      className="inline-flex min-h-11 items-center font-medium underline"
                      data-testid="leave-out"
                    >
                      {line.leaveOutLabel}
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {conceptMode ? null : (
        <fieldset className="rounded-xl border border-ink-200 bg-white p-4" data-testid="extra-images">
          <legend className="px-1 text-sm font-semibold text-ink-900">Extra images</legend>
          {keep ? <p className="text-xs text-ink-500">{EXTRAS_WITH_KEEP_NOTE}</p> : null}
          <div className="mt-2 space-y-1">
            {extraRows().map((row) => {
              const paused = row.family === "scenes" && scenesPausedNote !== null;
              const checked = !paused && choices.extras[row.family];
              return (
                <label
                  key={row.family}
                  className={cn(
                    "flex min-h-11 items-start gap-3 rounded-lg px-2 py-2",
                    paused ? "cursor-not-allowed text-ink-400" : "cursor-pointer hover:bg-ink-50",
                  )}
                  data-testid={`extra-${row.family}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={paused}
                    onChange={(event) => onAction({ type: "extra", family: row.family, on: event.target.checked })}
                    className="mt-0.5 h-5 w-5 shrink-0 rounded border-ink-300 accent-accent-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink-900">{row.title}</span>
                    <span className="block text-xs text-ink-500">{paused ? scenesPausedNote : row.line}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {keep && !conceptMode ? (
        <details className="rounded-xl border border-ink-200 bg-white" data-testid="more-options">
          <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium text-ink-900">
            {moreOptionsSummary(changed)}
          </summary>
          <fieldset className="px-4 pb-4">
            <legend className="text-sm font-medium text-ink-800">Photo shape</legend>
            <div className="mt-1 space-y-1">
              {PHOTO_SHAPE_OPTIONS.map((option) => (
                <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2">
                  <input
                    type="radio"
                    name="photo-shape"
                    value={option.value}
                    checked={choices.fit === option.value}
                    onChange={() => onAction({ type: "fit", fit: option.value })}
                    className="h-5 w-5 shrink-0 accent-accent-600"
                  />
                  <span className="text-sm text-ink-800">{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </details>
      ) : null}

      <p className="text-xs text-ink-500" data-testid="listing-mode-line">
        {LISTING_MODE_LINE}
      </p>
    </div>
  );
}
