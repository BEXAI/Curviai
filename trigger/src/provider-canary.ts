/** P20-16: durable probes and metered, single-provider cutout recovery. */
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  callWithFailover, CircuitBreaker, ProviderRegistry, SpendCaps, processBreakerStore,
  probeProviders, recordProbeReports, billedMicrosOf, hasProviderErrorCode,
  type BreakerStore, type CostMeter, type CutoutInput, type CutoutOutput,
  type ProbeResult, type RecordedProbe, type Provider, type CapStore,
} from "@curvi/ai";
import { events, sql, type Db } from "@curvi/db";
import { decodeToRgba, encodePng, solidCanvas } from "@curvi/pipeline";
import { canaryPolicy, CUTOUT_TASK, providerAlertPolicy, spendCapPolicy } from "@curvi/pipeline/seed";
import { PgCapStore } from "./cap-store";
import { optionalEnv, type ReadEnv } from "./env";
import { FounderAlerts, checkFalBalances } from "./provider-balance";
import { liveProviderTargets, type LiveProviderTarget } from "./provider-probes";
import { processQuotaNotifier } from "./provider-quota";
import { r2FromEnv } from "./r2";
import { resolveGlobalHardStop } from "./spend-policy";
import { reportAlert } from "./alert-report";
import type { AlertDedupe } from "./spend-alerts";

export interface StoredProviderProbe extends RecordedProbe {
  passedAt: number | null;
  resetAt: number | null;
}
type ProbeDb = Pick<Db, "execute">;
const rowsOf = <T>(result: unknown): T[] => Array.isArray(result) ? result as T[] : (result as { rows?: T[] } | null)?.rows ?? [];
const safeTime = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export async function readProviderProbes(db: ProbeDb): Promise<Map<string, StoredProviderProbe>> {
  const rows = rowsOf<{ key: string; value: unknown }>(await db.execute(sql`select key, value from platform_settings where key like 'probe:%'`));
  const out = new Map<string, StoredProviderProbe>();
  for (const { key, value } of rows) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const name = key.slice("probe:".length);
    if (!name) continue;
    out.set(name, {
      name, at: safeTime(v.at) ?? 0, ok: v.ok === true,
      status: typeof v.status === "number" ? v.status : null,
      latencyMs: safeTime(v.latencyMs) ?? 0,
      ...(typeof v.balanceCredits === "number" && Number.isFinite(v.balanceCredits) ? { balanceCredits: v.balanceCredits } : {}),
      passedAt: safeTime(v.passedAt), resetAt: safeTime(v.resetAt),
      ...(typeof v.error === "string" ? { error: v.error } : {}),
    });
  }
  return out;
}

export async function storeProviderProbe(db: ProbeDb, provider: string, result: ProbeResult, at: Date): Promise<void> {
  const value = { name: provider, ...result, error: result.error ?? null, at: at.getTime(), ...(result.ok && !result.skipped ? { passedAt: at.getTime() } : {}) };
  // A skipped check must never overwrite a real failure or declare recovery.
  if (result.skipped) return;
  await db.execute(sql`insert into platform_settings (key, value, updated_at)
    values (${`probe:${provider}`}, ${JSON.stringify(value)}::jsonb, ${at})
    on conflict (key) do update set value = platform_settings.value || excluded.value, updated_at = excluded.updated_at
    where coalesce((platform_settings.value->>'at')::numeric, 0) <= ${at.getTime()}`);
  recordProbeReports([{ name: provider, ...result }], at.getTime());
}

/** Caller must authorize the operator and audit this action. No provider call. */
export async function resetProviderProbe(db: ProbeDb, provider: string, now: Date = new Date(), breakerStore: BreakerStore = processBreakerStore()): Promise<void> {
  if (!liveProviderTargets(() => undefined).some((target) => target.name === provider) && provider !== "r2") throw new Error("Unknown provider.");
  await db.execute(sql`insert into platform_settings (key, value, updated_at)
    values (${`probe:${provider}`}, ${JSON.stringify({ name: provider, resetAt: now.getTime() })}::jsonb, ${now})
    on conflict (key) do update set value = platform_settings.value || excluded.value, updated_at = excluded.updated_at`);
  await new CircuitBreaker(breakerStore).reset(provider);
}

/** A small synthetic input used only to check that background removal works. */
export async function canaryFixture(): Promise<Buffer> {
  const image = solidCanvas(canaryPolicy.fixtureWidth, canaryPolicy.fixtureHeight, 235, 235, 235);
  for (let y = 16; y < 48; y += 1) for (let x = 20; x < 44; x += 1) {
    const i = (y * image.width + x) * 4;
    image.data[i] = 35; image.data[i + 1] = 100; image.data[i + 2] = 180;
  }
  return encodePng(image);
}

export interface PinnedCanaryDeps {
  provider: Provider;
  meter: CostMeter;
  breakerStore: BreakerStore;
  caps: SpendCaps;
  maxCostMicros?: number;
  onProviderQuota?: NonNullable<Parameters<typeof callWithFailover>[5]>["onProviderQuota"];
}

/** No fallback registry is supplied. trialCall bypasses only this provider's
 * breaker; router estimates, global caps, metering and quota handling remain. */
export async function runPinnedCutoutCanary(deps: PinnedCanaryDeps): Promise<ProbeResult & { costMicros: number }> {
  const started = Date.now();
  let costMicros = 0;
  try {
    const registry = new ProviderRegistry();
    registry.register(deps.provider);
    const result = await callWithFailover<CutoutInput, CutoutOutput>(
      registry, { [CUTOUT_TASK]: [deps.provider.name] }, deps.meter, deps.breakerStore,
      { task: CUTOUT_TASK, input: { imageBytes: await canaryFixture(), filename: "canary.png", format: "png" }, stepId: "ops:provider_canary" },
      { chain: [deps.provider.name], trialCall: true, retry: { retries: 0 }, timeoutMs: canaryPolicy.timeoutMs,
        maxCostMicros: deps.maxCostMicros ?? canaryPolicy.maxMicrosPerRun,
        caps: { spendCaps: deps.caps, capKind: "global_day" }, onProviderQuota: deps.onProviderQuota },
    );
    costMicros = result.costMicros + result.billedFailureMicros;
    const output = await decodeToRgba(Buffer.from(result.output.imageBytes));
    let foreground = false;
    let background = false;
    for (let i = 3; i < output.data.length; i += 4) {
      foreground ||= output.data[i] >= 128;
      background ||= output.data[i] < 128;
    }
    if (output.width !== canaryPolicy.fixtureWidth || output.height !== canaryPolicy.fixtureHeight || !foreground || !background) {
      throw new Error("Cutout did not return the fixture with both product and transparent background.");
    }
    return { ok: true, status: 200, latencyMs: Date.now() - started, costMicros };
  } catch (err) {
    return { ok: false, status: hasProviderErrorCode(err, "provider_quota") ? 402 : null,
      latencyMs: Date.now() - started, costMicros: costMicros + billedMicrosOf(err),
      error: "The pinned cutout canary did not complete successfully." };
  }
}

export interface CanaryStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export async function runStorageCanary(storage: CanaryStorage): Promise<ProbeResult> {
  const started = Date.now();
  const key = `tmp/ops/canary/${randomUUID()}.txt`;
  const expected = Buffer.from("Curvi storage canary");
  try {
    try {
      await storage.put(key, expected);
      const bytes = await storage.get(key);
      if (!bytes?.equals(expected)) throw new Error("Storage canary bytes differ.");
    } finally {
      await storage.delete(key);
    }
    return { ok: true, status: 200, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, status: null, latencyMs: Date.now() - started, error: "The storage put, get or delete check failed." };
  }
}

function liveCanaryStorage(readEnv: ReadEnv): CanaryStorage | null {
  const r2 = r2FromEnv(readEnv);
  if (!r2) return null;
  const { client, bucket } = r2;
  const options = () => ({ abortSignal: AbortSignal.timeout(canaryPolicy.timeoutMs) });
  return {
    put: async (key, bytes) => { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }), options()); },
    get: async (key) => { const data = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), options()); return data.Body ? Buffer.from(await data.Body.transformToByteArray()) : null; },
    delete: async (key) => { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), options()); },
  };
}

export interface ProviderCanaryDeps {
  db: Db;
  enabled: boolean;
  readEnv?: ReadEnv;
  provider?: string;
  now?: () => Date;
  targets?: LiveProviderTarget[];
  store?: CapStore & AlertDedupe;
  breakerStore?: BreakerStore;
  meter?: CostMeter;
  storage?: CanaryStorage | null;
  alerts?: FounderAlerts;
}

export async function runProviderCanaries(deps: ProviderCanaryDeps) {
  if (!deps.enabled) return { ok: true, skipped: "disabled" as const, probes: [] as StoredProviderProbe[] };
  const at = (deps.now ?? (() => new Date()))();
  const readEnv = deps.readEnv ?? optionalEnv;
  const targets = deps.targets ?? liveProviderTargets(readEnv);
  if (deps.provider && !targets.some((target) => target.name === deps.provider) && deps.provider !== "r2") throw new Error("Unknown provider.");
  const store = deps.store ?? new PgCapStore(deps.db);
  const alerts = deps.alerts ?? new FounderAlerts({ dedupe: store, readEnv });
  const breakerStore = deps.breakerStore ?? processBreakerStore();
  const previous = await readProviderProbes(deps.db);
  const caps = new SpendCaps(store, () => at, { ...spendCapPolicy, globalDailyHardStopMicros: await resolveGlobalHardStop(deps.db, readEnv("DAILY_SPEND_HARD_STOP_USD")) });
  const meter = deps.meter ?? { record: async (entry) => { await deps.db.insert(events).values({ name: "provider_canary_spend", workspaceId: null, props: { provider: entry.provider, costMicros: entry.costMicros, ok: entry.ok, task: entry.task } }); } } satisfies CostMeter;
  const ran: string[] = [];
  let spent = 0;
  async function due(name: string, minutes: number) {
    if (deps.provider && name !== deps.provider) return false;
    // A manual request can skip the normal interval, but not the shared
    // minute claim or spend caps. Automated calls claim the same minute too.
    const before = previous.get(name);
    if (!deps.provider && before && at.getTime() - before.at < minutes * 60_000) return false;
    if (!deps.provider && !(await store.claim(`canary:due:${name}:${minutes}:${Math.floor(at.getTime() / (minutes * 60_000))}`))) return false;
    return store.claim(`canary:attempt:${name}:${Math.floor(at.getTime() / 60_000)}`);
  }
  async function save(name: string, result: ProbeResult) {
    await storeProviderProbe(deps.db, name, result, at);
    if (result.ok && !result.skipped) {
      const [quota] = rowsOf<{ value: { at?: number } }>(await deps.db.execute(sql`select value from platform_settings where key = ${`provider_quota:last:${name}`}`));
      if ((safeTime(quota?.value?.at) ?? 0) <= at.getTime()) await new CircuitBreaker(breakerStore).reset(name);
    }
    if (!result.ok && previous.get(name)?.ok !== false) {
      const outcome = await alerts.send(`alerts:probe_failed:${name}:${previous.get(name)?.passedAt ?? "first"}`, "provider_probe_failed", {
        subject: `Curvi: ${name} probe failed`, text: "The provider or storage canary did not pass. Check the operations overview before retrying paid work.",
      }, { provider: name });
      if (outcome === "log") reportAlert("A provider probe alert could not be emailed.", { alert: "provider_probe_email_failed", provider: name }, "error");
    }
    if (typeof result.balanceCredits === "number" && result.balanceCredits < providerAlertPolicy.lowBalance.bflCredits) {
      const outcome = await alerts.send(`alerts:bfl_balance_low:${name}:${at.toISOString().slice(0, 10)}`, "bfl_balance_low", {
        subject: "Curvi: the BFL credit balance is low",
        text: `BFL reports ${result.balanceCredits} credits, below the configured ${providerAlertPolicy.lowBalance.bflCredits} credit alert line. Check the account before scene generation is interrupted.`,
      }, { provider: name, balanceCredits: result.balanceCredits });
      if (outcome === "log") reportAlert("The BFL low balance alert could not be emailed.", { alert: "bfl_balance_email_failed" }, "error");
    }
    ran.push(name);
  }
  for (const target of targets) {
    if (!target.configured || !target.provider) continue;
    const recovery = previous.get(target.name)?.ok === false || await new CircuitBreaker(breakerStore).openReason(target.name) === "quota";
    const minutes = target.kind === "cutout"
      ? recovery ? canaryPolicy.recoveryEveryMinutes : target.envVar.endsWith("_BACKUP") ? canaryPolicy.backupEveryMinutes : canaryPolicy.primaryEveryMinutes
      : canaryPolicy.keyProbeEveryMinutes;
    if (!(await due(target.name, minutes))) continue;
    if (target.kind === "cutout") {
      const result = await runPinnedCutoutCanary({ provider: target.provider, meter, breakerStore, caps,
        maxCostMicros: Math.max(0, canaryPolicy.maxMicrosPerRun - spent),
        onProviderQuota: processQuotaNotifier(deps.db, store).onProviderQuota });
      spent += result.costMicros;
      await save(target.name, result);
    } else {
      const [result] = await probeProviders([{ name: target.name, provider: target.provider }]);
      await save(target.name, result);
    }
  }
  const storage = deps.storage === undefined ? liveCanaryStorage(readEnv) : deps.storage;
  if (storage && await due("r2", canaryPolicy.keyProbeEveryMinutes)) await save("r2", await runStorageCanary(storage));
  // Existing fal balance probe has its own event and email dedupe; only the
  // all-provider run performs it, and a durable minute claim avoids repeats.
  if (!deps.provider && await store.claim(`canary:fal_balance:${Math.floor(at.getTime() / (canaryPolicy.keyProbeEveryMinutes * 60_000))}`)) {
    await checkFalBalances({ db: deps.db, readEnv, dedupe: store, alerts });
  }
  const latest = await readProviderProbes(deps.db);
  const probes = ran.flatMap((name) => latest.has(name) ? [latest.get(name)!] : []);
  return { ok: probes.every((probe) => probe.ok), probes };
}

/** Persistent timer; caller supplies the fresh preflight verdict. */
export async function notifyStagePaused(db: ProbeDb, verdict: string, alerts: FounderAlerts, now = new Date()): Promise<void> {
  const key = "provider_stage:cutout";
  if (verdict !== "packs_paused") {
    await db.execute(sql`delete from platform_settings where key = ${key}`);
    return;
  }
  await db.execute(sql`insert into platform_settings (key, value, updated_at) values (${key}, ${JSON.stringify({ since: now.getTime() })}::jsonb, ${now}) on conflict (key) do nothing`);
  const [row] = rowsOf<{ value: { since?: number } }>(await db.execute(sql`select value from platform_settings where key = ${key}`));
  const since = safeTime(row?.value?.since);
  if (since === null || now.getTime() - since < providerAlertPolicy.stagePausedMinutes * 60_000) return;
  const outcome = await alerts.send(`alerts:stage_paused:cutout:${since}`, "stage_paused", {
    subject: "Packs are paused: no cutout provider is available",
    text: `Background removal has been unavailable for at least ${providerAlertPolicy.stagePausedMinutes} minutes. Check provider credit and the latest canary results in the operations overview.`,
  });
  if (outcome === "log") reportAlert("The stage paused alert could not be emailed.", { alert: "stage_paused_email_failed" }, "error");
}
