import { describe, expect, it, vi } from "vitest";
import { ADS_EVENTS_URL, adsConsentGranted, registrationConversion, sendAdsConversion } from "./ads-conversions";

const env = { OPENAI_ADS_CONVERSIONS_KEY: "sk-test-key" };
const granted = "a=1; curvi_consent=granted";
const event = registrationConversion({ id: "u1", created_at: new Date(1_000_000).toISOString() }, "https://curvi.ai/signup", 1_000_500)!;

describe("ads conversions", () => {
  it("reads consent from the cookie header", () => {
    expect(adsConsentGranted(granted)).toBe(true);
    expect(adsConsentGranted("curvi_consent=denied")).toBe(false);
    expect(adsConsentGranted(null)).toBe(false);
  });

  it("builds Registration Completed only for an account created in the last day", () => {
    expect(event).toMatchObject({ id: "registration_completed:u1", type: "registration_completed", data: { type: "customer_action" } });
    const old = new Date(0).toISOString();
    expect(registrationConversion({ id: "u2", created_at: old }, "https://curvi.ai/signup", 2 * 86_400_000)).toBeNull();
    expect(registrationConversion({ id: "u3" }, "https://curvi.ai/signup")).toBeNull();
  });

  it("sends the Ads Manager request shape with the key, only with consent", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await sendAdsConversion(event, { cookieHeader: granted, fetchFn, env })).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(`${ADS_EVENTS_URL}?pid=`)).toBe(true);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-key");
    const body = JSON.parse(String(init.body));
    expect(body.validate_only).toBe(false);
    expect(body.events[0]).toMatchObject({ id: "registration_completed:u1", type: "registration_completed", action_source: "web", source_url: "https://curvi.ai/signup" });

    fetchFn.mockClear();
    expect(await sendAdsConversion(event, { cookieHeader: "curvi_consent=denied", fetchFn, env })).toBe(false);
    expect(await sendAdsConversion(event, { cookieHeader: granted, fetchFn, env: {} })).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never throws when OpenAI fails", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await sendAdsConversion(event, { cookieHeader: granted, fetchFn, env })).toBe(false);
  });
});
