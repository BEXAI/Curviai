import { describe, expect, it } from "vitest";
import { prepareErrorEnvelope } from "./tunnel";
const dsn = "https://abc123@o123.ingest.us.sentry.io/456";
const envelope = (target = dsn, item = "event") => `${JSON.stringify({ dsn: target })}\n${JSON.stringify({ type: item })}\n${JSON.stringify({ message: "Test", request: { headers: { authorization: "secret" }, data: { private: "body" } }, user: { email: "private@example.test" } })}`;
describe("single-project error tunnel", () => {
  it("removes personal data and forwards only to the configured ingest origin", () => {
    const result = prepareErrorEnvelope(envelope(), dsn);
    expect(result?.url).toBe("https://o123.ingest.us.sentry.io/api/456/envelope/?sentry_key=abc123&sentry_version=7");
    expect(result?.body).not.toContain("secret");
    expect(result?.body).not.toContain("private@example.test");
  });
  it("refuses arbitrary projects, SSRF targets and unsupported envelope items", () => {
    expect(prepareErrorEnvelope(envelope(dsn.replace("456", "789")), dsn)).toBeNull();
    expect(prepareErrorEnvelope(envelope("https://abc@localhost/456"), "https://abc@localhost/456")).toBeNull();
    expect(prepareErrorEnvelope(envelope(dsn, "attachment"), dsn)).toBeNull();
    expect(prepareErrorEnvelope(`${envelope()}\nextra`, dsn)).toBeNull();
    expect(prepareErrorEnvelope(envelope(), undefined)).toBeNull();
  });
});
