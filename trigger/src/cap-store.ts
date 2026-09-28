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
}
