import { describe, expect, it } from "vitest";
import { lifecycleEmailWarning } from "./health";

// /api/health's lifecycle_email_not_configured (P18-06).

const FULL: Record<string, string> = {
  RESEND_API_KEY: "re_x",
  LIFECYCLE_EMAIL_FROM: "Curvi <hello@updates.curvi.ai>",
  LIFECYCLE_REPLY_TO: "founder@curvi.ai",
  CURVI_LINK_SECRET: "secret",
  CURVI_POSTAL_ADDRESS: "PO Box 100, Springfield, IL 62701",
  NEXT_PUBLIC_SITE_URL: "https://curvi.ai",
};

const env = (overrides: Record<string, string | undefined> = {}) => (name: string) =>
  name in overrides ? overrides[name] : FULL[name];

describe("lifecycleEmailWarning", () => {
  it("says nothing while the switch is off, whatever is missing", () => {
    expect(lifecycleEmailWarning(false, () => undefined)).toBeNull();
  });

  it("says nothing when everything is set", () => {
    expect(lifecycleEmailWarning(true, env())).toBeNull();
  });

  it("names a missing sender variable, never its value", () => {
    const warning = lifecycleEmailWarning(true, env({ LIFECYCLE_EMAIL_FROM: undefined }));
    expect(warning?.code).toBe("lifecycle_email_not_configured");
    expect(warning?.message).toContain("LIFECYCLE_EMAIL_FROM is not set, so no customer email goes out");
    expect(warning?.message).not.toContain("re_x");
  });

  it("says marketing waits while the postal address is a placeholder", () => {
    const warning = lifecycleEmailWarning(true, env({ CURVI_POSTAL_ADDRESS: "[postal address]" }));
    expect(warning?.message).toContain("CURVI_POSTAL_ADDRESS is not set, so only transactional email goes out");
  });
});
