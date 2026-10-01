/**
 * Postgres backed CapStore for the spend caps (plan 4.4). Every Trigger.dev
 * run, subtask retry and web instance builds its own runtime deps, so an in
 * process counter would start at zero each time and the pack cap and the
 * global daily hard stop would never hold. This store keeps the running
 * totals in spend_cap_counters (migration 0010), shared by all of them.
 *
 * add is a single upsert with RETURNING, so concurrent reservations on the
 * same key serialize on the row and each caller sees the true new total;
 * SpendCaps' overshoot rollback then works across processes.
 */

import { sql, type Db } from "@curvi/db";
import type { CapStore } from "@curvi/ai";

type CounterRow = { total_micros: string | number };

/** postgres-js returns the rows array; PGlite (tests) returns { rows }. */
function rowsOf(result: unknown): CounterRow[] {
  if (Array.isArray(result)) {
    return result as CounterRow[];
  }
  return ((result as { rows?: CounterRow[] }).rows ?? []) as CounterRow[];
}

export class PgCapStore implements CapStore {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<number> {
    const rows = rowsOf(await this.db.execute(sql`select total_micros from spend_cap_counters where key = ${key}`));
    return rows[0] ? Number(rows[0].total_micros) : 0;
  }

  async add(key: string, deltaMicros: number): Promise<number> {
    const rows = rowsOf(
      await this.db.execute(
      sql`insert into spend_cap_counters (key, total_micros, updated_at)
          values (${key}, ${Math.round(deltaMicros)}, now())
          on conflict (key) do update
            set total_micros = spend_cap_counters.total_micros + excluded.total_micros,
                updated_at = now()
          returning total_micros`,
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Spend cap counter ${key} could not be updated`);
    }
    return Number(row.total_micros);
  }

  /**
   * Adds several deltas in one statement and returns each key's new total.
   * The LLM monitor (llm-monitor.ts) keeps its usage and traffic counters
   * here, one round trip per metered call. Repeated keys are summed first,
   * since one upsert may not touch a row twice.
   */
  async addMany(deltas: ReadonlyArray<{ key: string; delta: number }>): Promise<Map<string, number>> {
    const merged = new Map<string, number>();
    for (const { key, delta } of deltas) {
      merged.set(key, (merged.get(key) ?? 0) + Math.round(delta));
    }
    const totals = new Map<string, number>();
    if (merged.size === 0) {
      return totals;
    }
    const values = sql.join(
      [...merged].map(([key, delta]) => sql`(${key}, ${delta}, now())`),
      sql`, `,
    );
    const rows = rowsOf(
      await this.db.execute(
        sql`insert into spend_cap_counters (key, total_micros, updated_at)
            values ${values}
            on conflict (key) do update
              set total_micros = spend_cap_counters.total_micros + excluded.total_micros,
                  updated_at = now()
            returning key, total_micros`,
      ),
    ) as Array<CounterRow & { key: string }>;
    for (const row of rows) {
      totals.set(row.key, Number(row.total_micros));
    }
    return totals;
  }

  /** Current totals of every key that starts with prefix (the LLM spend report). */
  async listByPrefix(prefix: string): Promise<Map<string, number>> {
    const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = rowsOf(
      await this.db.execute(
        sql`select key, total_micros from spend_cap_counters where key like ${pattern} escape '\\' order by key`,
      ),
    ) as Array<CounterRow & { key: string }>;
    return new Map(rows.map((row) => [row.key, Number(row.total_micros)]));
  }

  /**
   * Claims a one time key, for example the founder spend alert of one UTC
   * day. True only for the first caller across every process sharing the
   * table; the insert races on the primary key, so exactly one caller wins.
   */
  async claim(key: string): Promise<boolean> {
    const rows = rowsOf(
      await this.db.execute(
        sql`insert into spend_cap_counters (key, total_micros, updated_at)
            values (${key}, 1, now())
            on conflict (key) do nothing
            returning total_micros`,
      ),
    );
    return rows.length > 0;
  }

  /** Gives a claimed one time key back (an alert whose email failed to
   * send), so the next caller in any process can claim it again. */
  async release(key: string): Promise<void> {
    await this.db.execute(sql`delete from spend_cap_counters where key = ${key}`);
  }
}
