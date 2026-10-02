/**
 * The free preview's runtime wiring (docs/phases/PHASE_18.md P18-12), with
 * a test hook. Server only. Built only when the gates are checked, so a
 * deploy without the feature never opens a database connection for it.
 */

import type { CapStore } from "@curvi/ai";
import { platformSettings, eq, type Db } from "@curvi/db";
import { PgCapStore } from "@curvi/trigger/cap-store";
import { acquisitionStatus } from "@/lib/acquisition";
import { isR2Configured } from "@/lib/env";
import { getLeadStore, type LeadStore } from "@/lib/leads";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { claimFreePreviewSafely } from "./claim";
import { freePreviewOn } from "./copy";
import { FREE_PREVIEW_SWITCH_KEY, freePreviewSwitchOn, previewSetupGaps, type PreviewGateDeps } from "./gate";
import { defaultFreePreviewRun, r2PreviewStorage, type FreePreviewServiceDeps } from "./service";

export interface FreePreviewDeps extends FreePreviewServiceDeps, PreviewGateDeps {
  counters: CapStore;
  leads: LeadStore;
}

/**
 * The acquisition gate (P18-03, apps/web/src/lib/acquisition.ts) is open:
 * packs are not paused, every configured fal account is above the pause
 * line, and the founder's acquisition_paused switch is off. Cached per
 * process like /api/status; never throws (an error reads as open there).
 */
export async function previewAcquisitionOpen(): Promise<boolean> {
  const { state } = await acquisitionStatus();
  return state === "open";
}

async function readSwitch(db: Db): Promise<unknown> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, FREE_PREVIEW_SWITCH_KEY))
    .limit(1);
  return row?.value;
}

const scope = globalThis as typeof globalThis & { __curviFreePreviewDeps?: FreePreviewDeps };

/**
 * The process wide deps, or null while the preview is not set up
 * (previewSetupGaps): routes answer "not available" then, without touching
 * the database or storage.
 */
export function freePreviewDepsOrNull(): FreePreviewDeps | null {
  if (scope.__curviFreePreviewDeps) {
    return scope.__curviFreePreviewDeps;
  }
  if (previewSetupGaps().length > 0) {
    return null;
  }
  const db = getDb();
  return {
    db,
    counters: new PgCapStore(db),
    storage: r2PreviewStorage(),
    run: defaultFreePreviewRun,
    leads: getLeadStore(),
    setupGaps: previewSetupGaps,
    switchOn: () => freePreviewSwitchOn(() => readSwitch(db)),
    acquisitionOpen: previewAcquisitionOpen,
    now: () => new Date(),
  };
}

/** Test hook: swap the deps (null resets to the defaults). */
export function setFreePreviewDepsForTests(deps: FreePreviewDeps | null): void {
  scope.__curviFreePreviewDeps = deps ?? undefined;
}

/**
 * The claim the auth callback makes for a fresh signup whose signup link
 * carried a preview id (P18-12): null when there is none, the feature is
 * off in this build, or the claim is refused or fails; never throws.
 */
export async function claimSignupPreview(
  previewId: string | null | undefined,
  userId: string | null,
): Promise<{ productId: string } | null> {
  if (!previewId || !userId || !freePreviewOn() || !isDbMode() || !isR2Configured()) {
    return null;
  }
  try {
    return await claimFreePreviewSafely(
      { db: getDb(), storage: r2PreviewStorage(), now: () => new Date() },
      { previewId, userId },
    );
  } catch (err) {
    console.error("[free-preview] could not start the claim", err);
    return null;
  }
}
