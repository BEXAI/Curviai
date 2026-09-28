/**
 * Stores emails left on the free tools (plan 9.7). In db mode the leads
 * table holds one row per email (migration 0016), written over the owner
 * connection because the table has no client privileges at all. Demo mode
 * keeps them in memory so the gate works with zero env vars.
 *
 * Nothing is sent to a list provider yet: Loops needs an account
 * (docs/PENDING.md). The rows are ready to import once it exists.
 */

import { leads, sql } from "@curvi/db";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import type { LeadSource } from "@/lib/validation/lead";

export interface LeadStore {
  save(email: string, source: LeadSource): Promise<void>;
}

/** Insert, or bump hits, last_source and last_seen_at for a known email. */
export class DbLeadStore implements LeadStore {
  constructor(private readonly db: ReturnType<typeof getDb>) {}

  async save(email: string, source: LeadSource): Promise<void> {
    await this.db
      .insert(leads)
      .values({ email, source })
      .onConflictDoUpdate({
        target: leads.email,
        set: {
          hits: sql`${leads.hits} + 1`,
          lastSource: source,
          lastSeenAt: new Date(),
        },
      });
  }
}

/** Per process store for demo mode and tests. Bounded so it cannot grow forever. */
export class MemoryLeadStore implements LeadStore {
  readonly rows = new Map<string, { source: LeadSource; lastSource: LeadSource; hits: number }>();

  constructor(private readonly maxRows = 10_000) {}

  async save(email: string, source: LeadSource): Promise<void> {
    const existing = this.rows.get(email);
    if (existing) {
      existing.hits += 1;
      existing.lastSource = source;
      return;
    }
    if (this.rows.size >= this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) {
        this.rows.delete(oldest);
      }
    }
    this.rows.set(email, { source, lastSource: source, hits: 1 });
  }
}

const globalScope = globalThis as typeof globalThis & { __curviLeadStore?: LeadStore };

export function getLeadStore(): LeadStore {
  if (isDbMode()) {
    return new DbLeadStore(getDb());
  }
  if (!globalScope.__curviLeadStore) {
    globalScope.__curviLeadStore = new MemoryLeadStore();
  }
  return globalScope.__curviLeadStore;
}

/** Test hook: swap the process wide store (null resets to the default). */
export function setLeadStoreForTests(store: LeadStore | null): void {
  globalScope.__curviLeadStore = store ?? undefined;
}
