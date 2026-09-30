/**
 * A+ module copy (docs/phases/PHASE_16.md workstream 2): the claims guard,
 * rule 9 lint on generated slots, the copy step's fallbacks, the module cap,
 * and the planner's module rules (results dropped on a claim flag, the
 * endorsement only from the seller's own lines).
 */
import { describe, expect, it } from "vitest";
import {
  APLUS_CLAIMS_FLAG_REASON,
  APLUS_COPY_SHORT_REASON,
  APLUS_MODULE_CAP_REASON,
  AplusCopyResult,
  GENERATED_APLUS_MODULES,
  NO_ENDORSEMENT_REASON,
  applyAplusCopy,
  aplusCopyRequest,
  capAplusModules,
  claimProblem,
  figuresIn,
  guardedLine,
  moduleSkipReason,
  needsAplusCopy,
} from "./aplus-copy";
import { rule9Problems } from "./copy-lint";
import { planShots, type PlanOptions } from "./planner/deterministic";
import { APLUS_MODULE_SHOT_TYPES, LlmShotList, type ProductProfile, type Shot } from "./schemas";
import { aplusCopy, aplusModules, creditCosts, packBundles } from "./seed";
import { strictToolSchema } from "./schemas";

function profile(overrides: Partial<ProductProfile> = {}): ProductProfile {
  return {
    productCount: 1,
    category: "home_kitchen",
    amazonProductTypeGuess: "DRINKING_CUP",
    shopifyTaxonomyGuess: "Home & Garden > Kitchen",
    name: "Steel water bottle",
    formFactor: "bottle",
    materials: ["stainless steel", "bamboo"],
    dominantColors: [{ name: "green", hex: "#2E6B4F", coveragePct: 70 }],
    dimensions: null,
    preserveText: [],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: ["leak proof lid", "carry loop", "wide mouth"],
    benefits: ["keeps water cold", "easy to carry", "easy to clean"],
    targetBuyer: "hikers",
    useContexts: ["trail", "office desk"],
    photographedAngles: ["front"],
    missingAnglesNeeded: [],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
    ...overrides,
  };
}

const opts = (extra: Partial<PlanOptions> = {}): PlanOptions => ({
  channels: ["amazon"],
  tier: "growth",
  creditBudget: 1000,
  primaryMediaId: "m1",
  ...extra,
});

function shot(type: Shot["type"], extra: Partial<Shot> = {}): Shot {
  return {
    id: `s_${type}`,
    type,
    sourceMediaId: "m1",
    method: "template",
    channels: ["amazon.aplus.basic_header"],
    stylePreset: "minimal_studio",
    credits: creditCosts.deterministic,
    priority: 6,
    ...extra,
  };
}

describe("claims guard", () => {
  const ctx = { sellerText: ["Holds 750 ml. Keeps water cold for 24 hours, clinically tested lid seal."] };

  it("drops a line with a figure the seller did not type, keeps one the seller did", () => {
    expect(guardedLine("Cold for 12 hours", 40, ctx)).toBeNull();
    expect(guardedLine("Cold for 24 hours", 40, ctx)).toBe("Cold for 24 hours");
    expect(guardedLine("Holds 750 ml", 40, ctx)).toBe("Holds 750 ml");
    expect(guardedLine("99% leak free", 40, ctx)).toBeNull();
    expect(guardedLine("Holds 1,200 ml", 40, { sellerText: ["1200 ml"] })).toBe("Holds 1,200 ml");
  });

  it("drops medical, efficacy, guarantee and ranking words unless the seller typed them", () => {
    for (const line of [
      "Cures dry mouth",
      "Relieves joint pain",
      "Guaranteed to last",
      "The best bottle you can buy",
      "Doctor recommended",
      "Anti-aging formula",
      "Burns fat on the go",
    ]) {
      expect(guardedLine(line, 40, { sellerText: [] }), line).toBeNull();
    }
    // The seller typed "clinically tested", so that phrase may print.
    expect(guardedLine("Clinically tested lid seal", 40, ctx)).toBe("Clinically tested lid seal");
    // Whole words only: "treat" inside "treatment free" is the word
    // "treatment", also blocked; "bestow" is not "best".
    expect(guardedLine("A bottle to bestow", 40, { sellerText: [] })).toBe("A bottle to bestow");
  });

  it("names the problem it found", () => {
    expect(claimProblem("Cold for 36 hours", ctx)).toBe("figure 36");
    expect(claimProblem("Proven design", { sellerText: [] })).toBe("claim word proven");
    expect(claimProblem("Easy to carry", { sellerText: [] })).toBeNull();
  });

  it("reads figures with separators and decimals as one figure", () => {
    expect(figuresIn("1,200 ml and 1.5 l, 3,5 cm")).toEqual(["1200", "1.5", "3.5"]);
  });

  it("lints every generated slot for rule 9 and never exceeds the slot length", () => {
    const dirty = [
      "Leak proof — always",
      "Fast -> easy",
      "Cold drinks \u{1F9CA}",
      "Carry it -- anywhere",
      "A very long line that keeps going far past the forty character slot",
    ];
    for (const raw of dirty) {
      const line = guardedLine(raw, aplusCopy.lineMaxChars, { sellerText: [] });
      expect(line).not.toBeNull();
      expect(rule9Problems(line!), `${raw} -> ${line}`).toEqual([]);
      expect(line!.length).toBeLessThanOrEqual(aplusCopy.lineMaxChars);
    }
    expect(rule9Problems("Leak proof — always")).toContain("dash");
    expect(rule9Problems("12-inch lid")).toEqual([]);
  });
});

describe("the results module never prints a number the seller did not supply", () => {
  // A deterministic sweep over lines with figures in every position and form.
  const figures = ["3", "7", "10", "24", "48", "100", "1.5", "2,000", "50%", "0"];
  const templates = [
    (f: string) => `Cold for ${f} hours`,
    (f: string) => `${f} times easier to clean`,
    (f: string) => `Lasts ${f} years`,
    (f: string) => `Up to ${f} refills a day`,
  ];

  for (const seller of [[], ["Holds 24 oz"], ["Rated 4.8 by 2,000 buyers"]]) {
    it(`with seller text ${JSON.stringify(seller)}`, () => {
      const sellerFigures = new Set(figuresIn(seller.join("\n")));
      const lines = figures.flatMap((f) => templates.map((t) => t(f)));
      const copy: AplusCopyResult = {
        modules: [{ type: "aplus_results", headline: "Up to 3 times colder", lines }],
      };
      const { shots, skipped } = applyAplusCopy([shot("aplus_results")], copy, { sellerText: seller });
      for (const kept of shots) {
        for (const text of [...(kept.callouts ?? []), kept.headline ?? ""]) {
          for (const figure of figuresIn(text)) {
            expect(sellerFigures.has(figure), `${text} prints ${figure}`).toBe(true);
          }
        }
      }
      if (shots.length === 0) {
        expect(skipped).toEqual([{ type: "aplus_results", reason: APLUS_COPY_SHORT_REASON }]);
      }
    });
  }
});

describe("applyAplusCopy", () => {
  const ctx = { sellerText: [] };

  it("uses the recipe's guarded lines and headline when enough lines pass", () => {
    const copy: AplusCopyResult = {
      modules: [
        {
          type: "aplus_features",
          headline: "Made for the trail!",
          lines: ["Leak proof lid", "Carry loop", "Wide mouth", "Cures thirst forever"],
        },
      ],
    };
    const { shots, skipped } = applyAplusCopy([shot("aplus_features", { callouts: ["planned"] })], copy, ctx);
    expect(skipped).toEqual([]);
    expect(shots[0].callouts).toEqual(["Leak proof lid", "Carry loop", "Wide mouth"]);
    expect(shots[0].headline).toBe("Made for the trail");
  });

  it("drops a headline that fails the guard but keeps the module", () => {
    const copy: AplusCopyResult = {
      modules: [{ type: "aplus_how_to", headline: "The best way in 3 steps", lines: ["Fill it", "Close it", "Carry it"] }],
    };
    const { shots } = applyAplusCopy([shot("aplus_how_to")], copy, ctx);
    expect(shots[0].callouts).toEqual(["Fill it", "Close it", "Carry it"]);
    expect(shots[0].headline).toBeUndefined();
  });

  it("falls back to the planner's own lines, then skips, never pads", () => {
    const plannedFeatures = shot("aplus_features", { callouts: ["Leak proof lid", "Carry loop", "Wide mouth"] });
    const plannedMaterials = shot("aplus_ingredients", { callouts: ["Stainless steel"] });
    const painPoints = shot("aplus_pain_points");
    const { shots, skipped } = applyAplusCopy([plannedFeatures, plannedMaterials, painPoints], null, ctx);
    expect(shots.map((s) => s.type)).toEqual(["aplus_features"]);
    expect(shots[0].callouts).toEqual(["Leak proof lid", "Carry loop", "Wide mouth"]);
    expect(skipped).toEqual([
      { type: "aplus_ingredients", reason: APLUS_COPY_SHORT_REASON },
      { type: "aplus_pain_points", reason: APLUS_COPY_SHORT_REASON },
    ]);
  });

  it("never touches the seller's endorsement or any other shot", () => {
    const endorsement = shot("aplus_endorsement", { callouts: ["Best bottle ever, 5 stars"] });
    const banner = shot("aplus_banner");
    const copy: AplusCopyResult = { modules: [] };
    const { shots } = applyAplusCopy([endorsement, banner], copy, ctx);
    expect(shots).toEqual([endorsement, banner]);
  });

  it("knows which plans need the copy call", () => {
    expect(needsAplusCopy([shot("aplus_banner"), shot("aplus_endorsement")])).toBe(false);
    expect(needsAplusCopy([shot("aplus_results")])).toBe(true);
    expect(GENERATED_APLUS_MODULES).not.toContain("aplus_endorsement");
  });
});

describe("the copy request and its strict tool schema", () => {
  it("sends facts and slot limits for the generated modules only", () => {
    const request = aplusCopyRequest(
      profile(),
      ["aplus_features", "aplus_endorsement", "aplus_results"],
      "<user_description>Holds 750 ml</user_description>",
    );
    expect(request.modules.map((m) => m.type)).toEqual(["aplus_features", "aplus_results"]);
    expect(request.modules[0]).toMatchObject({
      minLines: aplusModules.aplus_features.minLines,
      maxLines: aplusModules.aplus_features.maxLines,
      headlineMaxChars: aplusCopy.headlineMaxChars,
      lineMaxChars: aplusCopy.lineMaxChars,
    });
    expect(request.product).not.toHaveProperty("dominantColors");
  });

  it("makes every field required in the strict schema", () => {
    const schema = strictToolSchema(AplusCopyResult) as {
      required: string[];
      properties: { modules: { items: { required: string[]; additionalProperties: boolean } } };
    };
    expect(schema.required).toEqual(["modules"]);
    expect(schema.properties.modules.items.required.sort()).toEqual(["headline", "lines", "type"]);
    expect(schema.properties.modules.items.additionalProperties).toBe(false);
  });
});

describe("module rules", () => {
  it("drops the results module for a medical or food claim flag", () => {
    for (const flag of ["medical_claim", "food_claim"] as const) {
      expect(moduleSkipReason("aplus_results", profile({ complianceFlags: [flag] }), false)).toBe(
        APLUS_CLAIMS_FLAG_REASON,
      );
      expect(moduleSkipReason("aplus_features", profile({ complianceFlags: [flag] }), false)).toBeNull();
    }
  });

  it("skips the endorsement without seller input", () => {
    expect(moduleSkipReason("aplus_endorsement", profile(), false)).toBe(NO_ENDORSEMENT_REASON);
    expect(moduleSkipReason("aplus_endorsement", profile(), true)).toBeNull();
  });

  it("caps A+ files at the page's module limit, dropping the last first", () => {
    const shots = [
      shot("aplus_banner", { id: "b1" }),
      ...APLUS_MODULE_SHOT_TYPES.map((type) => shot(type)),
      shot("aplus_banner", { id: "b2" }),
      shot("social_1x1", { id: "social" }),
    ];
    const skipped: Array<{ type: string; reason: string }> = [];
    const kept = capAplusModules(shots, skipped);
    expect(kept.map((s) => s.id)).toEqual(["b1", ...APLUS_MODULE_SHOT_TYPES.map((t) => `s_${t}`), "social"]);
    expect(skipped).toEqual([{ type: "aplus_banner", reason: APLUS_MODULE_CAP_REASON }]);
    expect(aplusCopy.maxModulesPerDocument).toBe(7);
  });
});

describe("planner A+ modules", () => {
  it("plans the modules the product supports on the A+ header, at the deterministic price", () => {
    const list = planShots(profile(), opts({ endorsements: ["Loved by hikers"] }));
    const modules = list.shots.filter((s) => (APLUS_MODULE_SHOT_TYPES as readonly string[]).includes(s.type));
    expect(modules.map((s) => s.type).sort()).toEqual([...APLUS_MODULE_SHOT_TYPES].sort());
    for (const module of modules) {
      expect(module.method).toBe("template");
      expect(module.credits).toBe(creditCosts.deterministic);
      expect(module.channels).toEqual([aplusModules[module.type as keyof typeof aplusModules].specId]);
    }
    expect(modules.find((s) => s.type === "aplus_endorsement")?.callouts).toEqual(["Loved by hikers"]);
    expect(modules.find((s) => s.type === "aplus_ingredients")?.callouts).toEqual(["stainless steel", "bamboo"]);
    // Hero banner plus six modules fill the page; the second banner goes.
    const aplus = list.shots.filter((s) => s.channels.some((c) => c.startsWith("amazon.aplus.")));
    expect(aplus).toHaveLength(aplusCopy.maxModulesPerDocument);
    expect(list.skipped).toContainEqual({ type: "aplus_banner", reason: APLUS_MODULE_CAP_REASON });
  });

  it("skips the endorsement without seller input and keeps both banners", () => {
    const list = planShots(profile(), opts());
    expect(list.shots.some((s) => s.type === "aplus_endorsement")).toBe(false);
    expect(list.skipped).toContainEqual({ type: "aplus_endorsement", reason: NO_ENDORSEMENT_REASON });
    expect(list.shots.filter((s) => s.type === "aplus_banner")).toHaveLength(2);
  });

  it("plans the endorsement from the has flag alone for the estimate", () => {
    const list = planShots(profile(), opts({ hasEndorsements: true }));
    const endorsement = list.shots.find((s) => s.type === "aplus_endorsement");
    expect(endorsement).toBeDefined();
    expect(endorsement?.callouts).toBeUndefined();
  });

  it("drops the results module for a claim flag", () => {
    const list = planShots(profile({ complianceFlags: ["food_claim"] }), opts());
    expect(list.shots.some((s) => s.type === "aplus_results")).toBe(false);
    expect(list.skipped).toContainEqual({ type: "aplus_results", reason: APLUS_CLAIMS_FLAG_REASON });
  });

  it("considers no module when no A+ spec is picked", () => {
    const list = planShots(profile(), opts({ channels: ["amazon.main", "amazon.secondary"] }));
    const types = [...list.shots, ...list.skipped].map((s) => s.type);
    for (const type of APLUS_MODULE_SHOT_TYPES) {
      expect(types).not.toContain(type);
    }
  });

  it("puts every module in the A+ bundle and none in the listing or main bundles", () => {
    for (const type of APLUS_MODULE_SHOT_TYPES) {
      expect(packBundles.aplus.aplusModules).toContain(type);
      expect(packBundles.listing.shotTypes as readonly string[]).not.toContain(type);
      expect(packBundles.main.shotTypes as readonly string[]).not.toContain(type);
    }
  });

  it("keeps the modules out of the shot planner's tool schema", () => {
    const schema = JSON.stringify(strictToolSchema(LlmShotList));
    for (const type of APLUS_MODULE_SHOT_TYPES) {
      expect(schema).not.toContain(type);
    }
    expect(schema).not.toContain("headline");
  });
});
