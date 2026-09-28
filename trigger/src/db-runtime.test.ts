import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { undeliverableShotMethods } from "@curvi/pipeline/seed";
import { buildDbRuntimeDeps } from "./db-runtime";

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
});
