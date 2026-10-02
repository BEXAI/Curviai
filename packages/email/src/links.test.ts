import { describe, expect, it } from "vitest";
import { normalizedEmailKey } from "./keys";
import { signLink, unsubscribeToken, verifyLink, verifyUnsubscribeToken } from "./links";

const SECRET = "test-link-secret-0123456789";
const KEY = normalizedEmailKey("seller@example.com") as string;

describe("signed links", () => {
  it("verifies a token for its own purpose and secret", () => {
    const token = signLink(SECRET, "feedback", "job_123");
    expect(verifyLink(SECRET, "feedback", token)).toBe("job_123");
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("refuses another purpose, another secret, a changed subject and a broken token", () => {
    const token = signLink(SECRET, "feedback", "job_123");
    expect(verifyLink(SECRET, "unsub", token)).toBeNull();
    expect(verifyLink("another-secret", "feedback", token)).toBeNull();
    expect(verifyLink(SECRET, "feedback", token.replace("job_123", "job_124"))).toBeNull();
    expect(verifyLink(SECRET, "feedback", `${token}x`)).toBeNull();
    expect(verifyLink(SECRET, "feedback", "feedback.job_123")).toBeNull();
    expect(verifyLink(SECRET, "feedback", 42)).toBeNull();
    expect(verifyLink(null, "feedback", token)).toBeNull();
    expect(verifyLink("", "feedback", token)).toBeNull();
  });

  it("will not sign without a secret or with characters a link cannot carry", () => {
    expect(() => signLink("", "feedback", "x")).toThrow();
    expect(() => signLink(SECRET, "Feedback", "x")).toThrow();
    expect(() => signLink(SECRET, "feedback", "a b")).toThrow();
  });
});

describe("unsubscribe tokens", () => {
  it("carry the recipient key, never the address", () => {
    const token = unsubscribeToken(SECRET, KEY);
    expect(token).not.toContain("@");
    expect(token).not.toContain("seller");
    expect(verifyUnsubscribeToken(SECRET, token)).toBe(KEY);
  });

  it("refuse to sign an address and refuse a forged token", () => {
    expect(() => unsubscribeToken(SECRET, "seller@example.com")).toThrow();
    const forged = `unsub.${KEY}.${"A".repeat(43)}`;
    expect(verifyUnsubscribeToken(SECRET, forged)).toBeNull();
    // A valid link for another purpose is not an unsubscribe link.
    expect(verifyUnsubscribeToken(SECRET, signLink(SECRET, "feedback", KEY))).toBeNull();
  });
});
