import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { undeliverableShotMethods } from "@curvi/pipeline/seed";
import { buildDbRuntimeDeps } from "./db-runtime";
import { buildRuntimeDeps, reportAiInternalError } from "./runtime";

// postgres-js connects lazily, so building the deps never touches this URL.
const FAKE_URL = "postgres://curvi:curvi@127.0.0.1:1/curvi";
let previous: string | undefined;

beforeAll(() => {
  previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = FAKE_URL;
});

afterAll(() => {
  if (previous === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previous;
  }
});

describe("buildDbRuntimeDeps", () => {
  it("skips exactly the shot methods the seed marks undeliverable, as the web estimate does", () => {
    const deps = buildDbRuntimeDeps();
    expect(deps).not.toBeNull();
    expect([...(deps?.excludeShotMethods ?? [])].sort()).toEqual([...undeliverableShotMethods].sort());
    expect(deps?.excludeShotMethods).toContain("video_generate");
    expect(deps?.excludeShotMethods).toContain("avatar");
  });

  it("routes the spend alert and the hard stop to one founder notifier", () => {
    const first = buildDbRuntimeDeps();
    const second = buildDbRuntimeDeps();
    expect(typeof first?.onSpendAlert).toBe("function");
    // One notifier per process, so its in process dedupe spans every pack.
    expect(first?.onSpendAlert).toBe(second?.onSpendAlert);
    // The caps instance reports its own refusals (the hard stop).
    const caps = first?.ai.caps;
    expect(caps && Object.prototype.hasOwnProperty.call(caps, "checkAndReserveGlobalDay")).toBe(true);
  });

  it("hands every routed provider call the founder alert and the internal error reporter (5.7)", () => {
    const deps = buildDbRuntimeDeps();
    expect(deps?.ai.onCapAlert).toBe(deps?.onSpendAlert);
    expect(deps?.ai.onInternalError).toBe(reportAiInternalError);
  });
});

describe("buildRuntimeDeps without a database", () => {
  it("routes the alert line of every provider call to one process wide founder notifier", () => {
    const first = buildRuntimeDeps();
    const second = buildRuntimeDeps();
    expect(typeof first.ai.onCapAlert).toBe("function");
    expect(first.ai.onCapAlert).toBe(first.onSpendAlert);
    expect(first.onSpendAlert).toBe(second.onSpendAlert);
    expect(first.ai.onInternalError).toBe(reportAiInternalError);
  });

  it("reports swallowed router errors as a structured line", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reportAiInternalError(new Error("meter down"), "meter.record success");
      const line = JSON.parse(String(error.mock.calls[0][0])) as Record<string, unknown>;
      expect(line).toEqual({ level: "error", event: "ai_internal_error", context: "meter.record success", error: "meter down" });
    } finally {
      error.mockRestore();
    }
  });
});
