import { describe, expect, it } from "vitest";
import type { TierFeature, TierKey } from "@curvi/pipeline/seed";
import { checkChannelEntitlements, tierKeyOf } from "./entitlements";

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
    ].flatMap((c) => (c.ok ? [] : [c.message]));
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).not.toMatch(/[–—→⇒]|->|=>| - /);
      expect(message).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
