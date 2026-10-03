import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());
function get(file = "test-ownership-proof-1234.txt") {
  return GET(new Request(`https://curvi.ai/${file}`), { params: Promise.resolve({ indexnowKeyFile: file }) });
}

describe("IndexNow ownership proof", () => {
  it.each(["", "short", "invalid value", "x".repeat(129), "newline\nvalue"])("stays unavailable for missing/invalid configuration", async (key) => {
    vi.stubEnv("INDEXNOW_KEY", key);
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("serves only the configured public proof with no cache or indexing", async () => {
    vi.stubEnv("INDEXNOW_KEY", "test-ownership-proof-1234");
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("test-ownership-proof-1234");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("never exposes the configured proof at another filename or page", async () => {
    vi.stubEnv("INDEXNOW_KEY", "test-ownership-proof-1234");
    for (const file of ["indexnow-key.txt", "different-key123.txt", "unknown-page", "test-ownership-proof-1234"]) {
      const response = await get(file);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });
});
