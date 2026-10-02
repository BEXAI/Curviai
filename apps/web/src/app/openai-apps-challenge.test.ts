import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, dynamic } from "./.well-known/openai-apps-challenge/route";

// PHASE_19 P19-22: OpenAI's domain proof. The body is the exact token as
// plain text, "not JSON or a list of tokens" (O3), and the path stays a 404
// until the founder sets the token.

describe("GET /.well-known/openai-apps-challenge", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers 404 while the token is not set", async () => {
    for (const value of ["", "   "]) {
      vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", value);
      const response = GET();
      expect(response.status, JSON.stringify(value)).toBe(404);
      expect(await response.text()).not.toContain("token");
    }
  });

  it("serves exactly the token as plain text", async () => {
    vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", "oac_7Hk2pQx9Vw\n");
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("oac_7Hk2pQx9Vw");
    expect(response.headers.get("content-type")).toMatch(/^text\/plain(;|$)/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reads the token on every request, not at build time", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
