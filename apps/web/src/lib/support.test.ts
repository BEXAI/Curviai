import { describe, expect, it, vi } from "vitest";
import { submitSupport, supportInput, type SupportDeps } from "./support";
const job = "10000000-0000-4000-8000-000000000001";
const input = { topic: "pack" as const, message: "This private pack message", email: "visitor@example.com", job, requestId: "20000000-0000-4000-8000-000000000001" };
function deps() { return { ownsJob: vi.fn(async () => true), deliver: vi.fn(async () => true), acknowledge: vi.fn(async () => {}), record: vi.fn(async () => {}) } satisfies SupportDeps; }
describe("support requests", () => {
  it("enforces message and email bounds", () => {
    expect(supportInput.safeParse(input).success).toBe(true);
    for (const message of ["short", "x".repeat(2001)]) expect(supportInput.safeParse({ ...input, message }).success).toBe(false);
  });
  it("drops a visitor's job and sends no acknowledgment without CAPTCHA", async () => {
    const d = deps(); expect(await submitSupport(input, null, false, d)).toBe(true);
    expect(d.deliver).toHaveBeenCalledWith(expect.objectContaining({ email: input.email, job: null }));
    expect(d.ownsJob).not.toHaveBeenCalled(); expect(d.acknowledge).not.toHaveBeenCalled();
    expect(JSON.stringify(d.record.mock.calls)).not.toContain(input.message);
  });
  it("uses the verified account email and checks workspace ownership", async () => {
    const d = deps(); d.ownsJob.mockResolvedValue(false);
    await submitSupport(input, { userId: "user", workspaceId: "workspace", email: "member@example.com" }, false, d);
    expect(d.ownsJob).toHaveBeenCalledWith("workspace", job);
    expect(d.deliver).toHaveBeenCalledWith(expect.objectContaining({ email: "member@example.com", job: null }));
    expect(d.acknowledge).toHaveBeenCalledWith({ key: `support:user:${input.requestId}:reply`, email: "member@example.com", workspaceId: "workspace" });
    expect(JSON.stringify(d.acknowledge.mock.calls)).not.toContain(input.message);
  });
  it("acknowledges a human checked visitor but never a honeypot or failed delivery", async () => {
    const d = deps(); await submitSupport(input, null, true, d); expect(d.acknowledge).toHaveBeenCalledTimes(1);
    const blocked = deps(); await submitSupport({ ...input, website: "spam" }, null, true, blocked); expect(blocked.deliver).not.toHaveBeenCalled();
    blocked.deliver.mockResolvedValue(false); expect(await submitSupport(input, null, true, blocked)).toBe(false); expect(blocked.acknowledge).not.toHaveBeenCalled();
  });
});
