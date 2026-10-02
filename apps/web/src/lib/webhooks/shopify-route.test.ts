import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEBHOOK_MAX_BYTES } from "@/lib/http/read-body";

// POST /api/webhooks/shopify: the secret, the body cap and the HMAC over the
// raw body all gate the request before anything is parsed or routed.

const SECRET = "shpss_route_test";

vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));

const { POST } = await import("@/app/api/webhooks/shopify/route");

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
}

function request(body: string, headers: Record<string, string>): Request {
  return new Request("https://curvi.ai/api/webhooks/shopify", { method: "POST", headers, body });
}

// Key order and spacing a JSON.stringify round trip would not keep.
const RAW = '{ "shop_domain": "demo.myshopify.com",  "shop_id": 1 }';

function gdprHeaders(body: string): Record<string, string> {
  return {
    "x-shopify-hmac-sha256": sign(body),
    "x-shopify-topic": "shop/redact",
    "x-shopify-shop-domain": "demo.myshopify.com",
    "x-shopify-webhook-id": "wh_route_1",
  };
}

beforeEach(() => {
  vi.stubEnv("SHOPIFY_API_SECRET", SECRET);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/webhooks/shopify", () => {
  it("acknowledges a GDPR topic signed over the raw body", async () => {
    const response = await POST(request(RAW, gdprHeaders(RAW)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acknowledged: true, topic: "shop/redact" });
  });

  it("refuses a tampered body with 401", async () => {
    const response = await POST(request(RAW.replace("1 }", "2 }"), gdprHeaders(RAW)));
    expect(response.status).toBe(401);
  });

  it("refuses a missing signature with 401", async () => {
    const { "x-shopify-hmac-sha256": _omit, ...headers } = gdprHeaders(RAW);
    expect((await POST(request(RAW, headers))).status).toBe(401);
  });

  it("refuses a signed delivery with no webhook id with 400", async () => {
    const { "x-shopify-webhook-id": _omit, ...headers } = gdprHeaders(RAW);
    expect((await POST(request(RAW, headers))).status).toBe(400);
  });

  it("refuses a body over the cap with 413", async () => {
    const big = "x".repeat(WEBHOOK_MAX_BYTES + 1);
    expect((await POST(request(big, gdprHeaders(big)))).status).toBe(413);
  });

  it("answers 503 while SHOPIFY_API_SECRET is unset", async () => {
    vi.stubEnv("SHOPIFY_API_SECRET", "");
    expect((await POST(request(RAW, gdprHeaders(RAW)))).status).toBe(503);
  });
});
