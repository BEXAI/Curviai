"use client";

import { useState } from "react";
import { Badge, Button } from "@curvi/ui";
import type { PackActionResult } from "@/components/app/pack-actions";
import { announcePackFilesChanged } from "@/components/app/pack-downloads";
import type { JobView, ShotVersionView } from "@/lib/services/types";
import { VERSION_COPY } from "@/lib/variation-picks";

/**
 * The version line on a scene card (docs/phases/PHASE_16.md workstream 6):
 * which version of the scene it is, whether its files ship, and on a
 * finished pack a button that picks or leaves it out. Picking never charges.
 */
export function VersionPick({
  jobId,
  shotId,
  version,
  canPick,
  onDone,
}: {
  jobId: string;
  shotId: string;
  version: ShotVersionView;
  canPick: boolean;
  onDone: (result: PackActionResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    if (busy) return;
    setBusy(true);
    const next = !version.picked;
    try {
      const response = await fetch(`/api/jobs/${jobId}/shots/${encodeURIComponent(shotId)}/pick`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ picked: next }),
      });
      const data = (await response.json().catch(() => null)) as { job?: JobView; error?: string } | null;
      if (response.ok && data?.job) {
        onDone({ job: data.job, notice: VERSION_COPY.saved(next), error: null });
        // A pick changes which files ship and drops the channel zips.
        announcePackFilesChanged(jobId);
      } else {
        onDone({ job: null, notice: null, error: data?.error ?? VERSION_COPY.failed });
      }
    } catch {
      onDone({ job: null, notice: null, error: VERSION_COPY.failed });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="version-pick" data-picked={version.picked ? "true" : "false"}>
      <span className="font-mono text-xs text-ink-500">{VERSION_COPY.label(version.number)}</span>
      <Badge variant={version.picked ? "success" : "outline"}>{version.picked ? VERSION_COPY.picked : VERSION_COPY.notPicked}</Badge>
      {canPick ? (
        <Button size="sm" variant="outline" onClick={() => void pick()} disabled={busy} data-testid="version-pick-toggle">
          {busy ? VERSION_COPY.picking : version.picked ? VERSION_COPY.unpick : VERSION_COPY.pick}
        </Button>
      ) : null}
    </div>
  );
}
