import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, clientIpDiagnostics, PROXY_PROOF_HEADER, requestHostAllowed } from "./client-ip";

beforeEach(() => {
  vi.stubEnv("CLIENT_IP_HEADER", "");
  vi.stubEnv("CLIENT_IP_PROXY_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("trusted client address", () => {
  it("ignores forged leading and vendor headers", () => {
    expect(clientIp(new Headers({
      "cf-connecting-ip": "1.1.1.1", "true-client-ip": "2.2.2.2",
      "x-real-ip": "3.3.3.3", "x-forwarded-for": "4.4.4.4, 203.0.113.7",
    }))).toBe("203.0.113.7");
  });
  it("requires the proxy proof for a configured Cloudflare header", () => {
    vi.stubEnv("CLIENT_IP_HEADER", "cf-connecting-ip");
    vi.stubEnv("CLIENT_IP_PROXY_SECRET", "test-proxy-proof");
    const headers = new Headers({ "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "203.0.113.7" });
    expect(clientIp(headers)).toBe("203.0.113.7");
    headers.set(PROXY_PROOF_HEADER, "wrong-proxy-proof");
    expect(clientIp(headers)).toBe("203.0.113.7");
    headers.set(PROXY_PROOF_HEADER, "test-proxy-proof");
    expect(clientIp(headers)).toBe("198.51.100.4");
  });
  it("accepts IPv6 and refuses malformed addresses", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "::1" }))).toBe("::1");
    expect(clientIp(new Headers({ "x-forwarded-for": "bad-address" }))).toBe("unknown");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("exposes only coarse masked candidates to the operator diagnostic", () => {
    const detail = clientIpDiagnostics(new Headers({
      "x-forwarded-for": "198.51.100.88, 203.0.113.79",
      "cf-connecting-ip": "2001:db8:1234:5678:abcd:42::9",
      "x-real-ip": "not-an-ip",
    }));
    expect(detail).toEqual({ selected: "203.0.113.0/24", forwardedLast: "203.0.113.0/24", cloudflare: "2001:db8:1234:5678::/64", realIp: null, proxyProofAccepted: false });
    expect(JSON.stringify(detail)).not.toContain("203.0.113.79");
    expect(JSON.stringify(detail)).not.toContain("abcd");
    expect(clientIpDiagnostics(new Headers({ "x-forwarded-for": "::1" })).selected).toBe("0:0:0:0::/64");
  });
});

describe("production request host", () => {
  it("refuses alternate hosts even with a forged forwarded host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    expect(requestHostAllowed(new Request("https://curvi.ai/api/jobs"))).toBe(true);
    expect(requestHostAllowed(new Request("https://curviai.onrender.com/api/jobs", {
      headers: { "x-forwarded-host": "curvi.ai" },
    }))).toBe(false);
  });
  it("keeps local tests available without weakening configured production", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(requestHostAllowed(new Request("http://localhost/api/jobs"))).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("ALLOW_DEMO_MODE", "");
    expect(requestHostAllowed(new Request("http://localhost/api/jobs"))).toBe(false);
    vi.stubEnv("ALLOW_DEMO_MODE", "1");
    expect(requestHostAllowed(new Request("http://localhost/api/jobs"))).toBe(true);
  });
});
