/**
 * The suppression list as the web app uses it (docs/phases/PHASE_18.md
 * P18-06): the one click unsubscribe, the unsubscribe page, the Resend
 * bounce webhook and the settings toggle all write through one store. In db
 * mode it is email_suppressions over the owner connection (the table has no
 * client privileges); in demo mode a per process map, so the pages work with
 * zero env vars.
 */

import {
  addSuppression,
  blocks,
  liftMarketingSuppression,
  normalizedEmailKey,
  suppressionOf,
  type LiftResult,
} from "@curvi/email";
import type { EmailSuppressionReason, EmailSuppressionScope } from "@curvi/db";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export interface SuppressionStore {
  add(recipientKey: string, scope: EmailSuppressionScope, reason: EmailSuppressionReason): Promise<void>;
  scopeOf(recipientKey: string): Promise<EmailSuppressionScope | null>;
  liftMarketing(recipientKey: string): Promise<LiftResult>;
}

export class DbSuppressionStore implements SuppressionStore {
  constructor(private readonly db: ReturnType<typeof getDb>) {}

  add(recipientKey: string, scope: EmailSuppressionScope, reason: EmailSuppressionReason): Promise<void> {
    return addSuppression(this.db, recipientKey, scope, reason);
  }

  scopeOf(recipientKey: string): Promise<EmailSuppressionScope | null> {
    return suppressionOf(this.db, recipientKey);
  }

  liftMarketing(recipientKey: string): Promise<LiftResult> {
    return liftMarketingSuppression(this.db, recipientKey);
  }
}

/** Demo mode and tests: the same rules as the table, bounded in size. */
export class MemorySuppressionStore implements SuppressionStore {
  readonly rows = new Map<string, { scope: EmailSuppressionScope; reason: EmailSuppressionReason }>();

  constructor(private readonly maxRows = 10_000) {}

  async add(recipientKey: string, scope: EmailSuppressionScope, reason: EmailSuppressionReason): Promise<void> {
    const existing = this.rows.get(recipientKey);
    if (existing && !(existing.scope === "marketing" && scope === "all")) {
      return;
    }
    if (!existing && this.rows.size >= this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) this.rows.delete(oldest);
    }
    this.rows.set(recipientKey, { scope, reason });
  }

  async scopeOf(recipientKey: string): Promise<EmailSuppressionScope | null> {
    return this.rows.get(recipientKey)?.scope ?? null;
  }

  async liftMarketing(recipientKey: string): Promise<LiftResult> {
    const existing = this.rows.get(recipientKey);
    if (!existing) return "none";
    if (existing.scope === "all") return "blocked";
    this.rows.delete(recipientKey);
    return "lifted";
  }
}

const globalScope = globalThis as typeof globalThis & { __curviSuppressionStore?: SuppressionStore };

export function getSuppressionStore(): SuppressionStore {
  if (globalScope.__curviSuppressionStore) {
    return globalScope.__curviSuppressionStore;
  }
  if (isDbMode()) {
    return new DbSuppressionStore(getDb());
  }
  globalScope.__curviSuppressionStore = new MemorySuppressionStore();
  return globalScope.__curviSuppressionStore;
}

/** Test hook: swap the process wide store (null resets to the default). */
export function setSuppressionStoreForTests(store: SuppressionStore | null): void {
  globalScope.__curviSuppressionStore = store ?? undefined;
}

/** Whether an address gets tips and offers, as the settings toggle shows it. */
export async function marketingAllowed(email: string | null | undefined, store: SuppressionStore = getSuppressionStore()): Promise<boolean> {
  const key = normalizedEmailKey(email);
  if (!key) return false;
  return !blocks(await store.scopeOf(key), "marketing");
}
