"use client";

import {
  chosenItem,
  keptPhotoHeadsUp,
  readyLine,
  sizeShortfallLine,
  sizeShortfalls,
  type PhotoOutputContext,
} from "@/lib/preflight/copy";
import type { PreflightView } from "@/lib/preflight/types";
import { ProductChooser } from "./product-chooser";

interface PreflightResultProps {
  /** The check's answer; null while it runs or when it could not run. */
  view: PreflightView | null;
  checking: boolean;
  /** Why the check could not run, when it could not. */
  failure?: string | null;
  selected: readonly string[];
  chosen: number | null;
  onChoose: (number: number) => void;
  /** The photo's role shows several items on purpose (in the box). */
  multiItem?: boolean;
  photoLabel: string;
  /** How the pack uses this photo (PHASE_15): a kept photo that feeds no
   * cutout needs no product choice and never blocks on size; its heads ups
   * say what happens instead. Absent means today's pack. */
  output?: PhotoOutputContext;
}

/**
 * What the preflight found in one uploaded photo, under the photo on the
 * new pack form (docs/phases/PHASE_14.md workstream 4): "Found: silver
 * watch. Ready for Amazon, Shopify and Meta.", the chooser when the photo
 * shows several products, or the specific problem with its fix.
 */
export function PreflightResult({
  view,
  checking,
  failure,
  selected,
  chosen,
  onChoose,
  multiItem,
  photoLabel,
  output,
}: PreflightResultProps) {
  if (checking) {
    return (
      <p className="text-xs text-ink-500" data-testid="preflight-checking">
        Checking the photo
      </p>
    );
  }
  if (!view) {
    return failure ? (
      <p className="text-xs text-ink-500" data-testid="preflight-notice">
        {failure}
      </p>
    ) : null;
  }
  if (view.status === "blocked" && view.problem) {
    return (
      <div className="mt-1 rounded-lg border border-red-200 bg-red-50 p-3" role="alert" data-testid="preflight-problem">
        <p className="text-sm font-medium text-red-700">{view.problem.title}</p>
        <p className="mt-1 text-sm text-ink-700">{view.problem.fix}</p>
        {view.problem.tips && view.problem.tips.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-600">
            {view.problem.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  const ready = readyLine(view, selected, chosen);
  const kept = output?.kept === true;
  // A kept photo's size lines come from keptPhotoHeadsUp (left out, never blocked).
  const short = kept ? [] : sizeShortfalls(view, selected, chosen, output);
  const headsUp = keptPhotoHeadsUp(view, selected, chosen, output);
  const showChooser = view.status === "choose" && !multiItem && (output === undefined || output.feedsCutout);
  return (
    <div className="mt-1 space-y-1">
      {showChooser ? (
        <ProductChooser
          items={view.items}
          selected={chosenItem(view, chosen)?.number ?? null}
          onChoose={onChoose}
          photoLabel={photoLabel}
        />
      ) : null}
      {ready && (!showChooser || chosenItem(view, chosen)) ? (
        <p className="text-xs text-emerald-700" data-testid="preflight-ready">
          {ready}
        </p>
      ) : null}
      {view.photo
        ? short.map((s) => (
            <p key={s.specId} className="text-xs text-amber-700" data-testid="preflight-size">
              {sizeShortfallLine(s, view.photo as { width: number; height: number })}
            </p>
          ))
        : null}
      {headsUp.map((line) => (
        <p key={line} className="text-xs text-amber-700" data-testid="preflight-kept">
          {line}
        </p>
      ))}
      {view.notice ? (
        <p className="text-xs text-ink-500" data-testid="preflight-notice">
          {view.notice}
        </p>
      ) : null}
    </div>
  );
}
