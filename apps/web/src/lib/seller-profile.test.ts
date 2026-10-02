import { describe, expect, it } from "vitest";
import { channelChoices, sellerCategories } from "@curvi/pipeline/seed";
import {
  answerSaysSomething,
  channelChoiceForSpec,
  cleanSellerAnswer,
  profileChannelSpecs,
  readSellerProfile,
  sellerProfileJson,
} from "./seller-profile";
import { profileHintFrom, signupCallbackUrl } from "./signup-callback";
import { welcomePath } from "./verification";

// P18-20: the first run answers come only from the seed, prefill the
// channels of the first pack, and travel from a category or channel page
// through signup to /welcome.

describe("seller answer", () => {
  it("keeps seeded values only, channels in seed order", () => {
    expect(cleanSellerAnswer({ category: "candles", channels: ["tiktokshop", "amazon", "amazon"] })).toEqual({
      category: "candles",
      channels: ["amazon", "tiktokshop"],
    });
    expect(cleanSellerAnswer({})).toEqual({ category: null, channels: [] });
    expect(cleanSellerAnswer({ category: null })).toEqual({ category: null, channels: [] });
  });

  it("refuses the whole answer when any value is unknown", () => {
    expect(cleanSellerAnswer({ category: "Candles", channels: [] })).toBeNull();
    expect(cleanSellerAnswer({ category: "candles", channels: ["amazon", "myspace"] })).toBeNull();
    expect(cleanSellerAnswer({ category: "candles", channels: "amazon" })).toBeNull();
    expect(cleanSellerAnswer({ channels: new Array(50).fill("amazon") })).toBeNull();
    expect(cleanSellerAnswer(null)).toBeNull();
    expect(cleanSellerAnswer(["candles"])).toBeNull();
  });

  it("stores a small object and reads it back, dropping values the seed no longer has", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    const json = sellerProfileJson({ category: "candles", channels: ["amazon", "shopify"] }, now);
    expect(json).toEqual({ category: "candles", channels: ["amazon", "shopify"], answeredAt: "2026-10-01T12:00:00.000Z" });
    expect(JSON.stringify(json).length).toBeLessThan(1024);
    expect(sellerProfileJson({ category: null, channels: [] }, now)).toEqual({ answeredAt: "2026-10-01T12:00:00.000Z" });
    expect(readSellerProfile(json)).toEqual({ category: "candles", channels: ["amazon", "shopify"], answeredAt: json.answeredAt });
    expect(readSellerProfile({ category: "gone", channels: ["amazon", "gone"] })).toEqual({
      category: null,
      channels: ["amazon"],
      answeredAt: null,
    });
    expect(readSellerProfile(null)).toBeNull();
    expect(readSellerProfile("candles")).toBeNull();
    expect(answerSaysSomething({ category: null, channels: [] })).toBe(false);
    expect(answerSaysSomething({ category: "pet", channels: [] })).toBe(true);
  });
});

describe("first pack channels from the profile", () => {
  it("are the seeded specs of each answered channel", () => {
    expect(profileChannelSpecs({ channels: ["amazon", "shopify"] })).toEqual([
      "amazon.main",
      "amazon.secondary",
      "shopify.product",
    ]);
    expect(profileChannelSpecs({ channels: [] })).toEqual([]);
    expect(profileChannelSpecs(null)).toEqual([]);
  });

  it("map every channel choice spec back to its choice", () => {
    for (const choice of channelChoices) {
      for (const spec of choice.specs) {
        expect(channelChoiceForSpec(spec)).toBe(choice.value);
      }
    }
    expect(channelChoiceForSpec("meta.feed_1x1")).toBeNull();
  });
});

describe("welcome answers through signup", () => {
  it("carry a seeded category and channel from the signup page to the callback and on to /welcome", () => {
    const hint = profileHintFrom(new URLSearchParams("source=category&category=beauty&channel=walmart"));
    expect(hint).toEqual({ category: "beauty", channel: "walmart" });
    const url = new URL(signupCallbackUrl("https://curvi.ai", { next: "/app", profile: hint }));
    expect(url.searchParams.get("category")).toBe("beauty");
    expect(url.searchParams.get("channel")).toBe("walmart");
    expect(welcomePath("/app", profileHintFrom(url.searchParams))).toBe("/welcome?category=beauty&channel=walmart");
  });

  it("drop a category page slug that is not a seller category, and anything unseeded", () => {
    expect(profileHintFrom(new URLSearchParams("category=sports&channel=myspace"))).toEqual({});
    expect(welcomePath("/app", {})).toBe("/welcome");
    expect(welcomePath("/app/billing", { category: "pet" })).toBe("/welcome?next=%2Fapp%2Fbilling&category=pet");
  });

  it("covers the category pages whose slug is a seller category", () => {
    const keys = sellerCategories.map((c) => c.key);
    for (const slug of ["beauty", "food", "pet", "home", "apparel", "jewelry", "electronics"]) {
      expect(keys, slug).toContain(slug);
    }
  });
});
