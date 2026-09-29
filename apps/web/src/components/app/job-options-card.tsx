import { Card, CardContent } from "@curvi/ui";
import type { Look } from "@curvi/pipeline/output-options";
import type { OutputOptionsSummary } from "@/lib/job-copy";
import { LOOK_TITLES } from "@/lib/output-options-copy";

/** The card heading's look name; a changed preset reads as Custom. */
export function lookTitle(look: Look): string {
  return look === "custom" ? "Custom" : LOOK_TITLES[look];
}

/**
 * "Your choices" on the job page (PHASE_15): the look and one line per
 * choice the pack was made with, from JobView.outputOptions. Renders nothing
 * when the stored options could not be read.
 */
export function JobOptionsCard({ options }: { options: OutputOptionsSummary | null | undefined }) {
  if (!options || options.lines.length === 0) {
    return null;
  }
  return (
    <Card data-testid="job-options-card">
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-base font-bold tracking-tight text-ink-950">Your choices</h2>
          <p className="text-sm font-medium text-ink-600" data-testid="job-options-look">
            {lookTitle(options.look)}
          </p>
        </div>
        <ul className="space-y-1.5" aria-label="Choices for this pack">
          {options.lines.map((line) => (
            <li key={line} className="text-sm text-ink-600" data-testid="job-options-line">
              {line}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
