import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoModeAllowed } from "@/lib/services/demo-mode";
import { createFakeServices } from "@/lib/testing/fake-services";

// Demo mode fails closed in production: getServices() throws a typed error
// without the database env vars unless ALLOW_DEMO_MODE=1, and routes answer
// it with a plain 503.

vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => null,
  createSupabaseServerClient: async () => null,
}));

const DB_VARS = ["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];

beforeEach(() => {
  for (const name of DB_VARS) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("ALLOW_DEMO_MODE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/services");
  vi.resetModules();
});

describe("demoModeAllowed", () => {
  it("allows demo mode outside production, and in production only with ALLOW_DEMO_MODE=1", () => {
    expect(demoModeAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(demoModeAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(demoModeAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(demoModeAllowed({ NODE_ENV: "production", ALLOW_DEMO_MODE: "true" })).toBe(false);
    expect(demoModeAllowed({ NODE_ENV: "production", ALLOW_DEMO_MODE: "1" })).toBe(true);
  });
});

describe("getServices", () => {
  it("throws DemoModeRefusedError in production without the database env vars", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { getServices, DemoModeRefusedError: Refused } = await import("@/lib/services");
    expect(() => getServices()).toThrow(Refused);
  });

  it("serves the demo in production only when ALLOW_DEMO_MODE=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DEMO_MODE", "1");
    const { getServices } = await import("@/lib/services");
    expect(getServices().mode).toBe("demo");
  });

  it("serves the demo in development with no env vars at all", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { getServices } = await import("@/lib/services");
    expect(getServices().mode).toBe("demo");
  });
});

describe("resolveSignedIn", () => {
  it("answers a refused demo mode with a plain 503 and Retry-After", async () => {
    vi.doMock("@/lib/services", async () => {
      // The module registry was reset, so throw the class ./services loads.
      const { DemoModeRefusedError: Refused } = await import("@/lib/services/demo-mode");
      return {
        getServices: () => {
          throw new Refused();
        },
      };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { resolveSignedIn } = await import("./services");
    const resolved = await resolveSignedIn("Sign in to create a pack.");
    expect("response" in resolved).toBe(true);
    if ("response" in resolved) {
      expect(resolved.response.status).toBe(503);
      expect(resolved.response.headers.get("Retry-After")).toBe("60");
      const body = (await resolved.response.json()) as { error: string; reason: string };
      expect(body).toEqual({
        error: "Curvi is not available right now. We are on it, so try again in a few minutes.",
        reason: "unavailable",
      });
      expect(body.error).not.toMatch(/[–—→]| - |->/);
    }
    errors.mockRestore();
  });

  it("hands back the services and the workspace of a signed in caller, and 401 when signed out", async () => {
    const services = createFakeServices("owner");
    vi.doMock("@/lib/services", () => ({ getServices: () => services }));
    const { resolveSignedIn } = await import("./services");
    const resolved = await resolveSignedIn("Sign in.", { ensure: true });
    expect(resolved).toMatchObject({ services, workspace: { role: "owner" } });
    expect(services.ensureWorkspace).toHaveBeenCalled();

    const signedOut = createFakeServices(null);
    vi.doMock("@/lib/services", () => ({ getServices: () => signedOut }));
    vi.resetModules();
    const again = await import("./services");
    const refused = await again.resolveSignedIn("Sign in.");
    expect("response" in refused && refused.response.status).toBe(401);
  });

  it("lets any other error through", async () => {
    vi.doMock("@/lib/services", () => ({
      getServices: () => {
        throw new Error("boom");
      },
    }));
    const { servicesOrUnavailable } = await import("./services");
    expect(() => servicesOrUnavailable()).toThrow("boom");
  });
});
