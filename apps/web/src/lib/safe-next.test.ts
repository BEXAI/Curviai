import { describe, expect, it } from "vitest";
import { tiers } from "@curvi/pipeline/seed";
import {
  AUTH_ERROR_MESSAGES,
  authErrorMessage,
  checkoutPath,
  parseCheckoutIntent,
  parseSignupSource,
  postAuthDestination,
  postAuthParamsFrom,
  safeNextPath,
} from "./safe-next";

const ORIGIN = "https://curvi.ai";

describe("safeNextPath (Update.md 4.3 open redirect)", () => {
  it.each([
    ["/\\evil.com", "a raw backslash"],
    ["/%5Cevil.com", "an encoded backslash"],
    ["/%5cevil.com", "a lowercase encoded backslash"],
    ["//evil.com", "a protocol relative path"],
    ["///evil.com", "a triple slash"],
    ["https://evil.com", "an absolute url"],
    ["http://curvi.ai.evil.com/app", "a lookalike host"],
    ["\t/evil.com", "a tab before the path"],
    ["/\t/evil.com", "a tab the URL parser would strip"],
    ["/\n/evil.com", "a newline the URL parser would strip"],
    ["/%09/evil.com", "an encoded tab"],
    ["/%0d%0a/evil.com", "an encoded CRLF"],
    ["/.//evil.com", "dot segments collapsing to a protocol relative path"],
    ["/%2F%2Fevil.com", "encoded slashes"],
    ["javascript:alert(1)", "a script url"],
    ["app", "a relative path"],
    ["", "an empty value"],
    ["/%E0%A4%A", "a malformed escape"],
    [`/${"a".repeat(3000)}`, "an oversized value"],
  ])("rejects %s (%s)", (raw) => {
    expect(safeNextPath(raw, ORIGIN)).toBe("/app");
  });

  it("rejects null and undefined", () => {
    expect(safeNextPath(null, ORIGIN)).toBe("/app");
    expect(safeNextPath(undefined, ORIGIN)).toBe("/app");
  });

  it("keeps a valid in app path with its query string and hash", () => {
    const job = "/app/jobs/0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
    expect(safeNextPath(job, ORIGIN)).toBe(job);
    expect(safeNextPath("/app/billing?checkout=growth&cadence=annual", ORIGIN)).toBe(
      "/app/billing?checkout=growth&cadence=annual",
    );
    expect(safeNextPath("/reset-password#top", ORIGIN)).toBe("/reset-password#top");
  });

  it("uses the caller's fallback", () => {
    expect(safeNextPath("//evil.com", ORIGIN, "/app/billing")).toBe("/app/billing");
  });

  it("never returns a value that resolves off site", () => {
    const payloads = ["/\\evil.com", "/%5Cevil.com", "//evil.com", "/.//evil.com", "/\t/evil.com"];
    for (const payload of payloads) {
      const result = safeNextPath(payload, ORIGIN);
      expect(new URL(result, ORIGIN).origin).toBe(ORIGIN);
    }
  });
});

describe("parseCheckoutIntent", () => {
  const paid = tiers.filter((t) => t.monthlyUsd > 0);

  it("accepts every paid tier from the seed on both cadences", () => {
    for (const tier of paid) {
      expect(parseCheckoutIntent(tier.key, "monthly")).toEqual({ plan: tier.key, cadence: "monthly" });
      expect(parseCheckoutIntent(tier.key, "annual")).toEqual({ plan: tier.key, cadence: "annual" });
    }
  });

  it("defaults a missing cadence to monthly and normalizes case", () => {
    const tier = paid[0].key;
    expect(parseCheckoutIntent(tier, null)).toEqual({ plan: tier, cadence: "monthly" });
    expect(parseCheckoutIntent(tier.toUpperCase(), "ANNUAL")).toEqual({ plan: tier, cadence: "annual" });
  });

  it("rejects the free tier, unknown plans and unknown cadences", () => {
    expect(parseCheckoutIntent("free", "monthly")).toBeNull();
    expect(parseCheckoutIntent("enterprise", "monthly")).toBeNull();
    expect(parseCheckoutIntent(paid[0].key, "weekly")).toBeNull();
    expect(parseCheckoutIntent(null, "annual")).toBeNull();
    expect(parseCheckoutIntent("", "annual")).toBeNull();
  });
});

describe("postAuthDestination", () => {
  it("sends a pricing intent to the billing checkout", () => {
    const tier = tiers.find((t) => t.monthlyUsd > 0)!.key;
    expect(postAuthDestination({ plan: tier, cadence: "annual" }, ORIGIN)).toBe(
      `/app/billing?checkout=${tier}&cadence=annual`,
    );
    expect(checkoutPath({ plan: tier, cadence: "monthly" })).toBe(`/app/billing?checkout=${tier}&cadence=monthly`);
  });

  it("prefers a valid intent over next, and falls back to a safe next", () => {
    const tier = tiers.find((t) => t.monthlyUsd > 0)!.key;
    expect(postAuthDestination({ plan: tier, next: "/app/brand" }, ORIGIN)).toBe(
      `/app/billing?checkout=${tier}&cadence=monthly`,
    );
    expect(postAuthDestination({ plan: "free", next: "/app/brand" }, ORIGIN)).toBe("/app/brand");
    expect(postAuthDestination({ next: "/%5Cevil.com" }, ORIGIN)).toBe("/app");
    expect(postAuthDestination({}, ORIGIN)).toBe("/app");
  });

  it("reads its params from a query string", () => {
    const params = postAuthParamsFrom(new URLSearchParams("next=%2Fapp%2Fnew&plan=growth&cadence=annual"));
    expect(params).toEqual({ next: "/app/new", plan: "growth", cadence: "annual" });
  });
});

describe("parseSignupSource", () => {
  it("keeps short labels and drops anything else", () => {
    expect(parseSignupSource("pricing")).toBe("pricing");
    expect(parseSignupSource(" Pricing_Page ")).toBe("pricing_page");
    expect(parseSignupSource("<script>")).toBeNull();
    expect(parseSignupSource("a".repeat(41))).toBeNull();
    expect(parseSignupSource(null)).toBeNull();
  });
});

describe("authErrorMessage", () => {
  it("maps known codes and never echoes arbitrary text", () => {
    expect(authErrorMessage("link_invalid")).toBe(AUTH_ERROR_MESSAGES.link_invalid);
    expect(authErrorMessage("unavailable")).toBe(AUTH_ERROR_MESSAGES.unavailable);
    expect(authErrorMessage("Your account is locked. Call 555 0100.")).toBe(AUTH_ERROR_MESSAGES.link_invalid);
    expect(authErrorMessage(null)).toBeNull();
  });
});
