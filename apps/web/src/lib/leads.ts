/**
 * Stores emails left on the free tools (plan 9.7). In db mode the leads
 * table holds one row per email (migration 0016), written over the owner
 * connection because the table has no client privileges at all. Demo mode
 * keeps them in memory so the gate works with zero env vars.
 *
 * Marketing consent (docs/phases/PHASE_18.md P18-06, founder decision 5):
 * when the visitor ticks "Also send me tips on listing images and the
 * occasional offer", marketing_consent_at and consent_source record the
 * first time, and the tool with the wording version the box showed
 * ("main-image-checker@2026-10-01", consentRecord). A later visit without
 * the box never clears it (an
 * unsubscribe does that, through the suppression list), and a lead captured
 * before the box shipped has none, so it never gets marketing email.
 * Lifecycle email (P18-07) reads these rows; nothing goes to a list provider.
 */

import { leads, sql } from "@curvi/db";
import { MARKETING_CONSENT_VERSION } from "@/lib/email/copy";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import type { LeadSource } from "@/lib/validation/lead";

/** What consent_source stores: the tool and the consent wording version. */
export function consentRecord(source: LeadSource): string {
  return `${source}@${MARKETING_CONSENT_VERSION}`;
}

export interface LeadSaveOptions {
  /** True only when the visitor ticked the consent box. */
  marketingConsent?: boolean;
}

export interface LeadStore {
  save(email: string, source: LeadSource, options?: LeadSaveOptions): Promise<void>;
}

/** Insert, or bump hits, last_source and last_seen_at for a known email. */
export class DbLeadStore implements LeadStore {
  constructor(private readonly db: ReturnType<typeof getDb>) {}

  async save(email: string, source: LeadSource, options: LeadSaveOptions = {}): Promise<void> {
    const now = new Date();
    const consent = options.marketingConsent === true;
    await this.db
      .insert(leads)
      .values({
        email,
        source,
        marketingConsentAt: consent ? now : null,
        consentSource: consent ? consentRecord(source) : null,
      })
      .onConflictDoUpdate({
        target: leads.email,
        set: {
          hits: sql`${leads.hits} + 1`,
          lastSource: source,
          lastSeenAt: now,
          // The first consent is kept; a visit without the box changes nothing.
          ...(consent
            ? {
                marketingConsentAt: sql`coalesce(${leads.marketingConsentAt}, excluded.marketing_consent_at)`,
                consentSource: sql`coalesce(${leads.consentSource}, excluded.consent_source)`,
              }
            : {}),
        },
      });
  }
}

interface MemoryLeadRow {
  source: LeadSource;
  lastSource: LeadSource;
  hits: number;
  marketingConsentAt?: Date;
  consentSource?: string;
}

/** Per process store for demo mode and tests. Bounded so it cannot grow forever. */
export class MemoryLeadStore implements LeadStore {
  readonly rows = new Map<string, MemoryLeadRow>();

  constructor(private readonly maxRows = 10_000) {}

  async save(email: string, source: LeadSource, options: LeadSaveOptions = {}): Promise<void> {
    const consent = options.marketingConsent === true;
    const existing = this.rows.get(email);
    if (existing) {
      existing.hits += 1;
      existing.lastSource = source;
      if (consent && !existing.marketingConsentAt) {
        existing.marketingConsentAt = new Date();
        existing.consentSource = consentRecord(source);
      }
      return;
    }
    if (this.rows.size >= this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) {
        this.rows.delete(oldest);
      }
    }
    const row: MemoryLeadRow = { source, lastSource: source, hits: 1 };
    if (consent) {
      row.marketingConsentAt = new Date();
      row.consentSource = consentRecord(source);
    }
    this.rows.set(email, row);
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
