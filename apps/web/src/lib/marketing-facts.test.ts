import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEMPLATE_STILL_TYPES, type ProductProfile, type Shot } from "@curvi/pipeline";
import {
  creditCosts,
  creditExpiry,
  isShotMethodDeliverable,
  tierByKey,
  tiers,
  undeliverableShotMethods,
  type TierKey,
} from "@curvi/pipeline/seed";
import { getSpec } from "@curvi/specs";
import { deterministicPlan, shotTargetSpecs } from "@curvi/trigger/runner";
// The worker's live shot types are not a package export; the generator
// rejects any other deterministic type, so the drift test reads the same set.
import { DETERMINISTIC_LIVE_TYPES } from "../../../../trigger/src/live-deterministic";
import { ESTIMATE_REFERENCE_PRODUCT, estimatePackCredits } from "./pack-estimate";
import {
  CHANNEL_FAMILIES,
  CHANNEL_SPECS,
  FEATURES,
  TYPICAL_PACK_CHANNELS,
  amazonMainRules,
  annualSavingsPercentRange,
  annualSavingsPhrase,
  channelName,
  comingSoonChannelNames,
  comingSoonFileNames,
  comingSoonFilesSentence,
  familyOf,
  formatCredits,
  freeCredits,
  freeCreditsReach,
  isSpecLive,
  joinList,
  liveChannelNames,
  liveChannelShortList,
  liveFilesPhrase,
  packsForCredits,
  paidTiers,
  registryImageSpecIds,
  specAvailability,
  specFilesName,
  specFilesNameFor,
  tierDisplayName,
  typicalPackCredits,
  unqualifiedClaims,
  CREDIT_TERMS_SENTENCE,
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
  it("say credits stay while the account is open, as the seed's creditExpiry says (P20-05)", () => {
    expect(creditExpiry.kind).toBe("none");
    expect(CREDIT_TERMS_SENTENCE).toBe(
      "Credits you do not use stay in your balance from one month to the next, for as long as your account is open.",
    );
    // No cap, no lifetime, and never the word PHASE_18's email lint bans
    // next to "credits".
    expect(CREDIT_TERMS_SENTENCE).not.toMatch(/carr(y|ies) over|up to|cap|expire|\d+ months/i);
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

/**
 * The products the drift guard plans for. The reference product is the one
 * the pack estimate, and so the credits the server reserves, is built around
 * (lib/pack-estimate.ts). The others photograph more angles or confirm their
 * measurements, so their full plan costs more than that reserve and the
 * worker's budget trim has to choose; a live spec must still get its file.
 */
function withProfile(overrides: Partial<ProductProfile>): ProductProfile {
  return { ...ESTIMATE_REFERENCE_PRODUCT, name: "Ceramic pour over mug", ...overrides };
}

const DRIFT_PROFILES: Array<{ label: string; profile: ProductProfile }> = [
  { label: "three angles, size not confirmed", profile: withProfile({}) },
  {
    label: "four angles, size the seller confirmed",
    profile: withProfile({
      photographedAngles: ["front", "45", "back", "top"],
      dimensions: { value: "10 x 10 x 12 cm", source: "user" },
    }),
  },
  {
    label: "every angle, size from the packaging, four use contexts",
    profile: withProfile({
      photographedAngles: ["front", "45", "side", "back", "top", "bottom", "detail", "in_use", "packaging"],
      dimensions: { value: "10 x 10 x 12 cm", source: "packaging" },
      benefits: ["keeps coffee hot", "easy grip handle", "fits any dripper", "dishwasher safe", "stacks neatly"],
      useContexts: ["morning kitchen counter", "office desk", "camping trip", "gift box"],
    }),
  },
  {
    label: "front photo only",
    profile: withProfile({ photographedAngles: ["front"], benefits: [], useContexts: [] }),
  },
];

const COMPOSITE_METHODS = new Set<Shot["method"]>(["composite_generate", "edit_generate"]);

/** True when the live generator renders this shot (live-runtime generateLive). */
function liveGeneratorMakes(shot: Shot): boolean {
  switch (shot.method) {
    case "deterministic":
      return DETERMINISTIC_LIVE_TYPES.has(shot.type);
    case "template":
      return TEMPLATE_STILL_TYPES.has(shot.type);
    default:
      return COMPOSITE_METHODS.has(shot.method);
  }
}

/**
 * The channel specs a Listing Mode pack ships files for, the way the worker
 * builds it: the runner's deterministicPlan (the planner every LLM plan must
 * match spec for spec, fitted to the selection and trimmed to the budget),
 * the production exclusion of methods that are not live, and one file per
 * spec a surviving shot targets. The budget defaults to the credits the
 * server reserves for the selection.
 */
function deliveredSpecs(
  channels: string[],
  tier: TierKey,
  budget?: number,
  profile: ProductProfile = DRIFT_PROFILES[0].profile,
): Set<string> {
  const creditBudget = budget ?? estimatePackCredits(channels, "listing", tier).total;
  const primaryMediaId = "media_front";
  const excludeMethods = [...undeliverableShotMethods];
  const plan = deterministicPlan(
    profile,
    { channels, tier, creditBudget, primaryMediaId, undeliverableMethods: excludeMethods },
    { channels, mode: "listing", budget: creditBudget, profile, primaryMediaId, excludeMethods },
  );
  const made = plan.shots.filter((shot) => isShotMethodDeliverable(shot.method) && liveGeneratorMakes(shot));
  return new Set(made.flatMap((shot) => shotTargetSpecs(shot)));
}

describe("channel availability", () => {
  const imageSpecIds = registryImageSpecIds();

  it("lists every image spec in the registry once", () => {
    const listed = CHANNEL_SPECS.map((spec) => spec.specId);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...imageSpecIds].sort());
  });

  it("names every channel family in the registry", () => {
    const families = new Set(imageSpecIds.map(familyOf));
    expect([...families].sort()).toEqual(CHANNEL_FAMILIES.map((channel) => channel.family).sort());
    for (const family of families) {
      expect(channelName(family), family).not.toBe(family);
    }
  });

  it("treats a spec it does not list as coming soon", () => {
    expect(specAvailability("newmarket.main")).toBe("coming_soon");
    expect(isSpecLive("amazon.main")).toBe(true);
  });

  const liveSpecIds = CHANNEL_SPECS.filter((entry) => entry.status === "live").map((entry) => entry.specId);

  for (const tier of tiers.map((t) => t.key)) {
    it(`marks a spec live only when a pack on the ${tier} plan that picks just that spec gets its file`, () => {
      for (const { label, profile } of DRIFT_PROFILES) {
        const missing = liveSpecIds.filter((specId) => !deliveredSpecs([specId], tier, undefined, profile).has(specId));
        expect(missing, `${label}: marked live in CHANNEL_SPECS but a pack that picks them gets no file`).toEqual([]);
      }
    });
  }

  it("delivers every live spec when every channel is picked together", () => {
    for (const { label, profile } of DRIFT_PROFILES) {
      const delivered = deliveredSpecs([...imageSpecIds], "free", undefined, profile);
      const missing = liveSpecIds.filter((specId) => !delivered.has(specId));
      expect(missing, `${label}: marked live in CHANNEL_SPECS but a full pack gets no file`).toEqual([]);
    }
  });

  it("delivers every spec the new pack form preselects, for every product", () => {
    for (const { label, profile } of DRIFT_PROFILES) {
      const delivered = deliveredSpecs([...TYPICAL_PACK_CHANNELS], "free", undefined, profile);
      for (const specId of TYPICAL_PACK_CHANNELS) {
        expect(delivered.has(specId), `${label}: ${specId}`).toBe(true);
        expect(isSpecLive(specId), specId).toBe(true);
      }
    }
  });

  it("gives a Meta feed square pick its file at the reserved budget, alone or in the default pack", () => {
    for (const { label, profile } of DRIFT_PROFILES) {
      for (const channels of [["meta.feed_1x1"], [...TYPICAL_PACK_CHANNELS]]) {
        const delivered = deliveredSpecs(channels, "free", undefined, profile);
        expect(delivered.has("meta.feed_1x1"), `${label}: ${channels.join(",")}`).toBe(true);
      }
    }
  });

  it("keeps a spec coming soon only while no pack gets its file", () => {
    // The richest plans with room to spare: any file at all means it ships.
    const shipping = new Set<string>();
    for (const { profile } of DRIFT_PROFILES) {
      const all = deliveredSpecs([...imageSpecIds], "agency", 10_000, profile);
      for (const entry of CHANNEL_SPECS.filter((spec) => spec.status === "coming_soon")) {
        if (all.has(entry.specId) || deliveredSpecs([entry.specId], "agency", 10_000, profile).has(entry.specId)) {
          shipping.add(entry.specId);
        }
      }
    }
    expect([...shipping], "these now get files; mark them live in CHANNEL_SPECS").toEqual([]);
  });

  it("gives every coming soon spec in a live channel its own pattern to police", () => {
    for (const spec of CHANNEL_SPECS.filter((entry) => entry.status === "coming_soon")) {
      const family = CHANNEL_FAMILIES.find((channel) => channel.family === familyOf(spec.specId));
      if (family?.status === "live") {
        expect(spec.mentions, spec.specId).toBeInstanceOf(RegExp);
        expect(spec.mentions?.test(specFilesName(spec)), spec.specId).toBe(true);
      }
    }
  });

  it("derives channel status from its specs", () => {
    for (const channel of CHANNEL_FAMILIES) {
      const live = CHANNEL_SPECS.some((spec) => familyOf(spec.specId) === channel.family && spec.status === "live");
      expect(channel.status, channel.family).toBe(live ? "live" : "coming_soon");
    }
  });

  it("lists live and coming soon channels without overlap", () => {
    const live = liveChannelNames();
    const soon = comingSoonChannelNames();
    expect(live.length).toBeGreaterThan(0);
    expect(live.filter((name) => soon.includes(name))).toEqual([]);
  });

  it("names live files by channel and coming soon files in full", () => {
    const phrase = liveFilesPhrase();
    for (const channel of CHANNEL_FAMILIES.filter((entry) => entry.status === "live")) {
      expect(phrase, channel.name).toContain(channel.name);
    }
    expect(unqualifiedClaims(`Curvi makes ${phrase}.`)).toEqual([]);
    const soon = comingSoonFileNames();
    expect(soon).toEqual(
      CHANNEL_SPECS.filter((spec) => spec.status === "coming_soon").map((spec) => specFilesName(spec)),
    );
    const sentence = comingSoonFilesSentence(["video formats"]);
    expect(sentence).toMatch(/are coming soon\.$/);
    expect(sentence).toContain("video formats");
    expect(unqualifiedClaims(sentence)).toEqual([]);
  });

  it("writes nothing when no files are on the way", () => {
    if (comingSoonFileNames().length === 0) {
      expect(comingSoonFilesSentence()).toBe("");
    } else {
      expect(comingSoonFilesSentence()).toContain(joinList(comingSoonFileNames()));
    }
  });

  it("shortens long channel lists for headlines", () => {
    const names = liveChannelNames();
    const short = liveChannelShortList(2);
    expect(short).toContain(names[0]);
    expect(short).toBe(names.length > 2 ? `${names[0]}, ${names[1]} and more` : joinList(names));
    expect(liveChannelShortList(names.length)).toBe(joinList(names));
  });

  it("names files for a spec id", () => {
    expect(specFilesNameFor("amazon.main")).toBe("Amazon main images");
    expect(specFilesNameFor("newmarket.main")).toBeUndefined();
  });
});

describe("unqualifiedClaims", () => {
  it("flags features that do not run unless the sentence says coming soon", () => {
    expect(unqualifiedClaims("Publish straight to Shopify or download the pack.")).toHaveLength(1);
    expect(unqualifiedClaims("Publishing straight to Shopify is coming soon.")).toEqual([]);
    expect(unqualifiedClaims("Every Monday, new variants land in your library.")).toHaveLength(1);
    expect(unqualifiedClaims("A short looping video for the gallery.")).toHaveLength(1);
    expect(unqualifiedClaims("Upload one photo and get auto packs for every new product.")).toHaveLength(1);
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

  it("flags channel files that are not made yet, even in a live channel", () => {
    for (const spec of CHANNEL_SPECS) {
      const claim = `Curvi makes ${specFilesName(spec)}.`;
      if (spec.status === "coming_soon") {
        expect(unqualifiedClaims(claim), spec.specId).toHaveLength(1);
        expect(unqualifiedClaims(`${specFilesName(spec)} are coming soon.`), spec.specId).toEqual([]);
      } else {
        expect(unqualifiedClaims(claim), spec.specId).toEqual([]);
      }
    }
  });

  it("passes copy about live features", () => {
    expect(
      unqualifiedClaims(
        "Never redrawn by AI. Curvi cuts out your real product and builds the scene around it, then measures the color inside your product on every file.",
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
