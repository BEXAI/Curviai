import { describe, expect, it } from "vitest";
import { FRESH_VERIFICATION_MS, isFreshVerification, welcomePath } from "./verification";

describe("fresh verification", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  it("is true only within the window after the email was confirmed", () => {
    expect(isFreshVerification({ email_confirmed_at: new Date(now - 60_000).toISOString() }, now)).toBe(true);
    expect(isFreshVerification({ email_confirmed_at: new Date(now - FRESH_VERIFICATION_MS - 1).toISOString() }, now)).toBe(false);
    expect(isFreshVerification({ email_confirmed_at: null }, now)).toBe(false);
    expect(isFreshVerification(null, now)).toBe(false);
  });

  it("carries the destination to the welcome page", () => {
    expect(welcomePath("/app")).toBe("/welcome");
    expect(welcomePath("/app/billing?plan=growth")).toBe("/welcome?next=%2Fapp%2Fbilling%3Fplan%3Dgrowth");
  });
});
