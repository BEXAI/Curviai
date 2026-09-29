import { ProviderRegistry, isProbeable } from "@curvi/ai";
import { describe, expect, it } from "vitest";
import { wireLiveProviders } from "./live-runtime";
import { liveProviderTargets, stageKeyReport } from "./provider-probes";
import { demoRoutingTable } from "./runtime";
import { DEFAULT_SHOT_CONCURRENCY, parseShotConcurrency } from "./shot-concurrency";

const ALL_KEYS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "BFL_API_KEY", "OPENAI_API_KEY", "FAL_KEY"];

function envOf(names: string[]): (name: string) => string | undefined {
  return (name) => (names.includes(name) ? `value-of-${name}` : undefined);
}

function wiredNames(names: string[]): string[] {
  const registry = new ProviderRegistry();
  wireLiveProviders(registry, demoRoutingTable(), envOf(names));
  return registry.list().map((provider) => provider.name).sort();
}

describe("liveProviderTargets", () => {
  it.each([[ALL_KEYS], [[]], [["ANTHROPIC_API_KEY"]], [["BFL_API_KEY", "FAL_KEY"]], [["GEMINI_API_KEY", "OPENAI_API_KEY"]]])(
    "lists exactly the providers wireLiveProviders registers for keys %j",
    (names) => {
      const configured = liveProviderTargets(envOf(names))
        .filter((target) => target.configured)
        .map((target) => target.name)
        .sort();
      expect(configured).toEqual(wiredNames(names));
    },
  );

  it("gives every configured target an adapter, probeable except the fal cutout, and none to the rest", () => {
    const targets = liveProviderTargets(envOf(["ANTHROPIC_API_KEY", "FAL_KEY"]));
    expect(targets.find((target) => target.kind === "cutout")).toMatchObject({
      name: "fal-birefnet",
      envVar: "FAL_KEY",
      configured: true,
    });
    for (const target of targets) {
      if (target.configured) {
        expect(target.provider).not.toBeNull();
        // fal has no free key probe; the probe route reports it as skipped.
        expect(target.provider && isProbeable(target.provider)).toBe(target.kind !== "cutout");
      } else {
        expect(target.provider).toBeNull();
      }
    }
  });

  it("counts the cutout stage ready on the backup fal account alone", () => {
    const report = stageKeyReport(liveProviderTargets(envOf(["FAL_KEY_BACKUP"])));
    const cutout = report.find((entry) => entry.stage === "cutout");
    expect(cutout).toMatchObject({ ready: true });
    expect(cutout?.keys).toEqual([
      { envVar: "FAL_KEY", present: false },
      { envVar: "FAL_KEY_BACKUP", present: true },
    ]);
  });

  it("reports key presence per stage by env name only", () => {
    const report = stageKeyReport(liveProviderTargets(envOf(["BFL_API_KEY"])));
    const byStage = Object.fromEntries(report.map((entry) => [entry.stage, entry]));
    expect(byStage.scene_plate).toMatchObject({ kind: "image", ready: true });
    expect(byStage.scene_plate.keys).toEqual([
      { envVar: "GEMINI_API_KEY", present: false },
      { envVar: "BFL_API_KEY", present: true },
      { envVar: "OPENAI_API_KEY", present: false },
    ]);
    expect(byStage.cutout).toMatchObject({
      ready: false,
      keys: [
        { envVar: "FAL_KEY", present: false },
        { envVar: "FAL_KEY_BACKUP", present: false },
      ],
    });
    for (const stage of ["intake", "analyze", "plan", "copy", "qc"]) {
      expect(byStage[stage]).toMatchObject({ kind: "llm", ready: false, keys: [{ envVar: "ANTHROPIC_API_KEY", present: false }] });
    }
    expect(JSON.stringify(report)).not.toContain("value-of-");
  });
});

describe("parseShotConcurrency", () => {
  it("clamps whole numbers to 1 to 8 and ignores anything else", () => {
    expect(parseShotConcurrency(undefined)).toBeUndefined();
    expect(parseShotConcurrency("")).toBeUndefined();
    expect(parseShotConcurrency("two")).toBeUndefined();
    expect(parseShotConcurrency("1.5")).toBeUndefined();
    expect(parseShotConcurrency(" 3 ")).toBe(3);
    expect(parseShotConcurrency("0")).toBe(1);
    expect(parseShotConcurrency("50")).toBe(8);
    expect(DEFAULT_SHOT_CONCURRENCY).toBe(2);
  });
});
