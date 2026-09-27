import { describe, expect, it } from "vitest";
import { InMemoryCostMeter } from "./meter";
import type { CostMeterEntry } from "./types";

function entry(overrides: Partial<CostMeterEntry>): CostMeterEntry {
  return {
    provider: "p1",
    task: "generate_image",
    costMicros: 0,
    latencyMs: 10,
    ok: true,
    attempt: 1,
    at: new Date("2026-09-27T00:00:00Z"),
    ...overrides,
  };
}

describe("InMemoryCostMeter", () => {
  it("accumulates totals per provider, task, job and workspace", () => {
    const meter = new InMemoryCostMeter();
    meter.record(entry({ provider: "p1", task: "a", costMicros: 100, workspaceId: "w1", jobId: "j1" }));
    meter.record(entry({ provider: "p1", task: "b", costMicros: 50, workspaceId: "w1", jobId: "j2" }));
    meter.record(entry({ provider: "p2", task: "a", costMicros: 25, workspaceId: "w2", jobId: "j1" }));

    expect(meter.totalForProvider("p1")).toBe(150);
    expect(meter.totalForProvider("p2")).toBe(25);
    expect(meter.totalForTask("a")).toBe(125);
    expect(meter.totalForTask("b")).toBe(50);
    expect(meter.totalForJob("j1")).toBe(125);
    expect(meter.totalForJob("j2")).toBe(50);
    expect(meter.totalForJob("unknown")).toBe(0);

    const w1 = meter.totalsFor("w1");
    expect(w1.costMicros).toBe(150);
    expect(w1.calls).toBe(2);
    expect(w1.byProvider).toEqual({ p1: 150 });
    expect(w1.byTask).toEqual({ a: 100, b: 50 });

    expect(meter.totalsFor("empty")).toEqual({ costMicros: 0, calls: 0, byProvider: {}, byTask: {} });
  });

  it("keeps failed attempts in the entry log with their ok flag", () => {
    const meter = new InMemoryCostMeter();
    meter.record(entry({ ok: false, error: "boom", workspaceId: "w1" }));
    meter.record(entry({ ok: true, costMicros: 40, workspaceId: "w1" }));

    expect(meter.entries).toHaveLength(2);
    expect(meter.entries[0].ok).toBe(false);
    expect(meter.entries[0].error).toBe("boom");
    expect(meter.entries[1].ok).toBe(true);
    expect(meter.totalsFor("w1").calls).toBe(2);
    expect(meter.totalsFor("w1").costMicros).toBe(40);
  });
});
