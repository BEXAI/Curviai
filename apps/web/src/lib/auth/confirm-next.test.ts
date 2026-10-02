import { describe, expect, it } from "vitest";
import { confirmationTarget } from "./confirm-next";
const origin = "https://curvi.ai";
describe("email confirmation return", () => {
  it("unwraps the template's encoded full callback and preserves consent and attribution", () => {
    const callback = `${origin}/auth/callback?next=${encodeURIComponent("/oauth/consent?authorization_id=abc")}&attr=source`;
    const email = new URL(`${origin}/auth/confirm?token_hash=hash&type=email&next=${encodeURIComponent(callback)}`);
    const result = confirmationTarget(email.searchParams.get("next"), origin);
    expect(result.next).toBe("/oauth/consent?authorization_id=abc");
    expect(result.params.get("attr")).toBe("source");
  });
  it("accepts a local path", () => expect(confirmationTarget("/app/settings", origin).next).toBe("/app/settings"));
  it.each(["https://evil.test/path", "//evil.test/path", "/auth/callback?next=https%3A%2F%2Fevil.test", "/auth/callback?next=%2F%2Fevil.test", "javascript:alert(1)", "bare", "/\\evil.test", "/%2f%2fevil.test", "https://user@curvi.ai/app"])("rejects %s", (path) => expect(confirmationTarget(path, origin).next).toBe("/app"));
});
