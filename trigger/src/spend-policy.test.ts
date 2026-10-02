import { describe, expect, it } from "vitest";
import { costCaps, tiers } from "@curvi/pipeline/seed";
import { expectedDailyMicros, resolveHardStopValue } from "./spend-policy";
describe("operator spend limits", () => {
  it("prefers a valid setting, then environment, then seed, and honors a zero stop", () => {
    expect(resolveHardStopValue(25, "40")).toBe(25_000_000);
    expect(resolveHardStopValue(0, "40")).toBe(0);
    expect(resolveHardStopValue(null, "40")).toBe(40_000_000);
    expect(resolveHardStopValue(-1, "invalid")).toBe(costCaps.globalDailyHardStopMicros);
    expect(resolveHardStopValue(false, undefined)).toBe(costCaps.globalDailyHardStopMicros);
  });
  it("seeds an expected daily spend for every tier including free", () => {
    for (const tier of tiers) expect(expectedDailyMicros(tier.key)).toBeGreaterThan(0);
    expect(expectedDailyMicros("unknown")).toBe(costCaps.workspaceExpectedDailyMicrosByTier.free);
  });
});
