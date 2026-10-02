import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ dbMode: true, run: vi.fn(), preflight: vi.fn(), clear: vi.fn(), notify: vi.fn(), getDb: vi.fn() }));
vi.mock("@curvi/trigger/provider-canary", () => ({ runProviderCanaries: state.run, notifyStagePaused: state.notify }));
vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: state.getDb }));
vi.mock("@/lib/provider-preflight", () => ({ clearProviderPreflightCache: state.clear, providerPreflightDetail: state.preflight }));
const { runProviderCanaryNow } = await import("./provider-canary");
beforeEach(() => {
  vi.stubEnv("CURVI_PROVIDER_CANARY_ENABLED", "");
  state.dbMode = true;
  state.run.mockReset().mockResolvedValue({ ok: true, probes: [] });
  state.preflight.mockReset().mockResolvedValue({ verdict: "ok", cause: null });
  state.clear.mockReset(); state.notify.mockReset(); state.getDb.mockReset().mockReturnValue({});
});
afterEach(() => vi.unstubAllEnvs());
describe("provider canary activation", () => {
  it("leaves metered checks off by default before reading the database", async () => {
    expect(await runProviderCanaryNow()).toEqual({ ok: true, skipped: "disabled", probes: [] });
    expect(state.run).not.toHaveBeenCalled();
    expect(state.getDb).not.toHaveBeenCalled();
  });
  it("refuses demo mode and validates operator provider selections", async () => {
    vi.stubEnv("CURVI_PROVIDER_CANARY_ENABLED", "1"); state.dbMode = false;
    expect((await runProviderCanaryNow()).skipped).toBe("unconfigured");
    await expect(runProviderCanaryNow("unknown")).rejects.toThrow("Unknown provider");
    expect(state.run).not.toHaveBeenCalled();
  });
  it("restores durable trips before a run and recomputes the pause afterward", async () => {
    vi.stubEnv("CURVI_PROVIDER_CANARY_ENABLED", "1");
    expect((await runProviderCanaryNow("fal-birefnet")).ok).toBe(true);
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ provider: "fal-birefnet", enabled: true }));
    expect(state.preflight).toHaveBeenCalledTimes(2);
    expect(state.notify).toHaveBeenCalledWith(expect.anything(), "ok", expect.anything());
  });
});
