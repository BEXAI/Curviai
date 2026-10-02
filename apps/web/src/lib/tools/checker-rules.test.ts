import { describe, expect, it } from "vitest";
import { getSpec } from "@curvi/specs";
import { mainImageCheckerSpecIds } from "@curvi/pipeline/seed";
import { imageSpecs, specSlug } from "@/components/marketing/spec-slug";
import { amazonMainRules, channelName } from "@/lib/marketing-facts";
import {
  checkerChannelFor,
  checkerChannelForSpec,
  checkerChannels,
  checkerPagePath,
  checkerRulesFromSpec,
  defaultCheckerChannel,
} from "./checker-rules";

// P18-10: every checker threshold comes from the registry (CLAUDE.md rule
// 2). These tests compare against the registry itself, never a literal.

function percent(share: number): number {
  return Math.round(share * 1000) / 10;
}

describe("checker channels", () => {
  it("offer only seeded specs, verified in the registry, Amazon first", () => {
    const channels = checkerChannels();
    expect(channels[0]?.specId).toBe("amazon.main");
    for (const channel of channels) {
      expect(mainImageCheckerSpecIds as readonly string[]).toContain(channel.specId);
      expect(getSpec(channel.specId).verified).toBe(true);
    }
    expect(new Set(channels.map((channel) => channel.key)).size).toBe(channels.length);
  });

  it("offer Google Merchant now and leave out unverified specs", () => {
    const ids = checkerChannels().map((channel) => channel.specId);
    expect(ids).toContain("google.merchant.main");
    for (const id of mainImageCheckerSpecIds) {
      expect(ids.includes(id), id).toBe(getSpec(id).verified);
    }
  });

  it("read every threshold from the channel's spec", () => {
    for (const channel of checkerChannels()) {
      const spec = getSpec(channel.specId);
      expect(channel.rules.minLongSide).toBe(spec.minLongSide ?? 0);
      expect(channel.rules.minWidth).toBe(spec.minWidth);
      expect(channel.rules.minHeight).toBe(spec.minHeight);
      expect(channel.rules.fillMinPercent).toBe(spec.fill ? percent(spec.fill.min) : null);
      expect(channel.rules.fillMaxPercent).toBe(spec.fill ? percent(spec.fill.max) : null);
      expect(channel.name).toBe(channelName(channel.key));
    }
  });

  it("match the Amazon rules the rest of the site states", () => {
    const amazon = defaultCheckerChannel();
    const rules = amazonMainRules();
    expect(amazon.rules).toMatchObject({
      minLongSide: rules.minLongSide,
      fillMinPercent: rules.fillMinPercent,
      fillMaxPercent: rules.fillMaxPercent,
      background: "white",
    });
  });

  it("measure Google Merchant against its white or transparent rule and its fill range", () => {
    const google = checkerChannelFor("google");
    const spec = getSpec("google.merchant.main");
    expect(google.specId).toBe("google.merchant.main");
    expect(google.rules.background).toBe("white_or_transparent");
    expect(google.rules.fillMinPercent).toBe(percent(spec.fill?.min ?? 0));
    expect(google.rules.fillMaxPercent).toBe(percent(spec.fill?.max ?? 0));
  });

  it("link each channel to its requirements page, which exists", () => {
    const slugs = imageSpecs().map((spec) => specSlug(spec.id));
    for (const channel of checkerChannels()) {
      expect(channel.requirementsPath).toBe(`/channels/${specSlug(channel.specId)}/image-requirements`);
      expect(slugs).toContain(specSlug(channel.specId));
    }
  });
});

describe("the ?channel= preset", () => {
  it("picks a channel by key, in any case", () => {
    expect(checkerChannelFor("google").key).toBe("google");
    expect(checkerChannelFor(" GOOGLE ").key).toBe("google");
  });

  it("falls back to Amazon for an unknown, unverified or missing value", () => {
    for (const raw of ["", "nope", "walmart.main", undefined, null, 7, "amazon"]) {
      expect(checkerChannelFor(raw).key, String(raw)).toBe("amazon");
    }
    if (!getSpec("walmart.main").verified) {
      expect(checkerChannelFor("walmart").key).toBe("amazon");
    }
  });

  it("builds the checker link for a channel", () => {
    expect(checkerPagePath("google")).toBe("/tools/main-image-checker?channel=google");
  });

  it("finds the checker channel for a requirements page's spec", () => {
    expect(checkerChannelForSpec("amazon.main")?.key).toBe("amazon");
    expect(checkerChannelForSpec("google.merchant.main")?.key).toBe("google");
    expect(checkerChannelForSpec("amazon.secondary")).toBeUndefined();
    expect(checkerChannelForSpec("meta.feed_1x1")).toBeUndefined();
  });
});

describe("rules from a spec", () => {
  it("returns nothing for an unverified spec", () => {
    expect(checkerRulesFromSpec({ ...getSpec("google.merchant.main"), verified: false })).toBeNull();
  });

  it("returns nothing for a spec with no white background rule", () => {
    expect(checkerRulesFromSpec(getSpec("shopify.product"))).toBeNull();
  });

  it("covers a verified spec with no fill range and no minimum size, as Walmart and TikTok Shop are today", () => {
    for (const id of ["walmart.main", "tiktokshop.main"]) {
      const spec = getSpec(id);
      const rules = checkerRulesFromSpec({ ...spec, verified: true });
      expect(rules, id).not.toBeNull();
      expect(rules?.background).toBe("white");
      expect(rules?.fillMinPercent).toBe(spec.fill ? percent(spec.fill.min) : null);
      expect(rules?.minLongSide).toBe(spec.minLongSide ?? 0);
    }
  });
});
