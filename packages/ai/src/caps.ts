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

export interface SpendCapPolicy {
  perImageAssetMicros: number;
  perVideoAssetMicros: number;
  perPackMicros: number;
  workspaceDailyMultiplier: number;
  globalDailyAlertMicros: number;
  globalDailyHardStopMicros: number | (() => Promise<number>);
}

export function dailyWorkspaceCeilingMicros(planExpectedDailyMicros: number, multiplier: number): number {
  return planExpectedDailyMicros * multiplier;
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
  /** Set on an allowed global daily reservation when the running total is at
   * or past the alert line. Never set on a blocked reservation: nothing was
   * spent, and the hard stop already refused the call. */
  alert?: boolean;
  reason?: string;
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class SpendCaps {
  constructor(
    private readonly store: CapStore,
    private readonly now: () => Date,
    private readonly policy: SpendCapPolicy,
  ) {}

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
    return this.reserve(`caps:asset:image:${assetId}`, costMicros, this.policy.perImageAssetMicros);
  }

  checkAndReserveVideoAsset(assetId: string, costMicros: number): Promise<CapReservation> {
    return this.reserve(`caps:asset:video:${assetId}`, costMicros, this.policy.perVideoAssetMicros);
  }

  checkAndReservePack(jobId: string, costMicros: number): Promise<CapReservation> {
    return this.reserve(`caps:pack:${jobId}`, costMicros, this.policy.perPackMicros);
  }

  checkAndReserveWorkspaceDay(
    workspaceId: string,
    planExpectedDailyMicros: number,
    costMicros: number,
  ): Promise<CapReservation> {
    const key = `caps:workspace:${workspaceId}:${dayStamp(this.now())}`;
    return this.reserve(key, costMicros, dailyWorkspaceCeilingMicros(planExpectedDailyMicros, this.policy.workspaceDailyMultiplier));
  }

  /**
   * Global daily provider spend. Blocks at the hard stop; when allowed, sets
   * alert once the running total reaches the alert line so the caller can
   * notify the founder. A blocked reservation never alerts.
   */
  async checkAndReserveGlobalDay(costMicros: number): Promise<CapReservation> {
    const key = `caps:global:${dayStamp(this.now())}`;
    const result = await this.reserve(key, costMicros, typeof this.policy.globalDailyHardStopMicros === "function" ? await this.policy.globalDailyHardStopMicros() : this.policy.globalDailyHardStopMicros);
    if (result.allowed && this.globalDayAlertReached(result.totalMicros)) {
      result.alert = true;
    }
    return result;
  }

  /** True when a global daily running total is at or past the alert line.
   * The router uses it after charging a shortfall (a call that cost more
   * than its reservation), which moves the total without a new reservation. */
  globalDayAlertReached(totalMicros: number): boolean {
    return totalMicros >= this.policy.globalDailyAlertMicros;
  }

  /**
   * Claims today's global spend alert. Resolves true for exactly one caller
   * per UTC day across every process sharing the store (add is atomic per
   * key), false for everyone after. Wrap the founder notifier with it so a
   * run past the alert line sends one message a day, not one per call.
   */
  async claimGlobalDayAlert(): Promise<boolean> {
    const total = await this.store.add(`caps:alert:global:${dayStamp(this.now())}`, 1);
    return total === 1;
  }
}
