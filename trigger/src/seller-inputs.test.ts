import { describe, expect, it } from "vitest";
import {
  InMemoryBreakerStore,
  InMemoryCostMeter,
  ProviderRegistry,
} from "@curvi/ai";
import { MockProvider } from "@curvi/ai/testing";
import type { Shot, ShotList } from "@curvi/pipeline";
import {
  activeRecipe,
  runGeneratePack,
  sellerCopyOf,
  systemClock,
  withSellerCopy,
  InMemoryJobStore,
  type AiDeps,
  type GeneratePackInput,
  type ShotGenerateArgs,
  type ShotGeneration,
  type ShotGenerator,
} from "./pipeline-runner";
import { demoProfile, DemoShotGenerator } from "./runtime";

// Seller inputs reach the plan (docs/phases/PHASE_11.md, b2/inputs): photo
// roles pick the source photo of each angle, and box contents and comparison
// facts make the in_the_box and comparison shots plannable, printed exactly
// as the seller typed them.

const intakeKey = activeRecipe("intake").key;
const analyzeKey = activeRecipe("analyze").key;
const planKey = activeRecipe("plan").key;
const qcKey = activeRecipe("qc").key;

const intakeFixture = {
  images: [
    {
      sellableProduct: true,
      distinctProducts: 1,
      sharpEnough: true,
      flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
    },
  ],
};

function makeAi(): AiDeps & { plan: MockProvider } {
  const plan = new MockProvider({ name: "mock-plan", tasks: [planKey], output: { notAShotList: true } });
  const providers = [
    new MockProvider({ name: "mock-intake", tasks: [intakeKey], output: intakeFixture }),
    // The analyzer sees only the front photo; the seller marked the rest.
    new MockProvider({
      name: "mock-analyze",
      tasks: [analyzeKey],
      output: { ...demoProfile, photographedAngles: ["front"], missingAnglesNeeded: ["back"] },
    }),
    plan,
    new MockProvider({ name: "mock-qc", tasks: [qcKey], output: { pass: true, fidelity: 0.97, issues: [], repairHint: "" } }),
  ];
  const registry = new ProviderRegistry();
  for (const provider of providers) {
    registry.register(provider);
  }
  return {
    registry,
    routing: {
      [intakeKey]: ["mock-intake"],
      [analyzeKey]: ["mock-analyze"],
      [planKey]: ["mock-plan"],
      [qcKey]: ["mock-qc"],
    },
    meter: new InMemoryCostMeter(),
    breakerStore: new InMemoryBreakerStore(),
    plan,
  };
}

class RecordingGenerator implements ShotGenerator {
  private readonly demo = new DemoShotGenerator();
  readonly shots: Shot[] = [];

  async generate(args: ShotGenerateArgs): Promise<ShotGeneration> {
    this.shots.push(args.shot);
    return this.demo.generate(args);
  }
}

const input: GeneratePackInput = {
  jobId: "job-seller",
  workspaceId: "ws1",
  tier: "growth",
  // Shopify's gallery, since amazon.secondary's 8 slots go to the reserved
  // and higher priority shots first (the slot mix is a pending founder call).
  channels: ["amazon.main", "shopify.product"],
  creditBudget: 40,
  images: [
    { mediaId: "m_back", angle: "back" },
    { mediaId: "m_front", angle: "front" },
    { mediaId: "m_box", angle: "in_the_box" },
  ],
  boxContents: ["Mug", "Pour over cone", "Two paper filters"],
  comparisonFacts: ["Holds 12 oz, most hold 8 oz"],
};

describe("seller inputs in the runner", () => {
  it("plans from the photo each role names and prints the seller's own lines", async () => {
    const ai = makeAi();
    const generator = new RecordingGenerator();
    const summary = await runGeneratePack(input, {
      ai,
      store: new InMemoryJobStore(),
      clock: systemClock,
      generator,
    });
    expect(summary.state).toBe("done");
    const byType = (type: Shot["type"]) => generator.shots.filter((s) => s.type === type);

    // The seller's front photo leads, even though it was uploaded second.
    expect(byType("amazon_main")[0]?.sourceMediaId).toBe("m_front");
    // The back photo is an angle now, drawn from its own photo.
    expect(byType("alt_angle_white").map((s) => s.sourceMediaId)).toEqual(expect.arrayContaining(["m_back"]));
    // In the box draws from the in the box photo and prints the list.
    expect(byType("in_the_box")[0]?.sourceMediaId).toBe("m_box");
    expect(byType("in_the_box")[0]?.callouts).toEqual(input.boxContents);
    expect(byType("comparison")[0]?.callouts).toEqual(input.comparisonFacts);

    // The LLM planner learns that facts exist, never the seller's text.
    const planPayload = JSON.stringify(ai.plan.calls.map((call) => call.input));
    expect(planPayload).toContain("hasBoxContents");
    expect(planPayload).not.toContain("Pour over cone");
    expect(planPayload).not.toContain("most hold 8 oz");
  });

  it("skips both shots when the seller gave no lines", async () => {
    const generator = new RecordingGenerator();
    const summary = await runGeneratePack(
      { ...input, jobId: "job-bare", boxContents: [], comparisonFacts: undefined, hasBoxContents: true },
      { ai: makeAi(), store: new InMemoryJobStore(), clock: systemClock, generator },
    );
    expect(summary.state).toBe("done");
    expect(generator.shots.some((s) => s.type === "in_the_box" || s.type === "comparison")).toBe(false);
    expect(summary.skipped).toEqual(
      expect.arrayContaining([
        { type: "in_the_box", reason: "seller did not list contents" },
        { type: "comparison", reason: "seller did not supply comparison facts" },
      ]),
    );
  });
});

describe("withSellerCopy", () => {
  const shot = (type: Shot["type"], callouts?: string[]): Shot => ({
    id: `s_${type}`,
    type,
    sourceMediaId: "m1",
    method: "template",
    channels: ["amazon.secondary"],
    stylePreset: "none",
    credits: 0.5,
    priority: 5,
    ...(callouts ? { callouts } : {}),
  });

  it("replaces model wording with the seller's lines and drops shots with none", () => {
    const plan: ShotList = {
      shots: [shot("in_the_box", ["Invented charger"]), shot("comparison", ["Best on the market"]), shot("infographic", ["Keeps hot"])],
      skipped: [],
    };
    const copy = sellerCopyOf({ boxContents: ["Mug", " Lid "], comparisonFacts: [] });
    const out = withSellerCopy(plan, copy);
    expect(out.shots.map((s) => [s.type, s.callouts])).toEqual([
      ["in_the_box", ["Mug", "Lid"]],
      ["infographic", ["Keeps hot"]],
    ]);
    expect(out.skipped).toEqual([{ type: "comparison", reason: "seller did not supply comparison facts" }]);
  });
});
