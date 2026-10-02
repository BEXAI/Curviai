import { beforeEach, describe, expect, it, vi } from "vitest";
import { webhookPolicy } from "@curvi/pipeline/seed";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
const state = vi.hoisted(() => ({ session: vi.fn(), create: vi.fn(), change: vi.fn(), verify: vi.fn(), replay: vi.fn(), transport: vi.fn() }));
vi.mock("@/lib/webhooks/session", () => ({ webhookSession: state.session }));
vi.mock("@/lib/webhooks/db-store", () => ({ createWebhook: state.create, changeWebhook: state.change, verifyAndEnableWebhook: state.verify, replayWebhook: state.replay }));
vi.mock("@/lib/webhooks/transport", () => ({ deliverWebhook: state.transport }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { webhookAction } from "./actions";
const session = () => ({ ok: true, actor: { workspaceId: "workspace", userId: "owner", role: "owner" }, db: {}, keys: [{ kid: "fixture", secret: "fixture-secret-key-not-for-live-use" }] });
beforeEach(() => {
  vi.clearAllMocks(); setRateLimitStoreForTests(new MemoryRateLimitStore()); state.session.mockResolvedValue(session());
  for (const fn of [state.create, state.change, state.verify, state.replay]) fn.mockResolvedValue({ ok: true, notice: "Fixture result" });
});
describe("webhook server action gates", () => {
  it("does not call management or transport without an authorized session", async () => {
    state.session.mockResolvedValue({ ok: false, notice: "Only workspace owners and admins can manage webhooks." });
    expect((await webhookAction({ action: "verify", id: "endpoint" })).ok).toBe(false);
    expect(state.verify).not.toHaveBeenCalled(); expect(state.transport).not.toHaveBeenCalled();
  });
  it("blocks activation when signing is unavailable while retaining disable and deletion", async () => {
    state.session.mockResolvedValue({ ...session(), keys: null });
    expect((await webhookAction({ action: "verify", id: "endpoint" })).ok).toBe(false);
    expect(state.verify).not.toHaveBeenCalled();
    expect((await webhookAction({ action: "disable", id: "endpoint" })).ok).toBe(true);
    expect((await webhookAction({ action: "delete", id: "endpoint" })).ok).toBe(true);
    expect(state.change).toHaveBeenCalledTimes(2);
  });
  it("does not echo SQL, receiver paths or signing material on failures", async () => {
    state.create.mockRejectedValue(new Error("secret-value https://receiver.example/private-token encrypted_secret"));
    const result = await webhookAction({ action: "create", name: "Fixture", url: "https://receiver.example/hook" });
    expect(result.ok).toBe(false);
    expect(result.notice).not.toContain("secret");
    expect(result.notice).not.toContain("private-token");
  });
  it("caps setup/verification attempts across delete/recreate cycles and keeps disable available", async () => {
    for (let i=0; i<webhookPolicy.managementPerHour; i+=1) expect((await webhookAction({ action: "create", name: "Fixture", url: "https://fixture.example" })).ok).toBe(true);
    expect((await webhookAction({ action: "verify", id: "endpoint" })).ok).toBe(false);
    expect(state.verify).not.toHaveBeenCalled();
    expect((await webhookAction({ action: "disable", id: "endpoint" })).ok).toBe(true);
    // A second admin shares the workspace ceiling.
    state.session.mockResolvedValue({ ...session(), actor: { ...session().actor, userId: "second-admin", role: "admin" } });
    expect((await webhookAction({ action: "verify", id: "endpoint" })).ok).toBe(false);
    expect(state.verify).not.toHaveBeenCalled();
  });
});
