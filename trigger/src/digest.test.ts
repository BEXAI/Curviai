import { describe, expect, it } from "vitest";
import {
  DemoMetricsReader,
  RESEND_EMAILS_URL,
  composeDigest,
  sendDigestEmail,
  type MonthlyMetrics,
} from "./digest";

const metrics: MonthlyMetrics = {
  month: "2026-09",
  mrrUsd: 12345.67,
  churnRate: 0.072,
  cogsUsd: 2210.4,
  grossMargin: 0.73,
};

describe("composeDigest", () => {
  it("includes MRR, churn, COGS and margin", () => {
    const email = composeDigest(metrics);
    expect(email.subject).toContain("2026-09");
    expect(email.text).toContain("MRR: $12,345.67");
    expect(email.text).toContain("Churn: 7.2%");
    expect(email.text).toContain("COGS: $2,210.40");
    expect(email.text).toContain("Gross margin: 73.0%");
    expect(email.text).not.toContain("demo numbers");
  });

  it("flags demo numbers from the demo reader", async () => {
    const demo = await new DemoMetricsReader("2026-09").read();
    const email = composeDigest(demo);
    expect(demo.demo).toBe(true);
    expect(email.text).toContain("demo numbers");
  });
});

describe("sendDigestEmail", () => {
  const email = composeDigest(metrics);

  it("returns a setup notice without an api key", async () => {
    const result = await sendDigestEmail(email, { to: "founder@example.com" });
    expect(result.sent).toBe(false);
    expect(result.notice).toContain("RESEND_API_KEY");
  });

  it("returns a setup notice without a recipient", async () => {
    const result = await sendDigestEmail(email, { apiKey: "re_test" });
    expect(result.sent).toBe(false);
    expect(result.notice).toContain("METRICS_DIGEST_TO");
  });

  it("posts to the Resend REST API with a bearer token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
    };
    const result = await sendDigestEmail(email, {
      apiKey: "re_test",
      to: "founder@example.com",
      from: "Curvi <reports@curvi.ai>",
      fetchImpl,
    });
    expect(result).toEqual({ sent: true, id: "email_123" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_EMAILS_URL);
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.to).toEqual(["founder@example.com"]);
    expect(body.subject).toBe(email.subject);
    expect(body.text).toBe(email.text);
  });

  it("reports a failed send with the status code", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response("invalid api key", { status: 401 });
    const result = await sendDigestEmail(email, {
      apiKey: "re_bad",
      to: "founder@example.com",
      fetchImpl,
    });
    expect(result.sent).toBe(false);
    expect(result.notice).toContain("401");
  });
});
