import { describe, expect, it } from "vitest";
import { healthLimits } from "@curvi/pipeline/seed";
import { memoryAllowsStart } from "./memory";
describe("runner memory admission", () => {
  it("holds additional packs at the seeded boundary and permits one pack on an idle process", () => {
    const limit = 512 * 1024 * 1024;
    expect(memoryAllowsStart(1, limit * healthLimits.memoryStartRatio, limit)).toBe(false);
    expect(memoryAllowsStart(1, limit * healthLimits.memoryStartRatio - 1, limit)).toBe(true);
    expect(memoryAllowsStart(0, limit, limit)).toBe(true);
    expect(memoryAllowsStart(1, limit, null)).toBe(true);
  });
});
