import { describe, expect, it } from "vitest";
import { smokeSettings } from "../../../../../e2e/smoke/settings";

describe("real stack smoke safety", () => {
  it("defaults to local demo without paid work and refuses ambiguous targets", () => {
    expect(smokeSettings({ SMOKE_BASE_URL: "http://localhost:3100" })).toEqual({ baseURL: "http://localhost:3100", mode: "demo", packEnabled: false });
    for (const base of ["https://curvi.ai", "https://user:pass@example.com", "https://example.com/path", "ftp://localhost"]) {
      expect(() => smokeSettings({ SMOKE_BASE_URL: base })).toThrow();
    }
    expect(() => smokeSettings({})).toThrow(/SMOKE_BASE_URL/);
  });
  it("production public smoke cannot enable a pack or staging browser login", () => {
    expect(smokeSettings({ SMOKE_BASE_URL: "https://curvi.ai", SMOKE_MODE: "production", SMOKE_ALLOW_PACKS: "1" }).packEnabled).toBe(false);
    expect(() => smokeSettings({ SMOKE_BASE_URL: "https://curvi.ai", SMOKE_MODE: "staging" })).toThrow();
  });
  it("paid staging and production each require their explicit opt-in and API key", () => {
    const staging = { SMOKE_BASE_URL: "https://staging.example.com", SMOKE_MODE: "staging" };
    expect(smokeSettings(staging).packEnabled).toBe(false);
    expect(() => smokeSettings({ ...staging, SMOKE_ALLOW_PACKS: "1" })).toThrow(/SMOKE_API_KEY/);
    expect(smokeSettings({ ...staging, SMOKE_ALLOW_PACKS: "1", SMOKE_API_KEY: "test" }).packEnabled).toBe(true);
    const production = { SMOKE_BASE_URL: "https://curvi.ai", SMOKE_MODE: "synthetic", SMOKE_API_KEY: "test" };
    expect(() => smokeSettings(production)).toThrow(/explicit/);
    expect(() => smokeSettings({ ...production, SMOKE_ALLOW_PRODUCTION_PACK: "1" })).toThrow(/excluded/);
    expect(smokeSettings({ ...production, SMOKE_ALLOW_PRODUCTION_PACK: "1", SMOKE_WORKSPACE_EXCLUDED: "1" }).packEnabled).toBe(true);
  });
});
