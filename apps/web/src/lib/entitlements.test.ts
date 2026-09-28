import { describe, expect, it } from "vitest";
import { entitlementsFor, type TierFeature, type TierKey } from "@curvi/pipeline/seed";
import {
  channelAvailability,
  checkBrandKitEntitlement,
  checkChannelEntitlements,
  tierKeyOf,
} from "./entitlements";

const ALL_TIERS: TierKey[] = ["free", "starter", "growth", "pro", "agency"];

describe("tierKeyOf", () => {
  it("maps known plans and reads anything else as free", () => {
    expect(tierKeyOf("growth")).toBe("growth");
    expect(tierKeyOf("enterprise")).toBe("free");
    expect(tierKeyOf(null)).toBe("free");
    expect(tierKeyOf(undefined)).toBe("free");
  });
});

describe("checkChannelEntitlements", () => {
  it("allows image channels on every tier", () => {
    for (const tier of ALL_TIERS) {
      expect(checkChannelEntitlements(["amazon.main", "shopify.product", "meta.feed_1x1"], tier)).toEqual({ ok: true });
    }
  });

  it("refuses video channels for every tier while video is coming soon", () => {
    for (const tier of ALL_TIERS) {
      const check = checkChannelEntitlements(["amazon.main", "video.social_9x16"], tier);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.reason).toBe("feature_unavailable");
        expect(check.message).toContain("coming soon");
      }
    }
  });

  it("asks for an upgrade once video is live but not in the plan", () => {
    const generativeOnly = (feature: TierFeature) => feature === "generativeVideo";
    const starter = checkChannelEntitlements(["video.social_9x16"], "starter", generativeOnly);
    expect(starter.ok).toBe(false);
    if (!starter.ok) {
      expect(starter.reason).toBe("upgrade_required");
      expect(starter.feature).toBe("generativeVideo");
      expect(starter.upgradeTo).toBe("growth");
      expect(starter.message).toContain("Growth plan");
    }
    expect(checkChannelEntitlements(["video.social_9x16"], "growth", generativeOnly)).toEqual({ ok: true });
    const templated = (feature: TierFeature) => feature === "templatedVideo";
    expect(checkChannelEntitlements(["video.amazon_listing"], "starter", templated)).toEqual({ ok: true });
    const free = checkChannelEntitlements(["video.amazon_listing"], "free", templated);
    expect(free.ok).toBe(false);
    if (!free.ok) {
      expect(free.message).toContain("Starter plan");
    }
  });

  it("keeps the refusal copy plain: no arrows, no emojis and no dashes as punctuation", () => {
    const messages = [
      checkChannelEntitlements(["video.social_9x16"], "free"),
      checkChannelEntitlements(["video.social_9x16"], "free", () => true),
      checkBrandKitEntitlement("free", 0, true),
      checkBrandKitEntitlement("starter", 1, true),
    ].flatMap((c) => (c.ok ? [] : [c.message]));
    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message).not.toMatch(/[–—→⇒]|->|=>| - /);
      expect(message).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("channelAvailability (what the new pack form may offer)", () => {
  it("offers image channels on every tier and marks video Coming soon while no video feature is live", () => {
    for (const tier of ALL_TIERS) {
      expect(channelAvailability("amazon.main", tier)).toEqual({ status: "available" });
      expect(channelAvailability("meta.story_9x16", tier)).toEqual({ status: "available" });
      expect(channelAvailability("video.social_9x16", tier)).toEqual({ status: "coming_soon" });
      expect(channelAvailability("video.amazon_listing", tier)).toEqual({ status: "coming_soon" });
    }
  });

  it("agrees with the server check for every channel and tier", () => {
    const channels = ["amazon.main", "shopify.product", "video.social_9x16", "video.amazon_listing"];
    const lives: Array<(feature: TierFeature) => boolean> = [
      () => false,
      () => true,
      (feature) => feature === "templatedVideo",
      (feature) => feature === "generativeVideo",
    ];
    for (const isLive of lives) {
      for (const tier of ALL_TIERS) {
        for (const channel of channels) {
          const offered = channelAvailability(channel, tier, isLive).status === "available";
          expect(offered, `${channel} on ${tier}`).toBe(checkChannelEntitlements([channel], tier, isLive).ok);
        }
      }
    }
  });

  it("names the cheapest plan once video is live but outside the plan", () => {
    const templated = (feature: TierFeature) => feature === "templatedVideo";
    expect(channelAvailability("video.amazon_listing", "free", templated)).toEqual({
      status: "upgrade_required",
      upgradeTo: "starter",
    });
    expect(channelAvailability("video.amazon_listing", "starter", templated)).toEqual({ status: "available" });
  });
});

describe("checkBrandKitEntitlement", () => {
  it("follows the seed's brand kit count per tier", () => {
    for (const tier of ALL_TIERS) {
      const allowed = entitlementsFor(tier).brandKits;
      expect(checkBrandKitEntitlement(tier, 0, true).ok, tier).toBe(allowed > 0);
      expect(checkBrandKitEntitlement(tier, 1, false).ok, tier).toBe(allowed > 0);
      expect(checkBrandKitEntitlement(tier, allowed, true).ok, tier).toBe(false);
    }
  });

  it("asks Free to upgrade to the cheapest plan with a brand kit", () => {
    const check = checkBrandKitEntitlement("free", 0, true);
    expect(check).toEqual({
      ok: false,
      reason: "upgrade_required",
      message: "Brand kits come with the Starter plan and above. Upgrade on the billing page to save one.",
    });
  });
});
