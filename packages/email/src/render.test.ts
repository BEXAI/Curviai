import { describe, expect, it } from "vitest";
import { emailConfigFromEnv, marketingGaps, transactionalGaps, usablePostalAddress, bareAddress } from "./config";
import { LEAD_MARKETING_REASON, MARKETING_NOTICE, MARKETING_REASON } from "./copy";
import { emailLink, paragraphHtml, renderEmail, type EmailTemplate } from "./render";

const tip: EmailTemplate<{ name: string }> = {
  key: "test_tip",
  kind: "marketing",
  audience: "lead",
  render: (data, ctx) => ({
    subject: `A tip for ${data.name}`,
    paragraphs: [`Try this <now>: ${ctx.link("/tools/main-image-checker")}.`],
  }),
};

const ready: EmailTemplate<Record<string, never>> = {
  key: "test_ready",
  kind: "transactional",
  audience: "account",
  render: (_data, ctx) => ({ subject: "Ready", paragraphs: [`Open it: ${ctx.link("/app/new")}`] }),
};

const UNSUBSCRIBE = {
  pageUrl: "https://curvi.ai/email/unsubscribe?t=tok",
  oneClickUrl: "https://curvi.ai/api/email/unsubscribe?t=tok",
  mailto: "hello@curvi.ai",
};

describe("renderEmail", () => {
  it("gives marketing mail the notice, the one click footer, the address and both unsubscribe headers", () => {
    const email = renderEmail(tip, { name: "Ada" }, {
      siteUrl: "https://curvi.ai",
      founderName: "Sam",
      unsubscribe: UNSUBSCRIBE,
      postalAddress: "PO Box 100, Springfield, IL 62701",
    });
    expect(email.subject).toBe("A tip for Ada");
    expect(email.text).toContain(`${MARKETING_NOTICE} ${LEAD_MARKETING_REASON}`);
    expect(email.text).toContain("Unsubscribe in one click: https://curvi.ai/email/unsubscribe?t=tok");
    expect(email.text).toContain("Curvi, PO Box 100, Springfield, IL 62701");
    expect(email.text).toContain("\n\nSam\n\n");
    expect(email.headers).toEqual({
      "List-Unsubscribe": "<https://curvi.ai/api/email/unsubscribe?t=tok>, <mailto:hello@curvi.ai?subject=unsubscribe>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(email.html).toContain('<a href="https://curvi.ai/email/unsubscribe?t=tok"');
    expect(email.html).toContain("Try this &lt;now&gt;");
  });

  it("gives each audience its own true reason: a lead never reads that they signed up", () => {
    const options = { siteUrl: "https://curvi.ai", founderName: null, unsubscribe: UNSUBSCRIBE, postalAddress: "PO Box 100, Springfield, IL 62701" };
    const lead = renderEmail({ ...tip, audience: "lead" }, { name: "Ada" }, options);
    expect(lead.text).toContain(`${MARKETING_NOTICE} ${LEAD_MARKETING_REASON}`);
    expect(lead.text).not.toContain("signed up");
    const account = renderEmail({ ...tip, audience: "account" }, { name: "Ada" }, options);
    expect(account.text).toContain(`${MARKETING_NOTICE} ${MARKETING_REASON}`);
  });

  it("will not render marketing mail without the unsubscribe links or the address", () => {
    expect(() => renderEmail(tip, { name: "Ada" }, { siteUrl: "https://curvi.ai", founderName: null })).toThrow();
    expect(() =>
      renderEmail(tip, { name: "Ada" }, { siteUrl: "https://curvi.ai", founderName: null, unsubscribe: UNSUBSCRIBE, postalAddress: null }),
    ).toThrow();
  });

  it("gives transactional mail a reason line and no unsubscribe headers", () => {
    const email = renderEmail(ready, {}, { siteUrl: "https://curvi.ai", founderName: null });
    expect(email.text).toContain("You get this email because you have a Curvi account.");
    expect(email.text).not.toContain("Unsubscribe");
    expect(email.text).toContain("\n\nCurvi\n\n");
    expect(email.headers).toEqual({});
  });

  it("tags every link with the email UTM values and the template", () => {
    const url = new URL(emailLink("https://curvi.ai/", "welcome", "/signup", { source: "email" }));
    expect(url.pathname).toBe("/signup");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: "email",
      utm_source: "curvi_email",
      utm_medium: "email",
      utm_campaign: "welcome",
    });
  });

  it("keeps a full stop after a link outside the link", () => {
    expect(paragraphHtml("See https://curvi.ai/a.")).toBe('See <a href="https://curvi.ai/a" style="color:#1d4ed8">https://curvi.ai/a</a>.');
  });

  it("removes only terminal slashes from the site URL before resolving relative links", () => {
    for (const [siteUrl, pathname] of [
      ["https://curvi.ai", "/next"],
      ["https://curvi.ai///", "/next"],
      ["https://curvi.ai/base///", "/base/next"],
      ["https://curvi.ai/base///inside", "/base///inside/next"],
      ["https://curvi.ai/base///\n", "/base////next"],
    ]) {
      const url = new URL(emailLink(siteUrl, "welcome", "next"));
      expect(url.pathname, siteUrl).toBe(pathname);
      expect(url.searchParams.get("utm_campaign")).toBe("welcome");
    }
  });

  it("handles long internal and terminal slash runs without repeated suffix searches", () => {
    const slashes = "/".repeat(100_000);
    const start = performance.now();
    const internal = emailLink(`https://curvi.ai/base${slashes}inside`, "welcome", "next");
    const terminal = emailLink(`https://curvi.ai/base${slashes}`, "welcome", "next");
    const elapsed = performance.now() - start;
    expect(new URL(internal).pathname).toBe(`/base${slashes}inside/next`);
    expect(new URL(terminal).pathname).toBe("/base/next");
    // The linear scans finish in milliseconds; leave ample room for CI.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("moves exactly the supported sentence punctuation outside each link and keeps escaping", () => {
    const link = '<a href="https://curvi.ai/a?x=1&amp;y=2" style="color:#1d4ed8">https://curvi.ai/a?x=1&amp;y=2</a>';
    for (const trailing of ["", ".", ",", ";", ":", ")", ".,;:)"]) {
      expect(paragraphHtml(`See <this>: https://curvi.ai/a?x=1&y=2${trailing}\nNext`)).toBe(
        `See &lt;this&gt;: ${link}${trailing}<br>Next`,
      );
    }
    for (const ending of ["!", "?", "(", "é"]) {
      const url = `https://curvi.ai/a.,;:)${ending}`;
      expect(paragraphHtml(url)).toBe(`<a href="${url}" style="color:#1d4ed8">${url}</a>`);
    }
  });

  it("handles long punctuation runs inside and after a link without repeated suffix searches", () => {
    const punctuation = ".,;:)".repeat(20_000);
    const internal = `https://curvi.ai/${punctuation}x`;
    const start = performance.now();
    const html = paragraphHtml(`See ${internal} and https://curvi.ai/end${punctuation}`);
    const elapsed = performance.now() - start;
    expect(html).toBe(
      `See <a href="${internal}" style="color:#1d4ed8">${internal}</a> and <a href="https://curvi.ai/end" style="color:#1d4ed8">https://curvi.ai/end</a>${punctuation}`,
    );
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("email config", () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];

  it("names what each kind of email still needs, never the values", () => {
    const empty = emailConfigFromEnv(env({}));
    expect(transactionalGaps(empty)).toEqual(["RESEND_API_KEY", "LIFECYCLE_EMAIL_FROM", "LIFECYCLE_REPLY_TO"]);
    const sender = emailConfigFromEnv(
      env({
        RESEND_API_KEY: "re_x",
        LIFECYCLE_EMAIL_FROM: "Curvi <hello@updates.curvi.ai>",
        LIFECYCLE_REPLY_TO: "founder@curvi.ai",
        NEXT_PUBLIC_SITE_URL: "https://curvi.ai/",
      }),
    );
    expect(transactionalGaps(sender)).toEqual([]);
    expect(marketingGaps(sender)).toEqual(["CURVI_LINK_SECRET", "CURVI_POSTAL_ADDRESS"]);
    expect(sender.siteUrl).toBe("https://curvi.ai");
    const local = emailConfigFromEnv(
      env({ RESEND_API_KEY: "re_x", LIFECYCLE_EMAIL_FROM: "a@b.co", LIFECYCLE_REPLY_TO: "c@d.co", CURVI_LINK_SECRET: "s", CURVI_POSTAL_ADDRESS: "PO Box 100, Springfield, IL 62701" }),
    );
    expect(marketingGaps(local)).toEqual(["NEXT_PUBLIC_SITE_URL (https)"]);
  });

  it("treats a placeholder postal address as unset", () => {
    expect(usablePostalAddress("[postal address]")).toBeNull();
    expect(usablePostalAddress("TODO")).toBeNull();
    expect(usablePostalAddress("PO Box TBD")).toBeNull();
    expect(usablePostalAddress("  PO Box 100,\n Springfield, IL 62701 ")).toBe("PO Box 100, Springfield, IL 62701");
  });

  it("reads the bare address out of a display name", () => {
    expect(bareAddress("Founder <founder@curvi.ai>")).toBe("founder@curvi.ai");
    expect(bareAddress("founder@curvi.ai")).toBe("founder@curvi.ai");
    expect(bareAddress("not an address")).toBeNull();
  });
});
