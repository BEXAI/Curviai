import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, dynamic } from "./.well-known/openai-apps-challenge/route";

// PHASE_19 P19-22: OpenAI's domain proof. The body is the exact token as
// plain text, "not JSON or a list of tokens" (O3).

describe("GET /.well-known/openai-apps-challenge", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves the approved public challenge when no override is set", async () => {
    for (const value of [undefined, "", "   "]) {
      vi.stubEnv("OPENAI_APPS_CHALLENGE_TOKEN", value);
      const response = GET();
      expect(response.status, JSON.stringify(value)).toBe(200);
      expect(await response.text()).toBe("hZMc0Qeyiu5Imj78qB94XYFxpKUlFhV5FRD2y8Hld3A");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("preserves an explicit environment override as exact plain text", async () => {
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
