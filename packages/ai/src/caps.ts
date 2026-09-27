/**
 * Spend caps as pure logic over an injectable store.
 *
 * The numbers below are platform constants fixed by CURVI_BUILD_PLAN.md
 * section 4.4: $0.60 per image asset, $3.00 per video asset, $8.00 per pack,
 * a daily workspace ceiling of 3 times the plan's expected daily spend, a
 * global daily alert at $50 and a global daily hard stop at $150. This module
 * is the single allowed home for these hardcoded amounts; nothing else in the
 * codebase may repeat them.
 *
 * checkAndReserve semantics: the requested amount is added to the running
 * total only when it fits under the cap. On a concurrent overshoot the
 * reservation rolls itself back and reports blocked. Callers release
 * reservations for failed work with release(result.key, micros).
 */

export const SPEND_CAPS = {
  perImageAssetMicros: 600_000,
  perVideoAssetMicros: 3_000_000,
  perPackMicros: 8_000_000,
  /** Daily workspace ceiling multiplier over the plan's expected daily spend. */
  workspaceDailyMultiplier: 3,
  globalDailyAlertMicros: 50_000_000,
  globalDailyHardStopMicros: 150_000_000,
} as const;

export function dailyWorkspaceCeilingMicros(planExpectedDailyMicros: number): number {
  return planExpectedDailyMicros * SPEND_CAPS.workspaceDailyMultiplier;
}

/** Pluggable running total store. Upstash Redis in production, in memory in
 * tests. add returns the new total and must be atomic per key. */
export interface CapStore {
  get(key: string): Promise<number>;
  add(key: string, deltaMicros: number): Promise<number>;
}

export class InMemoryCapStore implements CapStore {
  private readonly totals = new Map<string, number>();

  async get(key: string): Promise<number> {
    return this.totals.get(key) ?? 0;
  }

  async add(key: string, deltaMicros: number): Promise<number> {
    const next = (this.totals.get(key) ?? 0) + deltaMicros;
    this.totals.set(key, next);
    return next;
  }
}

export interface CapReservation {
  allowed: boolean;
  /** Store key of the running total; pass to release to give back. */
  key: string;
  capMicros: number;
  /** Amount actually reserved: costMicros when allowed, 0 when blocked. */
  reservedMicros: number;
  /** Running total after the reservation, or the current total when blocked. */
  totalMicros: number;
  /** Set on the global daily cap when the total is at or past the alert line. */
  alert?: boolean;
  reason?: string;
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface SpendCapsOverrides {
  /** Raised hard stop, the plan's "until the founder raises it" knob. Wired
   * from DAILY_SPEND_HARD_STOP_USD at runtime. */
  globalDailyHardStopMicros?: number;
}

export class SpendCaps {
  private readonly globalDailyHardStopMicros: number;

  constructor(
    private readonly store: CapStore,
    private readonly now: () => Date = () => new Date(),
    overrides: SpendCapsOverrides = {},
  ) {
    this.globalDailyHardStopMicros =
      overrides.globalDailyHardStopMicros ?? SPEND_CAPS.globalDailyHardStopMicros;
  }

  private async reserve(key: string, costMicros: number, capMicros: number): Promise<CapReservation> {
    if (costMicros < 0) throw new Error("costMicros must be non negative");
    const current = await this.store.get(key);
    if (current + costMicros > capMicros) {
      return {
        allowed: false,
        key,
        capMicros,
        reservedMicros: 0,
        totalMicros: current,
        reason: `Reserving ${costMicros} micros would put ${key} at ${current + costMicros}, over the cap of ${capMicros}`,
      };
    }
    const total = await this.store.add(key, costMicros);
    if (total > capMicros) {
      // A concurrent reservation won the race; roll back.
      const rolledBack = await this.store.add(key, -costMicros);
      return {
        allowed: false,
        key,
        capMicros,
        reservedMicros: 0,
        totalMicros: rolledBack,
        reason: `Concurrent reservations put ${key} over the cap of ${capMicros}`,
      };
    }
    return { allowed: true, key, capMicros, reservedMicros: costMicros, totalMicros: total };
  }

  /** Gives a reservation back, for example when the reserved work failed. */
  async release(key: string, costMicros: number): Promise<number> {
    return this.store.add(key, -costMicros);
  }

  checkAndReserveImageAsset(assetId: string, costMicros: number): Promise<CapReservation> {
    return this.reserve(`caps:asset:image:${assetId}`, costMicros, SPEND_CAPS.perImageAssetMicros);
  }

  checkAndReserveVideoAsset(assetId: string, costMicros: number): Promise<CapReservation> {
    return this.reserve(`caps:asset:video:${assetId}`, costMicros, SPEND_CAPS.perVideoAssetMicros);
  }

  checkAndReservePack(jobId: string, costMicros: number): Promise<CapReservation> {
    return this.reserve(`caps:pack:${jobId}`, costMicros, SPEND_CAPS.perPackMicros);
  }

  checkAndReserveWorkspaceDay(
    workspaceId: string,
    planExpectedDailyMicros: number,
    costMicros: number,
  ): Promise<CapReservation> {
    const key = `caps:workspace:${workspaceId}:${dayStamp(this.now())}`;
    return this.reserve(key, costMicros, dailyWorkspaceCeilingMicros(planExpectedDailyMicros));
  }

  /**
   * Global daily provider spend. Blocks at the hard stop; when allowed, sets
   * alert once the running total reaches the alert line so the caller can
   * notify the founder.
   */
  async checkAndReserveGlobalDay(costMicros: number): Promise<CapReservation> {
    const key = `caps:global:${dayStamp(this.now())}`;
    const result = await this.reserve(key, costMicros, this.globalDailyHardStopMicros);
    if (result.totalMicros >= SPEND_CAPS.globalDailyAlertMicros) {
      result.alert = true;
    }
    return result;
  }
}
