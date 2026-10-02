import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnstileMode, verifyTurnstile } from "./turnstile";
const expected = { action: "support", hostname: "curvi.ai", ip: "192.0.2.10" };
beforeEach(() => { vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret"); vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site"); });
afterEach(() => vi.unstubAllEnvs());
describe("Turnstile verification", () => {
  it("sends the token and trusted IP and requires all response checks", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: true, hostname: "curvi.ai", action: "support" }));
    expect(await verifyTurnstile("token", expected, fetcher)).toBe(true);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ secret: "test-secret", response: "token", remoteip: "192.0.2.10" });
  });
  it.each([{ success: false, "error-codes": ["timeout-or-duplicate"] }, { success: true, hostname: "evil.test", action: "support" }, { success: true, hostname: "curvi.ai", action: "preview" }, { success: true }])("rejects invalid response %j", async (body) => {
    expect(await verifyTurnstile("token", expected, async () => Response.json(body))).toBe(false);
  });
  it("fails closed on network, status, missing token or missing key", async () => {
    expect(await verifyTurnstile("token", expected, async () => { throw new Error("offline"); })).toBe(false);
    expect(await verifyTurnstile("token", expected, async () => new Response("bad", { status: 500 }))).toBe(false);
    const fetcher = vi.fn();
    expect(await verifyTurnstile("", expected, fetcher)).toBe(false);
    expect(await verifyTurnstile("x".repeat(2049), expected, fetcher)).toBe(false);
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(turnstileMode()).toBe("misconfigured");
    expect(await verifyTurnstile("token", expected, fetcher)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", ""); expect(turnstileMode()).toBe("fallback");
  });
});
