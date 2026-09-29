import { describe, expect, it } from "vitest";
import type { ShotList } from "../schemas";
import { applyBrandStylePreset, AUTO_STYLE_PRESET, brandStylePreset } from "./brand";

function shot(id: string, stylePreset: string): ShotList["shots"][number] {
  return {
    id,
    type: "lifestyle",
    sourceMediaId: "m1",
    method: "composite_generate",
    channels: ["amazon.secondary"],
    stylePreset,
    credits: 4,
    priority: 4,
  };
}

const plan: ShotList = {
  shots: [shot("s01", "none"), shot("s02", "kitchen_lifestyle"), shot("s03", "minimal_studio")],
  skipped: [{ type: "dimensions", reason: "no dimensions provided" }],
};

const matte = { surface: { reflective: false, transparent: false, textured: false } };

describe("applyBrandStylePreset", () => {
  it("replaces every planned preset but keeps shots planned without one", () => {
    const out = applyBrandStylePreset(plan, "luxury_marble", matte);
    expect(out.shots.map((s) => s.stylePreset)).toEqual(["none", "luxury_marble", "luxury_marble"]);
    expect(out.skipped).toEqual(plan.skipped);
    // The input plan is not mutated.
    expect(plan.shots[1].stylePreset).toBe("kitchen_lifestyle");
  });

  it("leaves the plan alone for auto, an unknown preset or no kit", () => {
    for (const preset of [AUTO_STYLE_PRESET, "retired_preset", "", null, undefined]) {
      expect(applyBrandStylePreset(plan, preset, matte)).toBe(plan);
    }
  });

  it("keeps planner rule 5 soft light for reflective and transparent products", () => {
    const shiny = { surface: { reflective: true, transparent: false, textured: false } };
    const clear = { surface: { reflective: false, transparent: true, textured: false } };
    expect(applyBrandStylePreset(plan, "outdoor", shiny)).toBe(plan);
    expect(applyBrandStylePreset(plan, "outdoor", clear)).toBe(plan);
  });

  it("lets the pack's Scene style win over the kit, and auto defer to it (PHASE_15 P1)", () => {
    expect(applyBrandStylePreset(plan, "luxury_marble", matte, "outdoor").shots.map((s) => s.stylePreset)).toEqual([
      "none",
      "outdoor",
      "outdoor",
    ]);
    expect(applyBrandStylePreset(plan, null, matte, "holiday").shots[1].stylePreset).toBe("holiday");
    expect(applyBrandStylePreset(plan, "luxury_marble", matte, AUTO_STYLE_PRESET).shots[1].stylePreset).toBe(
      "luxury_marble",
    );
    expect(applyBrandStylePreset(plan, null, matte, AUTO_STYLE_PRESET)).toBe(plan);
    // Reflective products stay on soft light whatever the seller picks.
    const shiny = { surface: { reflective: true, transparent: false, textured: false } };
    expect(applyBrandStylePreset(plan, null, shiny, "outdoor")).toBe(plan);
  });

  it("recognizes only seeded preset keys", () => {
    expect(brandStylePreset("holiday")).toBe("holiday");
    expect(brandStylePreset("toString")).toBeNull();
    expect(brandStylePreset("auto")).toBeNull();
  });
});
