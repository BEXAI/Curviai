import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planShots, type ProductProfile } from "@curvi/pipeline";
import { creditCosts, rolloverPolicy, tierByKey, tiers, topUps } from "@curvi/pipeline/seed";
import { getSpec, listSpecs } from "@curvi/specs";
import { estimatePackCredits } from "./pack-estimate";
import {
  CHANNEL_FAMILIES,
  FEATURES,
  TYPICAL_PACK_CHANNELS,
  amazonMainRules,
  annualSavingsPercentRange,
  annualSavingsPhrase,
  comingSoonChannelNames,
  familyOf,
  formatCredits,
  freeCredits,
  freeCreditsReach,
  joinList,
  liveChannelNames,
  packsForCredits,
  paidTiers,
  registryImageFamilies,
  rolloverSentence,
  tierDisplayName,
  topUpMonths,
  typicalPackCredits,
  unqualifiedClaims,
} from "./marketing-facts";

describe("typical pack size", () => {
  it("is the new pack form's default estimate, from the seed credit costs", () => {
    const estimate = estimatePackCredits([...TYPICAL_PACK_CHANNELS], "listing", "free");
    expect(typicalPackCredits()).toBe(estimate.total);
    const sum = estimate.lines.reduce((total, line) => total + line.credits, 0);
    expect(typicalPackCredits()).toBe(Math.ceil(sum));
  });

  it("counts still images only, since video does not ship yet", () => {
    const labels = estimatePackCredits([...TYPICAL_PACK_CHANNELS], "listing", "free").lines.map((line) => line.label);
    expect(labels.some((label) => /video|hero loop|clip|UGC/i.test(label))).toBe(false);
  });

  it("is far below the old 40 to 60 credit claim", () => {
    // A pack of stills is a handful of deterministic assets plus a few
    // generative scenes; with the seed costs that lands around 10 credits.
    expect(typicalPackCredits()).toBeLessThan(40);
    expect(typicalPackCredits()).toBeGreaterThan(creditCosts.generativeStill);
  });

  it("matches the channels the new pack form preselects", () => {
    const formPath = fileURLToPath(new URL("../components/app/new-pack-form.tsx", import.meta.url));
    const source = readFileSync(formPath, "utf8");
    const match = source.match(/DEFAULT_CHANNELS\s*=\s*\[([^\]]*)\]/);
    expect(match, "DEFAULT_CHANNELS moved; update TYPICAL_PACK_CHANNELS and this test").not.toBeNull();
    const formChannels = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...TYPICAL_PACK_CHANNELS]).toEqual(formChannels);
  });

  it("turns a credit allowance into whole packs", () => {
    for (const tier of paidTiers()) {
      expect(packsForCredits(tier.creditsPerMonth)).toBe(Math.floor(tier.creditsPerMonth / typicalPackCredits()));
    }
    expect(packsForCredits(0)).toBe(0);
  });
});

describe("free credits", () => {
  it("come from the free tier seed", () => {
    expect(freeCredits()).toBe(tierByKey("free").creditsOnce);
  });

  it("describe what they cover from the seed numbers", () => {
    const packs = packsForCredits(freeCredits());
    const reach = freeCreditsReach();
    if (packs >= 2) {
      expect(reach).toContain(`${packs} full listing packs`);
    } else if (packs === 1) {
      expect(reach).toContain("a full listing pack");
    } else {
      expect(reach).not.toContain("pack");
    }
  });
});

describe("annual savings", () => {
  it("never states more than the smallest real saving in the tier seed", () => {
    const real = paidTiers().map((tier) => ((tier.monthlyUsd - tier.annualUsdPerMonth) / tier.monthlyUsd) * 100);
    const { min, max } = annualSavingsPercentRange();
    expect(min).toBeLessThanOrEqual(Math.min(...real));
    expect(max).toBeLessThanOrEqual(Math.max(...real));
    expect(Math.min(...real) - min).toBeLessThan(1);
  });

  it("reads as a plain range", () => {
    const { min, max } = annualSavingsPercentRange();
    expect(annualSavingsPhrase()).toBe(min === max ? `${min} percent` : `${min} to ${max} percent`);
  });
});

describe("credit policy sentences", () => {
  it("state the seed rollover policy and top up lifetime", () => {
    expect(topUpMonths()).toBe(Math.min(...topUps.map((topUp) => topUp.expiresMonths)));
    const sentence = rolloverSentence();
    if (rolloverPolicy.capFactorOfMonthlyAllowance === 1) {
      expect(sentence).toContain("up to one month of your allowance");
    }
    if (rolloverPolicy.cycles === 1) {
      expect(sentence).toContain("the next billing cycle");
    }
  });

  it("formats credit amounts", () => {
    expect(formatCredits(0.5)).toBe("0.5 credit");
    expect(formatCredits(1)).toBe("1 credit");
    expect(formatCredits(3)).toBe("3 credits");
  });

  it("names tiers for people, not keys", () => {
    expect(tiers.map((tier) => tierDisplayName(tier.key))).toEqual(["Free", "Starter", "Growth", "Pro", "Agency"]);
  });
});

describe("amazon main rules", () => {
  it("come from the spec registry", () => {
    const spec = getSpec("amazon.main");
    const rules = amazonMainRules();
    expect(rules.fillMinPercent).toBeCloseTo((spec.fill?.min ?? 0) * 100);
    expect(rules.fillMaxPercent).toBeCloseTo((spec.fill?.max ?? 0) * 100);
    expect(rules.minLongSide).toBe(spec.minLongSide);
    expect(rules.rgb).toEqual(spec.background?.rgb);
  });
});

function profile(): ProductProfile {
  return {
    productCount: 1,
    category: "home_kitchen",
    amazonProductTypeGuess: "KITCHEN",
    shopifyTaxonomyGuess: "Home & Garden > Kitchen",
    name: "Ceramic pour over mug",
    formFactor: "mug",
    materials: ["ceramic"],
    dominantColors: [{ name: "cream", hex: "#F2E8D8", coveragePct: 70 }],
    dimensions: { value: "10 x 10 x 12 cm", source: "user" },
    preserveText: [],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: ["pour over rim"],
    benefits: ["keeps coffee hot", "easy grip handle"],
    targetBuyer: "home coffee drinkers",
    useContexts: ["morning kitchen counter", "office desk"],
    photographedAngles: ["front", "45", "back", "top"],
    missingAnglesNeeded: [],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
  };
}

describe("channel availability", () => {
  it("covers every image channel family in the spec registry", () => {
    expect([...registryImageFamilies()].sort()).toEqual(CHANNEL_FAMILIES.map((channel) => channel.family).sort());
  });

  it("matches what the pack planner delivers", () => {
    // Select every channel in the registry on the richest tier; a channel
    // family is live only if the deterministic planner makes files for it.
    const list = planShots(profile(), {
      channels: listSpecs().map((spec) => spec.id),
      tier: "agency",
      creditBudget: 10_000,
    });
    const planned = new Set(list.shots.flatMap((shot) => shot.channels.map(familyOf)));
    for (const channel of CHANNEL_FAMILIES) {
      if (channel.status === "live") {
        expect(planned.has(channel.family), `${channel.name} is marked live but no shot targets it`).toBe(true);
      } else {
        expect(
          planned.has(channel.family),
          `${channel.name} now gets files; mark it live in CHANNEL_FAMILIES`,
        ).toBe(false);
      }
    }
  });

  it("lists live and coming soon channels without overlap", () => {
    const live = liveChannelNames();
    const soon = comingSoonChannelNames();
    expect(live.length).toBeGreaterThan(0);
    expect(live.filter((name) => soon.includes(name))).toEqual([]);
  });
});

describe("unqualifiedClaims", () => {
  it("flags features that do not run unless the sentence says coming soon", () => {
    expect(unqualifiedClaims("Publish straight to Shopify or download the pack.")).toHaveLength(1);
    expect(unqualifiedClaims("Publishing straight to Shopify is coming soon.")).toEqual([]);
    expect(unqualifiedClaims("Every Monday, new variants land in your library.")).toHaveLength(1);
    expect(unqualifiedClaims("A short looping video for the gallery.")).toHaveLength(1);
    expect(unqualifiedClaims("Upload one photo or paste a product URL.")).toHaveLength(1);
    expect(unqualifiedClaims("Checks background, fill and text policy per channel.")).toHaveLength(1);
  });

  it("flags channels that get no files yet", () => {
    for (const name of comingSoonChannelNames()) {
      expect(unqualifiedClaims(`Sized for ${name}.`), name).toHaveLength(1);
    }
    for (const name of liveChannelNames()) {
      expect(unqualifiedClaims(`Sized for ${name}.`), name).toEqual([]);
    }
  });

  it("passes copy about live features", () => {
    expect(
      unqualifiedClaims(
        "Your real product pixels are never regenerated. Labels, logos and textures match your photo exactly.",
      ),
    ).toEqual([]);
  });

  it("gives every coming soon feature a pattern to police", () => {
    for (const [key, feature] of Object.entries(FEATURES)) {
      if (feature.status === "coming_soon") {
        expect("mentions" in feature && feature.mentions instanceof RegExp, key).toBe(true);
      }
    }
  });
});

describe("joinList", () => {
  it("joins with commas and a final and", () => {
    expect(joinList([])).toBe("");
    expect(joinList(["Amazon"])).toBe("Amazon");
    expect(joinList(["Amazon", "Shopify"])).toBe("Amazon and Shopify");
    expect(joinList(["Amazon", "Shopify", "Meta"])).toBe("Amazon, Shopify and Meta");
  });
});
