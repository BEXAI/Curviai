import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RESEND_EMAILS_URL,
  parseResendEvent,
  postResendEmail,
  safeErrorText,
  suppressionForEvent,
  verifyResendWebhook,
} from "./resend";

const EMAIL = {
  from: "Curvi <hello@updates.curvi.ai>",
  to: "seller@example.com",
  replyTo: "founder@curvi.ai",
  subject: "Your Curvi account is ready",
  text: "Hi",
  html: "<p>Hi</p>",
  headers: { "List-Unsubscribe": "<https://curvi.ai/api/email/unsubscribe?t=x>" },
};

describe("postResendEmail", () => {
  it("posts the documented shape with an idempotency key and a user agent", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const result = await postResendEmail("re_test", EMAIL, {
      idempotencyKey: "welcome:ws-1",
      timeoutMs: 1000,
      fetchImpl: async (url, init) => {
        seen = { url, init: init ?? {} };
        return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
      },
    });
    expect(result).toEqual({ ok: true, id: "email-1" });
    expect(seen!.url).toBe(RESEND_EMAILS_URL);
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    expect(headers["Idempotency-Key"]).toBe("welcome:ws-1");
    expect(headers["User-Agent"]).toMatch(/curvi/);
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      from: EMAIL.from,
      to: ["seller@example.com"],
      subject: EMAIL.subject,
      text: "Hi",
      html: "<p>Hi</p>",
      reply_to: "founder@curvi.ai",
      headers: EMAIL.headers,
    });
  });

  it("calls a 429, a 5xx and no answer retryable, a 422 not, and never keeps the address", async () => {
    const answer = (status: number, body: string) => async () => new Response(body, { status });
    const limited = await postResendEmail("re", EMAIL, { idempotencyKey: "k", timeoutMs: 1000, fetchImpl: answer(429, "slow down") });
    expect(limited).toMatchObject({ ok: false, status: 429, retryable: true });
    const down = await postResendEmail("re", EMAIL, { idempotencyKey: "k", timeoutMs: 1000, fetchImpl: answer(503, "") });
    expect(down).toMatchObject({ ok: false, retryable: true });
    const invalid = await postResendEmail("re", EMAIL, {
      idempotencyKey: "k",
      timeoutMs: 1000,
      fetchImpl: answer(422, '{"message":"Invalid `to` field: seller@example.com"}'),
    });
    expect(invalid).toMatchObject({ ok: false, status: 422, retryable: false });
    expect(JSON.stringify(invalid)).not.toContain("seller@example.com");
    const offline = await postResendEmail("re", EMAIL, {
      idempotencyKey: "k",
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(offline).toMatchObject({ ok: false, status: null, retryable: true });
  });

  it("strips addresses from error text", () => {
    expect(safeErrorText("bad: a.b+c@example.com, and x@y.io")).toBe("bad: [address], and [address]");
  });
});

const SECRET_BYTES = Buffer.from("resend-webhook-test-secret-bytes");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

function signed(body: string, id = "msg_1", timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = createHmac("sha256", SECRET_BYTES).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { id, timestamp, signature: `v1,${signature}` };
}

describe("verifyResendWebhook", () => {
  const body = JSON.stringify({ type: "email.bounced", data: { to: ["a@example.com"] } });

  it("accepts the Svix signature over id, timestamp and the raw body", () => {
    expect(verifyResendWebhook(SECRET, signed(body), body)).toBe(true);
    const headers = signed(body);
    expect(verifyResendWebhook(SECRET, { ...headers, signature: `v1,AAAA ${headers.signature}` }, body)).toBe(true);
  });

  it("refuses a changed body, another secret, an old timestamp and missing headers", () => {
    expect(verifyResendWebhook(SECRET, signed(body), `${body} `)).toBe(false);
    expect(verifyResendWebhook(`whsec_${Buffer.from("other").toString("base64")}`, signed(body), body)).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect(verifyResendWebhook(SECRET, signed(body, "msg_1", old), body)).toBe(false);
    expect(verifyResendWebhook(SECRET, { id: null, timestamp: null, signature: null }, body)).toBe(false);
    expect(verifyResendWebhook(SECRET, { ...signed(body), signature: "v2,abc" }, body)).toBe(false);
  });
});

describe("Resend events", () => {
  it("suppresses all mail after a bounce, a complaint or Resend's own suppression", () => {
    const bounce = parseResendEvent(
      JSON.stringify({ type: "email.bounced", data: { to: ["a@example.com"], bounce: { type: "Permanent", subType: "General" } } }),
    );
    expect(bounce).toEqual({ type: "email.bounced", recipients: ["a@example.com"], bounceType: "Permanent" });
    expect(suppressionForEvent(bounce!)).toEqual({ scope: "all", reason: "bounced" });
    const complaint = parseResendEvent(JSON.stringify({ type: "email.complained", data: { to: ["b@example.com"] } }));
    expect(suppressionForEvent(complaint!)).toEqual({ scope: "all", reason: "complained" });
    const suppressed = parseResendEvent(JSON.stringify({ type: "email.suppressed", data: { to: "c@example.com" } }));
    expect(suppressed?.recipients).toEqual(["c@example.com"]);
    expect(suppressionForEvent(suppressed!)).toEqual({ scope: "all", reason: "bounced" });
  });

  it("ignores a transient bounce, a delivery and a body that is not an event", () => {
    const transient = parseResendEvent(JSON.stringify({ type: "email.bounced", data: { to: ["a@example.com"], bounce: { type: "Transient" } } }));
    expect(suppressionForEvent(transient!)).toBeNull();
    expect(suppressionForEvent(parseResendEvent(JSON.stringify({ type: "email.delivered", data: { to: ["a@example.com"] } }))!)).toBeNull();
    expect(parseResendEvent("not json")).toBeNull();
    expect(parseResendEvent(JSON.stringify({ data: {} }))).toBeNull();
  });
});
