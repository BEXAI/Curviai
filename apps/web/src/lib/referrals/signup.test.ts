import { beforeEach, describe, expect, it, vi } from "vitest";

// The auth callback's referral step (P18-24): only a clean code, only with
// a database and the switch on, and never a thrown error.

const state = vi.hoisted(() => ({ dbMode: true, on: true }));
const record = vi.hoisted(() =>
  vi.fn<(db: unknown, input: { userId: string; code: string }) => Promise<{ outcome: "pending"; referralId: string }>>(
    async () => ({ outcome: "pending", referralId: "r1" }),
  ),
);
const fakeDb = vi.hoisted(() => ({ marker: "db" }));

vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
vi.mock("./switch", () => ({ referralsOn: async () => state.on }));
vi.mock("./service", () => ({ recordReferralSignup: record }));

const { recordSignupReferral } = await import("./signup");

const USER = "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a092";

beforeEach(() => {
  state.dbMode = true;
  state.on = true;
  record.mockClear();
});

describe("recordSignupReferral", () => {
  it("records a clean code for the new user", async () => {
    expect(await recordSignupReferral("ABCD2345", USER)).toEqual({ outcome: "pending", referralId: "r1" });
    expect(record).toHaveBeenCalledWith(fakeDb, { userId: USER, code: "abcd2345" });
  });

  it("does nothing without a code, a user, a database or the switch", async () => {
    expect(await recordSignupReferral(undefined, USER)).toBeNull();
    expect(await recordSignupReferral("<bad>", USER)).toBeNull();
    expect(await recordSignupReferral("abcd2345", null)).toBeNull();
    state.dbMode = false;
    expect(await recordSignupReferral("abcd2345", USER)).toBeNull();
    state.dbMode = true;
    state.on = false;
    expect(await recordSignupReferral("abcd2345", USER)).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it("logs and carries on when the write fails", async () => {
    record.mockRejectedValueOnce(new Error("db down"));
    const log = { error: vi.fn() };
    expect(await recordSignupReferral("abcd2345", USER, log)).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
