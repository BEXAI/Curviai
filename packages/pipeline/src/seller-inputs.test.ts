import { describe, expect, it } from "vitest";
import type { ProductProfile } from "./schemas";
import {
  ANGLE_ROLES,
  isAngleRole,
  mediaIdsByAngle,
  printableSellerLines,
  profileAngleFor,
  sellerLinesFromText,
  withSellerAngles,
} from "./seller-inputs";

function profile(overrides: Partial<ProductProfile> = {}): ProductProfile {
  return {
    productCount: 1,
    category: "home_kitchen",
    amazonProductTypeGuess: "KITCHEN",
    shopifyTaxonomyGuess: "Home & Garden > Kitchen",
    name: "Mug",
    formFactor: "mug",
    materials: [],
    dominantColors: [],
    dimensions: null,
    preserveText: [],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: [],
    benefits: [],
    targetBuyer: "",
    useContexts: [],
    photographedAngles: ["front"],
    missingAnglesNeeded: ["back", "side"],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
    ...overrides,
  };
}

describe("angle roles", () => {
  it("lists the six roles and recognizes only them", () => {
    expect(ANGLE_ROLES).toEqual(["front", "back", "side", "detail", "in_the_box", "scale"]);
    expect(isAngleRole("in_the_box")).toBe(true);
    expect(isAngleRole("top")).toBe(false);
    expect(isAngleRole(3)).toBe(false);
  });

  it("maps the in the box photo to the analyzer's packaging angle and leaves scale out", () => {
    expect(profileAngleFor("front")).toBe("front");
    expect(profileAngleFor("in_the_box")).toBe("packaging");
    // A scale photo is not an on model photo, so it never becomes in_use.
    expect(profileAngleFor("scale")).toBeNull();
  });

  it("keys media by planner angle, first photo per role wins", () => {
    expect(
      mediaIdsByAngle([
        { mediaId: "a", angle: "front" },
        { mediaId: "b", angle: "front" },
        { mediaId: "c", angle: "in_the_box" },
        { mediaId: "d", angle: "scale" },
        { mediaId: "e" },
      ]),
    ).toEqual({ front: "a", packaging: "c", scale: "d" });
  });

  it("merges seller roles into the profile and clears them from the missing list", () => {
    const merged = withSellerAngles(profile(), ["front", "back", "in_the_box", "scale", null]);
    expect(merged.photographedAngles).toEqual(["front", "back", "packaging"]);
    expect(merged.missingAnglesNeeded).toEqual(["side"]);
    const untouched = profile();
    expect(withSellerAngles(untouched, [])).toBe(untouched);
  });
});

describe("seller lines", () => {
  it("keeps printable lines whole, deduped and capped at five", () => {
    expect(printableSellerLines(["  a  b ", "a b", "", "x".repeat(41), "c", "d", "e", "f", "g"])).toEqual([
      "a b",
      "c",
      "d",
      "e",
      "f",
    ]);
    expect(printableSellerLines(undefined)).toEqual([]);
  });

  it("splits a textarea into lines", () => {
    expect(sellerLinesFromText("Mug\r\n\n  Lid  \nBrush")).toEqual(["Mug", "Lid", "Brush"]);
  });
});
