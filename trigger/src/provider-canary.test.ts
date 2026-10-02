import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@curvi/db/testing";
import { sql, type Db } from "@curvi/db";
import { CircuitBreaker, InMemoryBreakerStore, ProviderError, SpendCaps } from "@curvi/ai";
import { InMemoryCapStore, InMemoryCostMeter, MockProvider } from "@curvi/ai/testing";
import { encodePng, solidCanvas } from "@curvi/pipeline";
import { canaryPolicy, spendCapPolicy, llmModelProviders } from "@curvi/pipeline/seed";
import { FounderAlerts } from "./provider-balance";
import { ProviderQuotaNotifier } from "./provider-quota";
import { llmModelProviderName } from "./recipes";
import { canaryFixture, notifyStagePaused, readProviderProbes, resetProviderProbe, runPinnedCutoutCanary, runProviderCanaries, runStorageCanary, storeProviderProbe } from "./provider-canary";

const NOW = new Date("2026-10-02T12:00:00Z");
let created: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
beforeAll(async () => { created = await createTestDb(); db = created.db as unknown as Db; });
afterAll(async () => { await created.client.close(); });
beforeEach(async () => { await created.client.exec("delete from platform_settings; delete from events; delete from spend_cap_counters"); });

async function output() {
  const image = solidCanvas(64, 64, 40, 100, 180, 0);
  for (let y = 16; y < 48; y += 1) for (let x = 20; x < 44; x += 1) image.data[(y * 64 + x) * 4 + 3] = 255;
  return { imageBytes: await encodePng(image), contentType: "image/png" };
}
function alerts() {
  const instance = new FounderAlerts({ readEnv: () => undefined, log: { warn() {}, error() {} } });
  const send = vi.spyOn(instance, "send").mockResolvedValue("email");
  return { instance, send };
}

describe("pinned, capped provider canaries", () => {
  it("tests an open provider directly and meters it without clearing the trip before persistence", async () => {
    const provider = new MockProvider({ name: "fal-birefnet", kind: "cutout", output: await output(), estimateMicros: 10000, costMicros: 10000 });
    const breakerStore = new InMemoryBreakerStore();
    const breaker = new CircuitBreaker(breakerStore);
    await breaker.tripForQuota(provider.name);
    const meter = new InMemoryCostMeter();
    const capStore = new InMemoryCapStore();
    const caps = new SpendCaps(capStore, () => NOW, spendCapPolicy);
    const result = await runPinnedCutoutCanary({ provider, breakerStore, meter, caps });
    expect(result).toMatchObject({ ok: true, costMicros: 10000 });
    expect(provider.invocations).toBe(1);
    expect(meter.entries).toHaveLength(1);
    expect(meter.entries[0]).toMatchObject({ provider: "fal-birefnet", costMicros: 10000, ok: true });
    expect(await breaker.openReason(provider.name)).toBe("quota");
    expect((await caps.checkAndReserveGlobalDay(0)).totalMicros).toBe(10000);
  });

  it("retains a failing trip and refuses estimated spend above either cap without invoking", async () => {
    const provider = new MockProvider({ name: "fal-birefnet", kind: "cutout", output: await output(), estimateMicros: 10000, costMicros: 10000 });
    const breakerStore = new InMemoryBreakerStore();
    const breaker = new CircuitBreaker(breakerStore);
    await breaker.tripForQuota(provider.name);
    const meter = new InMemoryCostMeter();
    const caps = new SpendCaps(new InMemoryCapStore(), () => NOW, { ...spendCapPolicy, globalDailyHardStopMicros: 5000 });
    expect((await runPinnedCutoutCanary({ provider, breakerStore, meter, caps })).ok).toBe(false);
    expect(provider.invocations).toBe(0);
    const roomy = new SpendCaps(new InMemoryCapStore(), () => NOW, spendCapPolicy);
    expect((await runPinnedCutoutCanary({ provider, breakerStore, meter, caps: roomy, maxCostMicros: 9999 })).ok).toBe(false);
    expect(provider.invocations).toBe(0);
    expect(await breaker.openReason(provider.name)).toBe("quota");
    const fails = new MockProvider({ name: "fal-birefnet", kind: "cutout", failTimes: Infinity, estimateMicros: 10000,
      failWith: () => new ProviderError("quota", "fal-birefnet", "cutout", false, undefined, { code: "provider_quota" }) });
    expect((await runPinnedCutoutCanary({ provider: fails, breakerStore, meter, caps: roomy })).status).toBe(402);
    expect(fails.invocations).toBe(1);
    expect(await breaker.openReason(provider.name)).toBe("quota");
  });

  it("does not accept an opaque image as successful background removal", async () => {
    const provider = new MockProvider({ name: "fal-birefnet", kind: "cutout", output: { imageBytes: await canaryFixture(), contentType: "image/png" }, estimateMicros: 10000, costMicros: 10000 });
    const result = await runPinnedCutoutCanary({ provider, breakerStore: new InMemoryBreakerStore(), meter: new InMemoryCostMeter(), caps: new SpendCaps(new InMemoryCapStore(), () => NOW, spendCapPolicy) });
    expect(result).toMatchObject({ ok: false, costMicros: 10000 });
  });
});

describe("durable probe state and scheduling", () => {
  it("skips disabled work before reading settings or touching a provider", async () => {
    expect(await runProviderCanaries({ db: {} as Db, enabled: false })).toEqual({ ok: true, skipped: "disabled", probes: [] });
  });

  it("persists pass and reset times, preserves the latest failure, and ignores a skipped probe", async () => {
    await storeProviderProbe(db, "fal-birefnet", { ok: true, status: 200, latencyMs: 7 }, NOW);
    const later = new Date(NOW.getTime() + 1_000);
    await storeProviderProbe(db, "fal-birefnet", { ok: false, status: 402, latencyMs: 8 }, later);
    await storeProviderProbe(db, "fal-birefnet", { ok: true, status: null, latencyMs: 0, skipped: "unavailable" }, new Date(later.getTime() + 1));
    // Out-of-order success must not erase a newer failure.
    await storeProviderProbe(db, "fal-birefnet", { ok: true, status: 200, latencyMs: 1 }, NOW);
    const freshRead = await readProviderProbes(db);
    expect(freshRead.get("fal-birefnet")).toMatchObject({ ok: false, at: later.getTime(), passedAt: NOW.getTime() });
    const breakerStore = new InMemoryBreakerStore();
    await new CircuitBreaker(breakerStore).tripForQuota("fal-birefnet");
    await resetProviderProbe(db, "fal-birefnet", new Date(later.getTime() + 2), breakerStore);
    expect((await readProviderProbes(db)).get("fal-birefnet")?.resetAt).toBe(later.getTime() + 2);
    expect(await new CircuitBreaker(breakerStore).isOpen("fal-birefnet")).toBe(false);
    await expect(resetProviderProbe(db, "unknown-provider", NOW, breakerStore)).rejects.toThrow("Unknown provider");
  });

  it("runs only due targets across fresh invocations and clears a quota trip only after a recorded pass", async () => {
    const provider = new MockProvider({ name: "fal-birefnet", kind: "cutout", output: await output(), estimateMicros: 10000, costMicros: 10000 });
    const backup = new MockProvider({ name: "fal-birefnet-backup", kind: "cutout", output: await output(), estimateMicros: 10000, costMicros: 10000 });
    const breakerStore = new InMemoryBreakerStore();
    await new CircuitBreaker(breakerStore).tripForQuota(provider.name);
    const notify = alerts();
    const deps = { db, enabled: true, readEnv: () => undefined, now: () => NOW, breakerStore, alerts: notify.instance, storage: null,
      targets: [
        { name: provider.name, kind: "cutout" as const, envVar: "FAL_KEY", stages: ["cutout"], configured: true, provider },
        { name: backup.name, kind: "cutout" as const, envVar: "FAL_KEY_BACKUP", stages: ["cutout"], configured: true, provider: backup },
      ] };
    const result = await runProviderCanaries(deps);
    expect(result.ok).toBe(true);
    expect(result.probes).toHaveLength(2);
    expect(await new CircuitBreaker(breakerStore).isOpen(provider.name)).toBe(false);
    expect((await readProviderProbes(db)).get(provider.name)?.passedAt).toBe(NOW.getTime());
    await runProviderCanaries({ ...deps, now: () => new Date(NOW.getTime() + 60_000) });
    expect(provider.invocations).toBe(1);
    expect(backup.invocations).toBe(1);
    await runProviderCanaries({ ...deps, now: () => new Date(NOW.getTime() + canaryPolicy.primaryEveryMinutes * 60_000) });
    expect(provider.invocations).toBe(2);
    expect(backup.invocations).toBe(1);
  });

  it("stores every quota answer even when its email/history event is deduplicated", async () => {
    let now = NOW.getTime();
    const notifier = new ProviderQuotaNotifier({ db, now: () => now, log: { warn() {}, error() {} } });
    await notifier.notify({ provider: "fal-birefnet", task: "cutout", message: "quota" });
    now += 1000;
    await notifier.notify({ provider: "fal-birefnet", task: "cutout", message: "quota again" });
    const result = await db.execute(sql`select value from platform_settings where key = 'provider_quota:last:fal-birefnet'`);
    const rows = (Array.isArray(result) ? result : (result as unknown as { rows: { value: { at: number } }[] }).rows) as unknown as { value: { at: number } }[];
    expect(rows[0].value.at).toBe(now);
  });

  it("uses the recovery cadence from durable failure state after a process restart", async () => {
    const provider = new MockProvider({ name: "fal-birefnet", kind: "cutout", output: await output(), estimateMicros: 10000, costMicros: 10000 });
    await storeProviderProbe(db, provider.name, { ok: false, status: 402, latencyMs: 2 }, NOW);
    const deps = { db, enabled: true, readEnv: () => undefined, storage: null,
      breakerStore: new InMemoryBreakerStore(), alerts: alerts().instance,
      targets: [{ name: provider.name, kind: "cutout" as const, envVar: "FAL_KEY", stages: ["cutout"], configured: true, provider }] };
    await runProviderCanaries({ ...deps, now: () => new Date(NOW.getTime() + (canaryPolicy.recoveryEveryMinutes - 1) * 60_000) });
    expect(provider.invocations).toBe(0);
    await runProviderCanaries({ ...deps, now: () => new Date(NOW.getTime() + canaryPolicy.recoveryEveryMinutes * 60_000) });
    expect(provider.invocations).toBe(1);
    expect((await readProviderProbes(db)).get(provider.name)?.ok).toBe(true);
  });

  it("alerts each LLM family through the unified quota notifier", async () => {
    const notify = alerts();
    const notifier = new ProviderQuotaNotifier({ now: () => NOW.getTime(), alerts: notify.instance, log: { warn() {}, error() {} } });
    for (const family of ["openai", "anthropic"]) {
      const [model] = Object.entries(llmModelProviders).find(([, value]) => value === family)!;
      const info = { provider: llmModelProviderName(model), task: "shot_planner", message: "quota" };
      await notifier.notify(info); await notifier.notify(info);
    }
    await notifier.flush();
    expect(notify.send).toHaveBeenCalledTimes(2);
  });
});

describe("storage and paused-stage probes", () => {
  it("round trips only a unique canary object and always attempts cleanup after a read failure", async () => {
    let contents: Buffer | null = null;
    const storage = { put: vi.fn(async (_key: string, bytes: Buffer) => { contents = bytes; }), get: vi.fn(async () => contents), delete: vi.fn(async () => {}) };
    expect((await runStorageCanary(storage)).ok).toBe(true);
    expect(storage.put.mock.calls[0][0]).toMatch(/^tmp\/ops\/canary\/[a-f0-9-]+\.txt$/);
    storage.get.mockRejectedValueOnce(new Error("offline"));
    expect((await runStorageCanary(storage)).ok).toBe(false);
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it("starts a durable paused timer, alerts after ten minutes, and resets it on recovery", async () => {
    const notify = alerts();
    await notifyStagePaused(db, "packs_paused", notify.instance, NOW);
    await notifyStagePaused(db, "packs_paused", notify.instance, new Date(NOW.getTime() + 9 * 60_000));
    expect(notify.send).not.toHaveBeenCalled();
    await notifyStagePaused(db, "packs_paused", notify.instance, new Date(NOW.getTime() + 10 * 60_000));
    expect(notify.send).toHaveBeenCalledTimes(1);
    await notifyStagePaused(db, "ok", notify.instance, new Date(NOW.getTime() + 11 * 60_000));
    await notifyStagePaused(db, "packs_paused", notify.instance, new Date(NOW.getTime() + 12 * 60_000));
    expect(notify.send).toHaveBeenCalledTimes(1);
  });
});
