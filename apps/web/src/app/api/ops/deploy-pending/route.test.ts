import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ write: vi.fn(), db: {} }));
vi.mock("@/lib/ops/switches", () => ({ setOperatorSwitch: state.write }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => state.db }));
import { POST } from "./route";
const request = (body: unknown, token = "release-test-only") => new Request("https://curvi.ai/api/ops/deploy-pending", {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
});
beforeEach(() => { vi.stubEnv("OPS_RELEASE_TOKEN", "release-test-only"); vi.stubEnv("OPS_EMAILS", "ops@curvi.ai"); state.write.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
describe("release flag capability", () => {
  it("refuses unrelated credentials and extra keys before any write", async () => {
    expect((await POST(request({ on: true, setBy: "ops@curvi.ai" }, "cron-test-only"))).status).toBe(401);
    expect((await POST(request({ on: true, setBy: "ops@curvi.ai", key: "ops:global_hard_stop_usd" }))).status).toBe(400);
    expect(state.write).not.toHaveBeenCalled();
  });
  it("writes only the expiring deploy flag through the audited switch transaction", async () => {
    expect((await POST(request({ on: true, setBy: "ops@curvi.ai" }))).status).toBe(200);
    expect(state.write).toHaveBeenCalledWith(state.db, { key: "ops:deploy_pending", value: "true", operator: "ops@curvi.ai" });
  });
  it("fails closed when the release credential is absent or the audit write fails", async () => {
    state.write.mockRejectedValueOnce(new Error("audit unavailable"));
    expect((await POST(request({ on: false, setBy: "ops@curvi.ai" }))).status).toBe(503);
    vi.stubEnv("OPS_RELEASE_TOKEN", "");
    expect((await POST(request({ on: true, setBy: "ops@curvi.ai" }))).status).toBe(503);
  });
});
