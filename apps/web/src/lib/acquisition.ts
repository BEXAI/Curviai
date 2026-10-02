/**
 * The acquisition gate (docs/phases/PHASE_18.md P18-03): no marketing link
 * sends a visitor into a product that cannot make a pack.
 *
 * The state is "waitlist" when any of these holds, and "open" otherwise:
 * - the founder's switch: platform_settings acquisition_paused is true
 *   (seeded false and never reset by a later seed; flipped by SQL with no
 *   deploy);
 * - the new pack preflight says packs_paused: every configured cutout
 *   provider is out of credit or failing (lib/provider-preflight.ts);
 * - every configured cutout account (its FAL_KEY or FAL_KEY_BACKUP set)
 *   has a fresh stored balance below the seeded pause line
 *   (trigger/src/provider-balance.ts, falBalanceLines in the seed). An
 *   account without a reading never counts as below, so an unknown balance
 *   never closes the gate.
 *
 * While waitlisted, every Start free call to action offers "Get notified
 * when packs are back" (AcquisitionCta, lead source packs-paused), /signup
 * shows a notice and stays open, and GET /api/status answers waitlist. The
 * free browser tools never need fal and keep working.
 *
 * Cached per process for the seeded cacheSeconds, with one computation in
 * flight at a time, so the public status endpoint costs at most a few reads
 * per 30 seconds whatever the traffic. Never throws: a failed read counts as
 * open (the preflight still refuses packs that cannot run).
 *
 * A change of state is recorded once across every process: the newest state
 * lives in platform_settings under acquisition_state, changed by a
 * conditional upsert that only one process wins. The winner writes the
 * funnel event (acquisition_paused or acquisition_resumed, no workspace)
 * and, for a pause the founder did not set, emails the founder once per UTC
 * day and reason.
 *
 * Demo mode (no database): CURVI_DEMO_ACQUISITION=waitlist forces the
 * waitlist for local tests; it is ignored in db mode.
 */

import { recordFunnelEvent, sql, type Db } from "@curvi/db";
import {
  ACQUISITION_PAUSED_SETTING,
  acquisitionGate,
  falBalanceAccounts,
  falBalanceLines,
  falBalanceProbePolicy,
  type FalBalanceAccount,
  type FalBalanceLines,
  type FalBalanceProbePolicy,
} from "@curvi/pipeline/seed";
import { optionalEnv } from "@/lib/env";
import type { PreflightVerdict } from "@/lib/provider-preflight";

export type AcquisitionState = "open" | "waitlist";

/** Why the gate is closed. Never shown publicly: /api/status answers the state only. */
export type AcquisitionReason = "manual" | "packs_paused" | "fal_balance" | "demo";

export interface AcquisitionStatus {
  state: AcquisitionState;
  reason: AcquisitionReason | null;
}

export const OPEN: AcquisitionStatus = { state: "open", reason: null };

/** The platform_settings row holding the newest recorded state. */
export const ACQUISITION_STATE_SETTING = "acquisition_state";

/** The env var that forces the waitlist in demo mode (tests only). */
export const DEMO_ACQUISITION_ENV = "CURVI_DEMO_ACQUISITION";

export interface CutoutAccountBalance {
  provider: string;
  /** The newest balance read successfully; null when never read. */
  balanceUsd: number | null;
  /** When that balance was read (ISO); null when never read. */
  balanceAt: string | null;
}

export interface AcquisitionInputs {
  manualPause: boolean;
  preflight: PreflightVerdict;
  /** One entry per configured cutout account (its inference key set). */
  cutoutBalances: readonly CutoutAccountBalance[];
  now: number;
}

/** True when the balance is known, fresh and below the pause line. */
function belowPauseLine(balance: CutoutAccountBalance, now: number, lines: FalBalanceLines, policy: FalBalanceProbePolicy): boolean {
  if (balance.balanceUsd === null || balance.balanceAt === null) return false;
  const at = Date.parse(balance.balanceAt);
  if (!Number.isFinite(at) || now - at > policy.staleAfterMinutes * 60_000) return false;
  return balance.balanceUsd < lines.pauseUsd;
}

/** The gate for a set of inputs. Pure. */
export function evaluateAcquisition(
  inputs: AcquisitionInputs,
  lines: FalBalanceLines = falBalanceLines,
  policy: FalBalanceProbePolicy = falBalanceProbePolicy,
): AcquisitionStatus {
  if (inputs.manualPause) return { state: "waitlist", reason: "manual" };
  if (inputs.preflight === "packs_paused") return { state: "waitlist", reason: "packs_paused" };
  if (
    inputs.cutoutBalances.length > 0 &&
    inputs.cutoutBalances.every((balance) => belowPauseLine(balance, inputs.now, lines, policy))
  ) {
    return { state: "waitlist", reason: "fal_balance" };
  }
  return OPEN;
}

/** The demo mode state: open unless CURVI_DEMO_ACQUISITION=waitlist. */
export function demoAcquisition(read: (name: string) => string | undefined = optionalEnv): AcquisitionStatus {
  return read(DEMO_ACQUISITION_ENV)?.trim().toLowerCase() === "waitlist" ? { state: "waitlist", reason: "demo" } : OPEN;
}

/** The configured cutout accounts, by their inference key. */
export function configuredCutoutAccounts(
  read: (name: string) => string | undefined = optionalEnv,
  accounts: readonly FalBalanceAccount[] = falBalanceAccounts,
): FalBalanceAccount[] {
  return accounts.filter((account) => Boolean(read(account.keyEnv)));
}

/** postgres-js returns the rows array; PGlite (tests) returns { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Reads the founder's switch. Only a stored true pauses. */
export async function readManualPause(db: Pick<Db, "execute">): Promise<boolean> {
  // Compared in SQL, so a JSON string "true" never reads as the boolean.
  const rows = rowsOf<{ paused: unknown }>(
    await db.execute(
      sql`select value = 'true'::jsonb as paused from platform_settings where key = ${ACQUISITION_PAUSED_SETTING}`,
    ),
  );
  return rows[0]?.paused === true;
}

/**
 * Records a change of state once across every process. Returns true when
 * this call recorded a change (a pause, or a resume after a recorded pause).
 */
export async function recordAcquisitionChange(
  db: Pick<Db, "execute">,
  status: AcquisitionStatus,
  at: Date = new Date(),
): Promise<boolean> {
  const value = JSON.stringify({ state: status.state, reason: status.reason, at: at.toISOString() });
  const before = rowsOf<{ value: unknown }>(
    await db.execute(sql`select value from platform_settings where key = ${ACQUISITION_STATE_SETTING}`),
  );
  const previous = (jsonValue(before[0]?.value) as { state?: unknown } | undefined)?.state;
  if (previous === status.state) return false;
  const changed = rowsOf<{ key: string }>(
    await db.execute(
      sql`insert into platform_settings (key, value, updated_at)
          values (${ACQUISITION_STATE_SETTING}, ${value}::jsonb, ${at.toISOString()}::timestamptz)
          on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
          where platform_settings.value->>'state' is distinct from excluded.value->>'state'
          returning key`,
    ),
  );
  // The first reading ever, while open, is a baseline, not a resume.
  return changed.length > 0 && (previous !== undefined || status.state === "waitlist");
}

export interface AcquisitionDeps {
  /** Read through the cache unless fresh. */
  fresh?: boolean;
  now?: () => number;
  readEnv?: (name: string) => string | undefined;
  log?: Pick<Console, "warn" | "error">;
}

const scope = globalThis as typeof globalThis & {
  __curviAcquisition?: { status: AcquisitionStatus; at: number };
  __curviAcquisitionInFlight?: Promise<AcquisitionStatus>;
};

async function computeDb(now: number, readEnv: (name: string) => string | undefined, log: Pick<Console, "warn" | "error">): Promise<AcquisitionStatus> {
  const [{ getDb }, { providerPreflightDetail }, { readFalBalances }] = await Promise.all([
    import("@/lib/services/db"),
    import("@/lib/provider-preflight"),
    import("@curvi/trigger/provider-balance"),
  ]);
  const db = getDb();
  const accounts = configuredCutoutAccounts(readEnv);
  const [manual, preflight, balances] = await Promise.all([
    readManualPause(db).catch((err: unknown) => {
      log.warn("[acquisition] could not read acquisition_paused; treating it as off", err);
      return false;
    }),
    providerPreflightDetail(),
    accounts.length > 0
      ? readFalBalances(db).catch((err: unknown) => {
          log.warn("[acquisition] could not read the fal balances", err);
          return new Map();
        })
      : Promise.resolve(new Map()),
  ]);
  const status = evaluateAcquisition({
    manualPause: manual,
    preflight: preflight.verdict,
    cutoutBalances: accounts.map((account) => {
      const stored = balances.get(account.provider);
      return { provider: account.provider, balanceUsd: stored?.balanceUsd ?? null, balanceAt: stored?.balanceAt ?? null };
    }),
    now,
  });
  await noteChange(db, status, new Date(now), log);
  return status;
}

/** Records a change and, for a pause the founder did not set, emails them.
 * Best effort: the gate's answer never waits on a failed write. */
export async function noteChange(
  db: Db,
  status: AcquisitionStatus,
  at: Date,
  log: Pick<Console, "warn" | "error">,
): Promise<void> {
  try {
    if (!(await recordAcquisitionChange(db, status, at))) return;
    await recordFunnelEvent(db, {
      workspaceId: null,
      name: status.state === "waitlist" ? "acquisition_paused" : "acquisition_resumed",
      props: { reason: status.reason },
      at,
    });
    log.warn(JSON.stringify({ level: "warn", event: `acquisition_${status.state}`, reason: status.reason }));
    if (status.state === "waitlist" && (status.reason === "packs_paused" || status.reason === "fal_balance")) {
      const [{ FounderAlerts, notifyAcquisitionPaused }, { PgCapStore }] = await Promise.all([
        import("@curvi/trigger/provider-balance"),
        import("@curvi/trigger/cap-store"),
      ]);
      void notifyAcquisitionPaused(status.reason, new FounderAlerts({ dedupe: new PgCapStore(db) }), at).catch(() => undefined);
    }
  } catch (err) {
    log.warn("[acquisition] could not record the gate change", err);
  }
}

/** The gate for this process, cached for the seeded cacheSeconds. Never throws. */
export async function acquisitionStatus(deps: AcquisitionDeps = {}): Promise<AcquisitionStatus> {
  const now = deps.now ?? Date.now;
  const readEnv = deps.readEnv ?? optionalEnv;
  const log = deps.log ?? console;
  const cached = scope.__curviAcquisition;
  if (!deps.fresh && cached && now() - cached.at < acquisitionGate.cacheSeconds * 1000) {
    return cached.status;
  }
  if (!deps.fresh && scope.__curviAcquisitionInFlight) {
    return scope.__curviAcquisitionInFlight;
  }
  const work = (async (): Promise<AcquisitionStatus> => {
    try {
      const { isDbMode } = await import("@/lib/services");
      return isDbMode() ? await computeDb(now(), readEnv, log) : demoAcquisition(readEnv);
    } catch (err) {
      log.warn("[acquisition] the gate could not be computed; treating it as open", err);
      return OPEN;
    }
  })();
  scope.__curviAcquisitionInFlight = work;
  try {
    const status = await work;
    scope.__curviAcquisition = { status, at: now() };
    return status;
  } finally {
    if (scope.__curviAcquisitionInFlight === work) {
      delete scope.__curviAcquisitionInFlight;
    }
  }
}

/** Forgets the cached gate (tests). */
export function resetAcquisitionForTests(): void {
  delete scope.__curviAcquisition;
  delete scope.__curviAcquisitionInFlight;
}
