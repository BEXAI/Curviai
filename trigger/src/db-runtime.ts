/**
 * Database backed runtime wiring. When DATABASE_URL is set, tasks and the web
 * app's inline fallback persist job state, assets, ledger settlement and pack
 * files to Postgres and R2 through DbJobStore. Generation itself still runs on
 * the demo providers until real provider routing is seeded, which
 * docs/verification.md records as an open follow up; persistence and credit
 * settlement are real either way.
 */

import { createDb, type Db } from "@curvi/db";
import { DbJobStore } from "./db-store";
import type { PipelineDeps } from "./pipeline-runner";
import { buildR2Uploader } from "./r2";
import { buildRuntimeDeps, optionalEnv, type RuntimeDepsOptions } from "./runtime";

const globalScope = globalThis as typeof globalThis & { __curviWorkerDb?: Db };

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
  return { ...buildRuntimeDeps(opts), store };
}

/** Db backed deps when DATABASE_URL exists, demo deps otherwise. */
export function resolveRuntimeDeps(opts: RuntimeDepsOptions = {}): PipelineDeps {
  return buildDbRuntimeDeps(opts) ?? buildRuntimeDeps(opts);
}
