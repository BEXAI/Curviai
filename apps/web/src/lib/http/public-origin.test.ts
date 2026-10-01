import { afterEach, describe, expect, it, vi } from "vitest";
import { publicOrigin } from "./public-origin";

const req = (headers: Record<string, string>, url = "http://0.0.0.0:10000/auth/callback") => ({ url, headers: new Headers(headers) });

describe("publicOrigin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never uses the container bind address behind the proxy", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    expect(publicOrigin(req({ host: "curvi.ai", "x-forwarded-proto": "https" }))).toBe("https://curvi.ai");
    expect(publicOrigin(req({ host: "0.0.0.0:10000" }))).toBe("https://curvi.ai");
    expect(publicOrigin(req({}))).toBe("https://curvi.ai");
  });

  it("refuses a forged host", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    expect(publicOrigin(req({ host: "evil.com", "x-forwarded-host": "evil.com" }))).toBe("https://curvi.ai");
  });

  it("keeps local development hosts and their port", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    expect(publicOrigin(req({ host: "localhost:3100" }, "http://localhost:3100/x"))).toBe("http://localhost:3100");
  });
});
