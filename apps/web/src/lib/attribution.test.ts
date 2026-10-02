import { describe, expect, it } from "vitest";
import { cleanSignupExtra, readLandingParams, withLandingParams } from "./attribution";

const PREVIEW_ID = "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("readLandingParams", () => {
  it("keeps only the attribution keys, lower cased", () => {
    expect(
      readLandingParams(
        "https://curvi.ai/?utm_source=Reddit&utm_campaign=Label_Test&gclid=abc&email=a%40b.co&source=home&next=/app",
      ),
    ).toEqual({ utm_source: "reddit", utm_campaign: "label_test", source: "home" });
  });

  it("reads relative URLs, URL objects and search params", () => {
    expect(readLandingParams("/pricing?utm_medium=Email")).toEqual({ utm_medium: "email" });
    expect(readLandingParams(new URL("https://curvi.ai/s/abc?s=k7mxq2rtva"))).toEqual({ s: "k7mxq2rtva" });
    expect(readLandingParams(new URLSearchParams({ ref: "AB12CD34" }))).toEqual({ ref: "ab12cd34" });
  });

  it("caps UTM values and drops emails and unknown sources", () => {
    const long = readLandingParams(`/?utm_content=${"x".repeat(150)}`);
    expect(long.utm_content).toHaveLength(100);
    expect(readLandingParams("/?utm_source=seller%40example.com")).toEqual({});
    expect(readLandingParams("/?source=not_a_page")).toEqual({});
    expect(readLandingParams("/?source=tool_checker_google")).toEqual({ source: "tool_checker_google" });
  });

  it("validates claim tokens and preview ids", () => {
    expect(readLandingParams(`/?claim=${"a1".repeat(12)}&preview=${PREVIEW_ID.toUpperCase()}`)).toEqual({
      claim: "a1".repeat(12),
      preview: PREVIEW_ID,
    });
    expect(readLandingParams("/?claim=short&preview=not-a-uuid&ref=a!")).toEqual({});
  });

  it("returns nothing for empty or broken input", () => {
    expect(readLandingParams(null)).toEqual({});
    expect(readLandingParams("")).toEqual({});
    expect(readLandingParams("http://[")).toEqual({});
  });
});

describe("withLandingParams", () => {
  it("appends carried params without overriding the link's own", () => {
    expect(
      withLandingParams("/signup?source=home", { source: "pricing", utm_source: "reddit", ref: "ab12cd34" }),
    ).toBe("/signup?source=home&utm_source=reddit&ref=ab12cd34");
  });

  it("keeps the fragment and drops values that would not pass readLandingParams", () => {
    expect(withLandingParams("/signup#form", { utm_source: "x@y.co", s: "k7mxq2rtva" })).toBe(
      "/signup?s=k7mxq2rtva#form",
    );
    expect(withLandingParams("/signup", {})).toBe("/signup");
  });
});

describe("cleanSignupExtra", () => {
  it("accepts seeded channels only", () => {
    expect(cleanSignupExtra("channel", "Amazon")).toBe("amazon");
    expect(cleanSignupExtra("channel", "myspace")).toBeNull();
  });

  it("keeps a short category key", () => {
    expect(cleanSignupExtra("category", "candles")).toBe("candles");
    expect(cleanSignupExtra("category", "<b>")).toBeNull();
  });
});
