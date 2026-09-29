"use client";

import type { OutputChoices } from "@curvi/pipeline/output-options";
import {
  PREVIEW_CAPTION,
  PREVIEW_EMPTY,
  PREVIEW_SILHOUETTE_LABEL,
  frameHex,
  type PreviewFrame,
} from "@/lib/output-options-form";

interface OutputPreviewStripProps {
  frames: readonly PreviewFrame[];
  background: OutputChoices["background"];
  /** The chosen color as a hex. */
  colorHex: string;
  /** Object URL of the seller's front photo, when there is one. */
  photoUrl?: string | null;
  /** The form has a photo (uploaded or stored), even without a preview. */
  hasPhoto: boolean;
}

/**
 * A quick look at the choices (PHASE_15 UI item 4): two or three frames in
 * each spec's aspect ratio on the chosen color. With Keep the seller's photo
 * sits inside (object-fit contain); with Remove a neutral silhouette stands
 * in until the cutout preview lands in P1. Scrolls sideways with snap on a
 * phone; this strip is the one place the form may scroll sideways.
 */
export function OutputPreviewStrip({ frames, background, colorHex, photoUrl, hasPhoto }: OutputPreviewStripProps) {
  if (frames.length === 0) {
    return null;
  }
  return (
    <figure data-testid="preview-strip">
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {frames.map((frame) => (
          <div key={frame.specId} className="w-32 shrink-0 snap-start sm:w-36" data-testid={`preview-${frame.specId}`}>
            <div
              className="relative flex w-full items-center justify-center overflow-hidden rounded-lg ring-1 ring-inset ring-ink-950/15"
              style={{ aspectRatio: `${frame.width} / ${frame.height}`, backgroundColor: frameHex(frame, colorHex) }}
            >
              {background === "keep" && !frame.white && photoUrl ? (
                <img src={photoUrl} alt="" decoding="async" className="h-full w-full object-contain" />
              ) : background === "remove" || hasPhoto ? (
                <span className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-2">
                  <span aria-hidden="true" className="block aspect-[3/4] w-2/5 rounded-[40%_40%_28%_28%] bg-black/20" />
                  <span className="text-center text-[0.625rem] leading-tight text-black/60">
                    {PREVIEW_SILHOUETTE_LABEL}
                  </span>
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 text-xs text-ink-600">{frame.label}</p>
          </div>
        ))}
      </div>
      <figcaption className="mt-1 text-xs text-ink-500">
        {hasPhoto ? PREVIEW_CAPTION : PREVIEW_EMPTY}
      </figcaption>
    </figure>
  );
}
