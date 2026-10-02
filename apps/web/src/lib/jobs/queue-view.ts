import { sql, type Db } from "@curvi/db";
import { queue } from "@curvi/pipeline/seed";
import { readInlineRunnerConfig } from "./inline-runner";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[];
}

/** Called only after the service's tenant-scoped job lookup. The global
 * query returns a count and duration, never another workspace's identity. */
export async function queueView(db: Db, jobId: string): Promise<{ position: number; etaSeconds: number }> {
  const [count] = rowsOf<{ position: number }>(await db.execute(sql`
    select count(*)::int as position from generation_jobs j
    where j.status = 'queued' and (j.created_at, j.id) <=
      (select created_at, id from generation_jobs where id = ${jobId}::uuid)`));
  const durations = rowsOf<{ seconds: number }>(await db.execute(sql`
    select extract(epoch from finished_at - started_at)::float8 as seconds
    from generation_jobs where status = 'done' and started_at is not null
      and finished_at > started_at
    order by finished_at desc limit ${queue.etaSampleSize}`)).map((r) => Number(r.seconds)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length === 0 ? queue.etaDefaultSeconds
    : durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
  const position = Math.max(1, Number(count?.position ?? 1));
  return { position, etaSeconds: Math.ceil(Math.ceil(position / readInlineRunnerConfig((name) => process.env[name]).concurrency) * median) };
}
