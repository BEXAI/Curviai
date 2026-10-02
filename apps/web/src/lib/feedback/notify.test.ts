import { describe, expect, it, vi } from "vitest";
import { notifyUnusableFeedback } from "./notify";
import type { FeedbackAnswer } from "./types";
const answer: FeedbackAnswer = { usable: "not_yet", wouldPay: null, comment: "Wrong lighting", quoteConsent: false, displayName: null };
describe("unusable pack notification", () => {
  it("emails at most once per job, with the job link and comment", async () => {
    const keys = new Set<string>(); const send = vi.fn(async (_email: { subject: string; text: string }) => ({ ok: true }));
    const deps = { claim: async (key: string) => { if (keys.has(key)) return false; keys.add(key); return true; }, release: async (key: string) => { keys.delete(key); }, send };
    await Promise.all([notifyUnusableFeedback("job", answer, deps), notifyUnusableFeedback("job", answer, deps)]);
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining("/app/jobs/job\n\nWrong lighting") });
    expect(keys.has("feedback:job")).toBe(true);
  });
  it("skips positive answers and releases the claim on send failure", async () => {
    const deps = { claim: vi.fn(async () => true), release: vi.fn(async () => {}), send: vi.fn(async () => ({ ok: false })) };
    await notifyUnusableFeedback("job", { ...answer, usable: "yes" }, deps); expect(deps.claim).not.toHaveBeenCalled();
    await notifyUnusableFeedback("job", answer, deps); expect(deps.release).toHaveBeenCalledWith("feedback:job");
  });
});
