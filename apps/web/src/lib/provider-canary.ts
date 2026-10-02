import { canaryPolicy } from "@curvi/pipeline/seed";
import { PgCapStore } from "@curvi/trigger/cap-store";
import { runProviderCanaries, notifyStagePaused, type StoredProviderProbe } from "@curvi/trigger/provider-canary";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { FounderAlerts } from "@curvi/trigger/provider-balance";
import { optionalEnv } from "@/lib/env";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { clearProviderPreflightCache, providerPreflightDetail } from "@/lib/provider-preflight";

export function registeredCanaryProviders(): string[] {
  return [...liveProviderTargets(() => undefined).map((target) => target.name), "r2"];
}

/** Opt-in scheduled/operator call. Selecting a provider forces its due check,
 * while shared minute claims, metering and spend ceilings still apply. */
export async function runProviderCanaryNow(provider?: string): Promise<{ ok: boolean; skipped?: "disabled" | "unconfigured"; probes: StoredProviderProbe[] }> {
  if (provider && !registeredCanaryProviders().includes(provider)) throw new Error("Unknown provider.");
  if (!(canaryPolicy.enabled || optionalEnv("CURVI_PROVIDER_CANARY_ENABLED") === "1")) {
    return { ok: true, skipped: "disabled", probes: [] };
  }
  if (!isDbMode()) return { ok: true, skipped: "unconfigured", probes: [] };
  const db = getDb();
  // Restore a persisted quota trip before selecting the shorter recovery
  // cadence; this also works in a newly started process.
  clearProviderPreflightCache();
  await providerPreflightDetail();
  const store = new PgCapStore(db);
  const alerts = new FounderAlerts({ dedupe: store, readEnv: optionalEnv });
  const result = await runProviderCanaries({ db, enabled: true, provider, readEnv: optionalEnv, store, alerts });
  clearProviderPreflightCache();
  const detail = await providerPreflightDetail();
  await notifyStagePaused(db, detail.verdict, alerts);
  return result;
}
