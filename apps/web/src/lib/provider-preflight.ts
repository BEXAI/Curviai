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
 * - "packs_paused": every configured cutout provider is unavailable. Every
 *   shot starts from the cutout, so Create pack is disabled.
 * - "scenes_paused": every configured image provider is unavailable. Packs
 *   still run: white background, cutout and other photo based files are
 *   delivered, scenes are paused and not charged.
 * - "ok": anything else, including no provider configured at all (demo
 *   mode, or a configuration problem the health warnings already report).
 *
 * The verdict is cached for CACHE_MS per process.
 */

import { CircuitBreaker, lastProbeReport, processBreakerStore, type RecordedProbe } from "@curvi/ai";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { optionalEnv } from "@/lib/env";

export type PreflightVerdict = "ok" | "scenes_paused" | "packs_paused";

export interface PreflightTarget {
  name: string;
  kind: string;
  configured: boolean;
}

export interface PreflightDeps {
  targets: readonly PreflightTarget[];
  isOpen: (provider: string) => Promise<boolean>;
  lastProbe: (provider: string) => RecordedProbe | null;
  now: () => number;
}

/** A recorded probe counts for this long. */
export const PROBE_FRESH_MS = 15 * 60_000;
/** The verdict is reused for this long. */
export const PREFLIGHT_CACHE_MS = 15_000;
/** Probe statuses that say the account itself cannot serve a pack. */
const ACCOUNT_REFUSED = new Set([401, 402, 403]);

export const PACKS_PAUSED_COPY =
  "Packs are paused for a few minutes while an image service recovers. Nothing will be charged.";
export const SCENES_PAUSED_COPY =
  "Lifestyle scenes are paused while an image service recovers. White background and cutout files still work, and paused scenes are not charged.";

async function unavailable(target: PreflightTarget, deps: PreflightDeps): Promise<boolean> {
  const open = await deps.isOpen(target.name).catch(() => false);
  if (open) return true;
  const probe = deps.lastProbe(target.name);
  return (
    probe !== null &&
    !probe.ok &&
    probe.status !== null &&
    ACCOUNT_REFUSED.has(probe.status) &&
    deps.now() - probe.at < PROBE_FRESH_MS
  );
}

async function chainDown(kind: string, deps: PreflightDeps): Promise<boolean> {
  const configured = deps.targets.filter((target) => target.kind === kind && target.configured);
  if (configured.length === 0) return false;
  const down = await Promise.all(configured.map((target) => unavailable(target, deps)));
  return down.every(Boolean);
}

export async function evaluatePreflight(deps: PreflightDeps): Promise<PreflightVerdict> {
  if (await chainDown("cutout", deps)) return "packs_paused";
  if (await chainDown("image", deps)) return "scenes_paused";
  return "ok";
}

/** The banner copy for a verdict, or null when there is nothing to say. */
export function preflightCopy(verdict: PreflightVerdict): string | null {
  if (verdict === "packs_paused") return PACKS_PAUSED_COPY;
  if (verdict === "scenes_paused") return SCENES_PAUSED_COPY;
  return null;
}

const scope = globalThis as typeof globalThis & {
  __curviPreflight?: { verdict: PreflightVerdict; at: number };
};

/** The live verdict for this process, cached for PREFLIGHT_CACHE_MS. Never throws. */
export async function providerPreflight(deps?: Partial<PreflightDeps>): Promise<PreflightVerdict> {
  const now = deps?.now ?? Date.now;
  const cached = scope.__curviPreflight;
  if (!deps && cached && now() - cached.at < PREFLIGHT_CACHE_MS) {
    return cached.verdict;
  }
  let verdict: PreflightVerdict = "ok";
  try {
    const breaker = new CircuitBreaker(processBreakerStore());
    verdict = await evaluatePreflight({
      targets: deps?.targets ?? liveProviderTargets(optionalEnv),
      isOpen: deps?.isOpen ?? ((name) => breaker.isOpen(name)),
      lastProbe: deps?.lastProbe ?? lastProbeReport,
      now,
    });
  } catch (err) {
    console.warn("[preflight] provider check failed", err);
  }
  if (!deps) {
    scope.__curviPreflight = { verdict, at: now() };
  }
  return verdict;
}
