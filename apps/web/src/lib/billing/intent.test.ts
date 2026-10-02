import { describe, expect, it } from "vitest";
import { signupHref } from "./intent";

describe("signupHref", () => {
  it("keeps the pricing link exactly as before", () => {
    expect(signupHref({ plan: "growth", cadence: "annual", source: "pricing" })).toBe(
      "/signup?plan=growth&cadence=annual&source=pricing",
    );
    expect(signupHref({ plan: "starter", source: "pricing" })).toBe(
      "/signup?plan=starter&cadence=monthly&source=pricing",
    );
    expect(signupHref({ source: "pricing" })).toBe("/signup?source=pricing");
  });

  it("forwards validated extras after the source", () => {
    expect(
      signupHref({ source: "share", extra: { s: "k7mxq2rtva", channel: "walmart", category: "candles" } }),
    ).toBe("/signup?source=share&s=k7mxq2rtva&category=candles&channel=walmart");
    expect(signupHref({ source: "tool_checker_google" })).toBe("/signup?source=tool_checker_google");
  });

  it("leaves bad values off instead of failing the page", () => {
    expect(signupHref({ source: "share", extra: { s: "../../x", channel: "myspace", ref: "" } })).toBe(
      "/signup?source=share",
    );
    expect(signupHref({ source: "lp_" as "lp_x" })).toBe("/signup");
  });
});
