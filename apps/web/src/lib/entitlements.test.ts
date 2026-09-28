import { describe, expect, it } from "vitest";
import { entitlementsFor, isFeatureLive, type TierFeature, type TierKey } from "@curvi/pipeline/seed";
import {
  channelAvailability,
  checkBrandKitEntitlement,
  checkChannelEntitlements,
  tierKeyOf,
} from "./entitlements";
import { CHANNEL_SPECS, isSpecLive, registryImageSpecIds } from "./marketing-facts";

const ALL_TIERS: TierKey[] = ["free", "starter", "growth", "pro", "agency"];
/** A registry spec a pack makes no files for yet (marketing-facts CHANNEL_SPECS). */
const UNSHIPPED_SPEC = "amazon.aplus.premium_full";

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

  it("refuses an image spec a pack makes no files for yet, on every plan", () => {
    expect(isSpecLive(UNSHIPPED_SPEC)).toBe(false);
    for (const tier of ALL_TIERS) {
      const check = checkChannelEntitlements(["amazon.main", UNSHIPPED_SPEC], tier, () => true);
      expect(check).toEqual({
        ok: false,
        reason: "feature_unavailable",
        feature: null,
        spec: UNSHIPPED_SPEC,
        upgradeTo: null,
        message:
          "Amazon A plus premium modules are coming soon, so they cannot be added to a pack yet. Remove them to start this pack.",
      });
    }
  });

  it("accepts every image spec marked live and refuses every other registry image spec", () => {
    const live = CHANNEL_SPECS.filter((spec) => spec.status === "live").map((spec) => spec.specId);
    expect(live.length).toBeGreaterThan(0);
    expect(checkChannelEntitlements(live, "free")).toEqual({ ok: true });
    for (const spec of registryImageSpecIds().filter((id) => !isSpecLive(id))) {
      expect(checkChannelEntitlements([spec], "agency").ok, spec).toBe(false);
    }
  });

  it("judges image specs through the specLive check it is given", () => {
    const feedPulled = (spec: string) => spec !== "meta.feed_1x1";
    const refused = checkChannelEntitlements(["meta.feed_1x1"], "pro", isFeatureLive, feedPulled);
    expect(refused).toMatchObject({ ok: false, reason: "feature_unavailable", spec: "meta.feed_1x1" });
    expect(checkChannelEntitlements([UNSHIPPED_SPEC], "pro", isFeatureLive, () => true)).toEqual({ ok: true });
  });

  it("names no files for a spec it has no name for", () => {
    const check = checkChannelEntitlements(["acme.new_spec"], "pro", isFeatureLive, () => false);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.message).toBe(
        "One of the channels you picked is coming soon, so it cannot be added to a pack yet. Remove it to start this pack.",
      );
    }
  });

  it("keeps the refusal copy plain: no arrows, no emojis and no dashes as punctuation", () => {
    const messages = [
      checkChannelEntitlements(["video.social_9x16"], "free"),
      checkChannelEntitlements(["video.social_9x16"], "free", () => true),
      checkChannelEntitlements([UNSHIPPED_SPEC], "free"),
      checkChannelEntitlements(["acme.new_spec"], "free", () => true, () => false),
      checkBrandKitEntitlement("free", 0, true),
      checkBrandKitEntitlement("starter", 1, true),
    ].flatMap((c) => (c.ok ? [] : [c.message]));
    expect(messages).toHaveLength(6);
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

  it("marks an image spec that does not ship yet Coming soon on every plan, even with every feature live", () => {
    for (const tier of ALL_TIERS) {
      expect(channelAvailability(UNSHIPPED_SPEC, tier)).toEqual({ status: "coming_soon" });
      expect(channelAvailability(UNSHIPPED_SPEC, tier, () => true)).toEqual({ status: "coming_soon" });
    }
  });

  it("agrees with the server check for every channel and tier", () => {
    const channels = ["amazon.main", "shopify.product", UNSHIPPED_SPEC, "video.social_9x16", "video.amazon_listing"];
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
