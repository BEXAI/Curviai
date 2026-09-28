/**
 * Database backed runtime wiring. When DATABASE_URL is set, tasks and the web
 * app's inline fallback persist job state, assets, ledger settlement and pack
 * files to Postgres and R2 through DbJobStore, and keep the spend cap totals
 * in Postgres. Generation runs on the live providers whose keys are set;
 * because credits are real here, shots no live provider covers go to needs
 * review instead of the demo generator.
 */

import { createDb, type Db } from "@curvi/db";
import { costCaps, undeliverableShotMethods } from "@curvi/pipeline/seed";
import { PgCapStore } from "./cap-store";
import { DbJobStore } from "./db-store";
import type { PipelineDeps } from "./pipeline-runner";
import { buildR2Uploader } from "./r2";
import { buildRuntimeDeps, optionalEnv, type RuntimeDepsOptions } from "./runtime";
import { SpendAlertNotifier, watchGlobalSpend } from "./spend-alerts";

const globalScope = globalThis as typeof globalThis & {
  __curviWorkerDb?: Db;
  __curviSpendAlerts?: SpendAlertNotifier;
};

export function getWorkerDb(url: string): Db {
  // prepare false so the Supabase transaction mode pooler is safe.
  globalScope.__curviWorkerDb ??= createDb(url, { max: 2, prepare: false });
  return globalScope.__curviWorkerDb;
}

/** Deps for a run that persists to Postgres, or null without DATABASE_URL. */
export function buildDbRuntimeDeps(opts: RuntimeDepsOptions = {}): PipelineDeps | null {
  const url = optionalEnv("DATABASE_URL");
  if (!url) {
    return null;
  }
  const db = getWorkerDb(url);
  const store = new DbJobStore(db, {
    reserveHandledExternally: true,
    uploader: buildR2Uploader(),
  });
  // Spend cap totals live in Postgres so every task run, subtask retry and
  // web instance shares them; real credits rule out the demo generator.
  const capStore = new PgCapStore(db);
  // The $50 alert and the hard stop reach the founder once per day each,
  // deduplicated through the shared counters table. Every routed provider
  // call reports the alert line through it too (onCapAlert).
  globalScope.__curviSpendAlerts ??= new SpendAlertNotifier({ db, dedupe: capStore });
  const alerts = globalScope.__curviSpendAlerts;
  const base = buildRuntimeDeps({ ...opts, capStore, realCredits: true, onSpendAlert: alerts.onSpendAlert });
  if (base.ai.caps) {
    watchGlobalSpend(base.ai.caps, alerts);
  }
  return {
    ...base,
    store,
    // Shots whose plan feature is not live yet (video and avatar methods) are
    // skipped, keeping real packs honest instead of charging for placeholder
    // renders; the web estimate leaves the same methods out of the hold.
    // Spend ceilings come from the seed per plan section 4.4.
    excludeShotMethods: [...undeliverableShotMethods],
    assetCostCapMicros: costCaps.imageAssetMicros,
    packCostCapMicros: costCaps.packMicros,
    onSpendAlert: alerts.onSpendAlert,
  };
}

/** Db backed deps when DATABASE_URL exists, demo deps otherwise. */
export function resolveRuntimeDeps(opts: RuntimeDepsOptions = {}): PipelineDeps {
  return buildDbRuntimeDeps(opts) ?? buildRuntimeDeps(opts);
}
