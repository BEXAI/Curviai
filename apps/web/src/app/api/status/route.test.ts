import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAcquisitionForTests } from "@/lib/acquisition";
import { GET } from "./route";

// GET /api/status (docs/phases/PHASE_18.md P18-03): the state only, cached
// by browsers for 30 seconds, never a provider name or a balance.

afterEach(() => {
  vi.unstubAllEnvs();
  resetAcquisitionForTests();
});

describe("GET /api/status", () => {
  it("answers open in demo mode with a public 30 second cache", async () => {
    vi.stubEnv("CURVI_DEMO_ACQUISITION", "");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(await res.json()).toEqual({ acquisition: "open" });
  });

  it("answers waitlist and nothing else while the gate is closed", async () => {
    vi.stubEnv("CURVI_DEMO_ACQUISITION", "waitlist");
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ acquisition: "waitlist" });
    expect(Object.keys(body)).toEqual(["acquisition"]);
    expect(JSON.stringify(body)).not.toMatch(/fal|balance|demo|reason/i);
  });
});
