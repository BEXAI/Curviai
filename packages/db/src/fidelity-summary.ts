/**
 * The pack fidelity summary (docs/phases/PHASE_18.md P18-08): across the
 * files a pack delivered, how many carry measured fidelity numbers and the
 * highest mean color difference inside the product among them. The pack
 * ready email (P18-07), the operator outreach kit (P18-04) and share pages
 * (P18-16) quote it.
 *
 * It reads assets.qc.outputs, which the runner writes for every passed
 * channel output (trigger/src/db-store.ts saveAsset), joined to the files
 * that ship: picked asset_variants of approved assets of the job. Packs
 * made before Phase 18 have no outputs and summarize as no files measured;
 * nothing is recomputed, since their masks and references are not stored.
 *
 * Every read is scoped to the job's workspace by hand, because the server's
 * owner connection bypasses row level security.
 */

import { sql } from "drizzle-orm";
import type { Db } from "./client";

export interface PackFidelitySummary {
  /** Files the pack delivers (picked files of approved assets). */
  deliveredFiles: number;
  /** Delivered files with measured fidelity numbers. */
  measuredFiles: number;
  /** The highest mean color difference inside the product among the
   * measured files, or null when none was measured. */
  highestMeanDeltaE: number | null;
  /** The largest single pixel difference among them, or null. */
  highestMaxDeltaE: number | null;
  /** True when every measured file is inside its own limits. */
  allWithinLimits: boolean;
}

type SummaryReader = Pick<Db, "execute">;

/** postgres-js returns the rows array; PGlite (tests) returns { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function packFidelitySummary(
  db: SummaryReader,
  input: { jobId: string; workspaceId: string },
): Promise<PackFidelitySummary> {
  const result = await db.execute(sql`
    with delivered as (
      select a.qc, v.channel_spec_id
      from asset_variants v
      join assets a on a.id = v.asset_id and a.workspace_id = v.workspace_id
      where a.job_id = ${input.jobId}::uuid
        and a.workspace_id = ${input.workspaceId}::uuid
        and a.approved
        and v.picked
    ),
    measured as (
      select
        (o.value -> 'fidelity' ->> 'meanDeltaE')::float8 as mean,
        (o.value -> 'fidelity' ->> 'maxDeltaE')::float8 as max,
        (o.value -> 'fidelity' ->> 'threshold')::float8 as threshold,
        (o.value -> 'fidelity' ->> 'maxDeltaELimit')::float8 as max_limit
      from delivered d
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(d.qc -> 'outputs') = 'array' then d.qc -> 'outputs' else '[]'::jsonb end
      ) as o(value)
      where o.value ->> 'specId' = d.channel_spec_id
        and jsonb_typeof(o.value -> 'fidelity') = 'object'
        and jsonb_typeof(o.value -> 'fidelity' -> 'meanDeltaE') = 'number'
        and jsonb_typeof(o.value -> 'fidelity' -> 'maxDeltaE') = 'number'
    )
    select
      (select count(*) from delivered) as delivered_files,
      (select count(*) from measured) as measured_files,
      (select max(mean) from measured) as highest_mean,
      (select max(max) from measured) as highest_max,
      (select count(*) from measured where mean > threshold or max > max_limit) as outside_limits
  `);
  const row = rowsOf<Record<string, unknown>>(result)[0] ?? {};
  const measuredFiles = Number(row.measured_files ?? 0);
  return {
    deliveredFiles: Number(row.delivered_files ?? 0),
    measuredFiles,
    highestMeanDeltaE: numberOrNull(row.highest_mean),
    highestMaxDeltaE: numberOrNull(row.highest_max),
    allWithinLimits: Number(row.outside_limits ?? 0) === 0,
  };
}
