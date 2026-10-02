/**
 * New pack preflight (docs/phases/PHASE_14.md 1.5): before a seller starts a
 * pack, tell them when an image service is down, so nobody waits on a pack
 * that cannot deliver.
 *
 * Sources, both cheap and local to this process, never a provider call:
 * - the circuit breakers the pack runner writes (processBreakerStore), open
 *   after repeated failures or at once on an out of quota answer;
 * - the newest key probe per provider, recorded by /api/health/providers,
 *   when it refused the key or found no credit (401, 402, 403) within the
 *   last PROBE_FRESH_MS.
 *
 * Verdicts:
 * - "packs_paused": every configured cutout provider is unavailable. A pack
 *   that needs a cutout (packNeedsCutout in @curvi/pipeline/output-options:
 *   any removed background, any extra image, or a channel that requires
 *   white) cannot start, so the form disables Create pack for it and
 *   createJob refuses it, unless every cutout it needs is already in the
 *   upload cache. A pack that keeps every photo as it is, with no extras
 *   and no white required channel, still runs.
 * - "scenes_paused": every configured image provider is unavailable. Packs
 *   still run: white background, cutout and other photo based files are
 *   delivered, scenes are paused and not charged.
 * - "ok": anything else, including no provider configured at all (demo
 *   mode, or a configuration problem the health warnings already report).
 *
 * The verdict comes with its cause. "quota" means every paused provider
 * answered that its account is out of credit (a quota breaker, or a probe
 * that refused the key or found no credit): nothing recovers until someone
 * tops the account up, so the copy makes no time promise. "failures" means
 * repeated errors opened the breakers, which usually clear in minutes.
 *
 * A quota trip is also written to the events table (provider_quota_exhausted,
 * trigger/src/provider-quota.ts). The in memory breaker forgets it on a
 * restart or a spin down, so the preflight reads the newest such event for
 * each configured cutout provider and, when it is younger than the quota
 * cooldown, opens this process's breaker again for the time left. A pack
 * started from saved photos right after a restart then sees the pause too.
 *
 * The verdict is cached for PREFLIGHT_CACHE_MS per process.
 */

import {
  CircuitBreaker,
  lastProbeReport,
  processBreakerStore,
  QUOTA_OPEN_SECONDS,
  type RecordedProbe,
} from "@curvi/ai";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { readProviderProbes, type StoredProviderProbe } from "@curvi/trigger/provider-canary";
import { optionalEnv } from "@/lib/env";

export type PreflightVerdict = "ok" | "scenes_paused" | "packs_paused";

/** Why a chain is paused: an empty account, or repeated failures. */
export type PauseCause = "quota" | "failures";

export interface PreflightDetail {
  verdict: PreflightVerdict;
  /** The paused chain's cause; null when the verdict is ok. */
  cause: PauseCause | null;
}

export interface PreflightTarget {
  name: string;
  kind: string;
  configured: boolean;
}

export interface PreflightDeps {
  targets: readonly PreflightTarget[];
  isOpen: (provider: string) => Promise<boolean>;
  /** Why a provider's breaker is open. Left out, an open breaker counts as
   * a failure trip. */
  openReason?: (provider: string) => Promise<PauseCause | null>;
  lastProbe: (provider: string) => RecordedProbe | null;
  now: () => number;
}

/** A recorded probe counts for this long. */
export const PROBE_FRESH_MS = 15 * 60_000;
/** The verdict is reused for this long. */
export const PREFLIGHT_CACHE_MS = 15_000;
/** Probe statuses that say the account itself cannot serve a pack. */
const ACCOUNT_REFUSED = new Set([401, 402, 403]);
/** The events row a quota answer writes (trigger/src/provider-quota.ts). */
export const PROVIDER_QUOTA_EVENT_NAME = "provider_quota_exhausted";

export const PACKS_PAUSED_COPY =
  "Packs that remove the background are paused for a few minutes while an image service recovers. Nothing will be charged.";
/** The same pause when the cutout account is out of credit: no time promise. */
export const PACKS_PAUSED_QUOTA_COPY = "Packs that remove the background are paused right now. Nothing will be charged.";
export const SCENES_PAUSED_COPY =
  "Lifestyle scenes are paused while an image service recovers. White background and cutout files still work, and paused scenes are not charged.";

/** The packs paused copy for a cause. */
export function packsPausedCopy(cause: PauseCause | null | undefined): string {
  return cause === "quota" ? PACKS_PAUSED_QUOTA_COPY : PACKS_PAUSED_COPY;
}

async function unavailable(target: PreflightTarget, deps: PreflightDeps): Promise<PauseCause | null> {
  const reason: PauseCause | null = deps.openReason
    ? await deps.openReason(target.name).catch(() => null)
    : (await deps.isOpen(target.name).catch(() => false))
      ? "failures"
      : null;
  if (reason === "quota") return "quota";
  const probe = deps.lastProbe(target.name);
  const refused =
    probe !== null &&
    !probe.ok &&
    probe.status !== null &&
    ACCOUNT_REFUSED.has(probe.status) &&
    deps.now() - probe.at < PROBE_FRESH_MS;
  if (refused) return "quota";
  return reason;
}

/** Null when some configured provider of the kind is up (or none is
 * configured); otherwise the cause, "quota" only when every one is out of
 * credit. */
async function chainDown(kind: string, deps: PreflightDeps): Promise<PauseCause | null> {
  const configured = deps.targets.filter((target) => target.kind === kind && target.configured);
  if (configured.length === 0) return null;
  const down = await Promise.all(configured.map((target) => unavailable(target, deps)));
  if (down.some((cause) => cause === null)) return null;
  return down.every((cause) => cause === "quota") ? "quota" : "failures";
}

export async function evaluatePreflightDetail(deps: PreflightDeps): Promise<PreflightDetail> {
  const cutout = await chainDown("cutout", deps);
  if (cutout) return { verdict: "packs_paused", cause: cutout };
  const image = await chainDown("image", deps);
  if (image) return { verdict: "scenes_paused", cause: image };
  return { verdict: "ok", cause: null };
}

/** The banner copy for a verdict, or null when there is nothing to say. */
export function preflightCopy(verdict: PreflightVerdict, cause?: PauseCause | null): string | null {
  if (verdict === "packs_paused") return packsPausedCopy(cause);
  if (verdict === "scenes_paused") return SCENES_PAUSED_COPY;
  return null;
}

/** The newest quota event time per provider, in ms. */
export type RecentQuotaReader = (providers: readonly string[]) => Promise<Map<string, number>>;

/**
 * Opens the breaker again for every configured cutout provider whose last
 * recorded quota answer is younger than the quota cooldown, for the time
 * left, when this process's breaker has forgotten it. Returns the providers
 * it tripped. Never throws.
 */
export async function restoreQuotaTrips(
  breaker: Pick<CircuitBreaker, "isOpen" | "tripForQuota"> & Partial<Pick<CircuitBreaker, "reset" | "openReason">>,
  targets: readonly PreflightTarget[],
  readRecent: RecentQuotaReader,
  now: number,
  resolved: ReadonlyMap<string, number> = new Map(),
): Promise<string[]> {
  const cutouts = targets.filter((t) => t.kind === "cutout" && t.configured).map((t) => t.name);
  if (cutouts.length === 0) return [];
  const restored: string[] = [];
  try {
    const recent = await readRecent(cutouts);
    for (const name of cutouts) {
      const at = recent.get(name);
      const clearedAt = resolved.get(name);
      if (clearedAt !== undefined && (at === undefined || at <= clearedAt)) {
        if (await breaker.openReason?.(name) === "quota") await breaker.reset?.(name);
        continue;
      }
      if (at === undefined) continue;
      const left = Math.floor((at + QUOTA_OPEN_SECONDS * 1000 - now) / 1000);
      if (left <= 0 || (await breaker.isOpen(name))) continue;
      await breaker.tripForQuota(name, left);
      restored.push(name);
    }
  } catch (err) {
    console.warn("[preflight] could not read recent quota events", err);
  }
  return restored;
}

/** Reads the newest provider_quota_exhausted event per provider in db mode;
 * an empty map otherwise. The rows have no workspace, so the workspace_id
 * index narrows the read to system events. */
const readRecentQuotaEvents: RecentQuotaReader = async (providers) => {
  const out = new Map<string, number>();
  const { isDbMode } = await import("@/lib/services");
  if (!isDbMode() || providers.length === 0) return out;
  const [{ getDb }, { sql }] = await Promise.all([import("@/lib/services/db"), import("@curvi/db")]);
  const since = new Date(Date.now() - QUOTA_OPEN_SECONDS * 1000);
  const result = await getDb().execute(
    sql`select props->>'provider' as provider, max(at) as at from events
        where workspace_id is null and name = ${PROVIDER_QUOTA_EVENT_NAME} and at > ${since.toISOString()}::timestamptz
        group by 1`,
  );
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<{
    provider?: unknown;
    at?: unknown;
  }>;
  for (const row of rows) {
    const at = row.at instanceof Date ? row.at.getTime() : typeof row.at === "string" ? Date.parse(row.at) : NaN;
    if (typeof row.provider === "string" && providers.includes(row.provider) && Number.isFinite(at)) {
      out.set(row.provider, at);
    }
  }
  // Unlike the hourly history event, this row advances on every answer,
  // so a fresh quota failure after a pass is never hidden by email dedupe.
  const latest = await getDb().execute(sql`select key, value from platform_settings where key like 'provider_quota:last:%'`);
  const latestRows = (Array.isArray(latest) ? latest : ((latest as { rows?: unknown[] }).rows ?? [])) as Array<{ key: string; value: { at?: unknown } }>;
  for (const row of latestRows) {
    const provider = row.key.slice("provider_quota:last:".length);
    const at = row.value?.at;
    if (providers.includes(provider) && typeof at === "number" && Number.isFinite(at)) out.set(provider, Math.max(at, out.get(provider) ?? 0));
  }
  return out;
};

const scope = globalThis as typeof globalThis & {
  __curviPreflight?: { detail: PreflightDetail; at: number };
};

export type ProviderPreflightDeps = Partial<PreflightDeps> & {
  readRecentQuota?: RecentQuotaReader;
  readStoredProbes?: () => Promise<Map<string, StoredProviderProbe>>;
};

async function storedProbes(): Promise<Map<string, StoredProviderProbe>> {
  const { isDbMode } = await import("@/lib/services");
  if (!isDbMode()) return new Map();
  const { getDb } = await import("@/lib/services/db");
  return readProviderProbes(getDb());
}

export function clearProviderPreflightCache(): void { delete scope.__curviPreflight; }

/** The live verdict and its cause for this process, cached for
 * PREFLIGHT_CACHE_MS. Never throws. */
export async function providerPreflightDetail(deps?: ProviderPreflightDeps): Promise<PreflightDetail> {
  const now = deps?.now ?? Date.now;
  const cached = scope.__curviPreflight;
  if (!deps && cached && now() - cached.at < PREFLIGHT_CACHE_MS) {
    return cached.detail;
  }
  let detail: PreflightDetail = { verdict: "ok", cause: null };
  try {
    const breaker = new CircuitBreaker(processBreakerStore());
    const targets = deps?.targets ?? liveProviderTargets(optionalEnv);
    const durable = await (deps?.readStoredProbes ?? (deps ? async () => new Map<string, StoredProviderProbe>() : storedProbes))();
    const resolved = new Map([...durable].flatMap(([name, probe]) => {
      const at = Math.max(probe.passedAt ?? 0, probe.resetAt ?? 0);
      return at > 0 ? [[name, at] as const] : [];
    }));
    const readRecent = deps ? deps.readRecentQuota : readRecentQuotaEvents;
    if (readRecent) {
      await restoreQuotaTrips(breaker, targets, readRecent, now(), resolved);
    }
    const injectedOpen = deps?.isOpen;
    const openReason = deps?.openReason ?? (injectedOpen ? undefined : (name: string) => breaker.openReason(name));
    detail = await evaluatePreflightDetail({
      targets,
      isOpen: injectedOpen ?? ((name) => breaker.isOpen(name)),
      ...(openReason ? { openReason } : {}),
      lastProbe: deps?.lastProbe ?? ((name) => {
        const probe = durable.get(name);
        if (probe) return probe.resetAt !== null && probe.resetAt >= probe.at ? null : probe;
        return lastProbeReport(name);
      }),
      now,
    });
  } catch (err) {
    console.warn("[preflight] provider check failed", err);
  }
  if (!deps) {
    scope.__curviPreflight = { detail, at: now() };
  }
  return detail;
}
