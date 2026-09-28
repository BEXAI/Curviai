/**
 * Builds the progress board's shot cards from job_steps and assets rows.
 * Pure, so the mapping is unit testable without a database.
 *
 * Rows per shot: the worker's plan writes a pending row for every planned
 * shot and a skipped row for every shot the planner left out; saveAsset then
 * appends the shot's final row (done or needs_review). The card shows the
 * most advanced row, so a pending row written in the same instant never
 * hides a finished one. Compliance, credits and the needs review reason come
 * from the asset whose qc.shotId matches the card (Update.md 3.6), never from
 * a sibling of the same shot type.
 */

import { needsReviewNote, skippedCopy } from "@/lib/job-copy";
import type { JobShotView, ShotCompliance, ShotStatus } from "./types";

export interface ShotStepRow {
  shotId: string | null;
  stage: string | null;
  provider: string | null;
  status: string | null;
  error: string | null;
  createdAt: Date;
}

export interface ShotAssetRow {
  id: string;
  shotType: string;
  qc: Record<string, unknown> | null;
}

/** Maps a stored step status to a card status. "failed" rows predate the
 * needs_review status (Update.md 3.5): saveAsset wrote them for shots that
 * did not pass and were released at no charge, which is needs review. */
export function toShotStatus(value: string | null): ShotStatus {
  switch (value) {
    case "generating":
    case "qc":
    case "done":
    case "needs_review":
    case "skipped":
      return value;
    case "failed":
      return "needs_review";
    default:
      return "pending";
  }
}

const RANK: Record<ShotStatus, number> = {
  pending: 0,
  generating: 1,
  qc: 2,
  skipped: 3,
  failed: 4,
  needs_review: 4,
  done: 4,
};

/** Stage labels that name the worker itself rather than a kind of work. */
const GENERIC_PROVIDERS = new Set(["worker", "planner"]);

export function complianceFromQc(qc: Record<string, unknown> | null | undefined): ShotCompliance | null {
  if (!qc) {
    return null;
  }
  const background =
    Array.isArray(qc.background) && qc.background.length === 3
      ? ([Number(qc.background[0]), Number(qc.background[1]), Number(qc.background[2])] as [number, number, number])
      : null;
  return {
    pass: qc.pass === true,
    fillPct: typeof qc.fillPct === "number" ? qc.fillPct : null,
    background,
  };
}

function qcShotId(asset: ShotAssetRow): string | null {
  const id = asset.qc?.shotId;
  return typeof id === "string" ? id : null;
}

interface Group {
  best: ShotStepRow;
  bestStatus: ShotStatus;
  stageLabel: string | null;
  firstSeenAt: number;
}

export function buildShotViews(steps: ShotStepRow[], assets: ShotAssetRow[]): JobShotView[] {
  const assetByShot = new Map<string, ShotAssetRow>();
  for (const asset of assets) {
    const shotId = qcShotId(asset);
    if (shotId) {
      assetByShot.set(shotId, asset);
    }
  }

  const ordered = [...steps].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const groups = new Map<string, Group>();
  for (const step of ordered) {
    if (!step.shotId) {
      continue;
    }
    const status = toShotStatus(step.status);
    const label = step.provider && !GENERIC_PROVIDERS.has(step.provider) ? step.provider : null;
    const group = groups.get(step.shotId);
    if (!group) {
      groups.set(step.shotId, {
        best: step,
        bestStatus: status,
        stageLabel: label,
        firstSeenAt: step.createdAt.getTime(),
      });
      continue;
    }
    if (RANK[status] >= RANK[group.bestStatus]) {
      group.best = step;
      group.bestStatus = status;
    }
    group.stageLabel ??= label;
  }

  // Planned shots first, skipped ones last. Within each, the order the shot
  // first appeared; plan rows share one insert timestamp, so ties fall back
  // to the shot id, which the planners number in plan order (s01_, s02_).
  const entries = [...groups.entries()].sort(([idA, a], [idB, b]) => {
    const skippedA = a.bestStatus === "skipped" ? 1 : 0;
    const skippedB = b.bestStatus === "skipped" ? 1 : 0;
    if (skippedA !== skippedB) {
      return skippedA - skippedB;
    }
    if (a.firstSeenAt !== b.firstSeenAt) {
      return a.firstSeenAt - b.firstSeenAt;
    }
    return idA.localeCompare(idB, "en", { numeric: true });
  });

  return entries.map(([shotId, group]) => {
    const asset = assetByShot.get(shotId);
    const qc = asset?.qc ?? null;
    const status = group.bestStatus;
    const specId = typeof qc?.specId === "string" ? qc.specId : null;
    const view: JobShotView = {
      shotId,
      shotType: group.best.stage ?? asset?.shotType ?? "shot",
      providerStage: group.stageLabel ?? "",
      status,
      channels: specId ? [specId] : [],
      credits: status === "done" && typeof qc?.credits === "number" ? qc.credits : 0,
      compliance: status === "done" ? complianceFromQc(qc) : null,
      label: null,
      note: null,
    };
    if (status === "needs_review") {
      const hint = typeof qc?.repairHint === "string" && qc.repairHint ? qc.repairHint : group.best.error;
      view.note = needsReviewNote(hint);
    } else if (status === "skipped") {
      const copy = skippedCopy(group.best.error);
      view.label = copy.label;
      view.note = copy.note;
    }
    return view;
  });
}
