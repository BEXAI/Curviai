import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn());
vi.mock("@/lib/provider-canary", () => ({ runProviderCanaryNow: run }));
const { POST } = await import("./route");
beforeEach(() => { vi.stubEnv("CRON_SECRET", "cron-test"); run.mockReset().mockResolvedValue({ ok: true, skipped: "disabled", probes: [] }); });
afterEach(() => vi.unstubAllEnvs());
describe("provider canary cron", () => {
  it("does no work before authentication and reports a disabled canary explicitly", async () => {
    expect((await POST(new Request("https://curvi.ai/api/cron/provider-canary", { method: "POST" }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    const response = await POST(new Request("https://curvi.ai/api/cron/provider-canary", { method: "POST", headers: { authorization: "Bearer cron-test" } }));
    expect(await response.json()).toEqual({ ok: true, skipped: "disabled", probes: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
