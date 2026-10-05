import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import sitemap from "@/app/sitemap";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SUPPORT_EMAIL, SUPPORT_RESPONSE_TIME, supportCopy } from "@/components/marketing/support-copy";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import { assistantPrivacy } from "./privacy/privacy-copy";
import PrivacyPage from "./privacy/page";
import SupportPage, { metadata as supportMetadata } from "./support/page";
import TermsPage from "./terms/page";

// PHASE_19 P19-23: the support, privacy and terms pages the plugin listing
// links (OpenAI O3: all four URLs are required for MCP review).

// The web tsconfig keeps JSX as is for Next.js, so Vitest compiles it to
// React.createElement calls; the pages render while the suites are
// collected, so the global is set first.
(globalThis as { React?: typeof React }).React = React;

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/supabase/server", () => ({ getSessionUser: async () => null }));

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

describe("/support", () => {
  let html: string;
  beforeAll(async () => { html = renderToStaticMarkup(await SupportPage()); });

  it("gives the email, the response time and what to include", () => {
    expect(text(html)).toContain(
      `Need help? Email ${SUPPORT_EMAIL} and we answer within ${SUPPORT_RESPONSE_TIME}. Include your workspace name and, for a pack, the pack id ChatGPT showed you.`,
    );
    expect(html).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
  });

  it("links the help center, Connected apps, privacy and terms", () => {
    for (const href of ["/help", "/app/settings/connections", "/privacy", "/terms"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("is a canonical page in the sitemap and the footer", async () => {
    expect(supportMetadata.alternates?.canonical).toBe("/support");
    expect((await sitemap()).map((entry) => new URL(entry.url).pathname)).toContain("/support");
    expect(renderToStaticMarkup(React.createElement(SiteFooter))).toContain('href="/support"');
  });

  it("follows the copy rules and claims nothing that is not live", () => {
    for (const value of Object.values(supportCopy)) {
      expect(rule9Problems(value), value).toEqual([]);
      expect(unqualifiedClaims(value), value).toEqual([]);
    }
  });
});

describe("/privacy", () => {
  const html = renderToStaticMarkup(React.createElement(PrivacyPage));

  it("carries the assistants section with every item it lists", () => {
    const page = text(html);
    expect(page).toContain(assistantPrivacy.heading);
    for (const item of assistantPrivacy.sent) {
      expect(page).toContain(item);
    }
    expect(html).toContain('data-testid="privacy-assistants"');
    expect(html).toContain('data-testid="privacy-retention"');
    // The visitor count section from site-visitors stays.
    expect(html).toContain('data-testid="privacy-visitor-count"');
  });
});

describe("/terms", () => {
  const html = renderToStaticMarkup(React.createElement(TermsPage));

  it("covers connected assistants and their credits", () => {
    expect(text(html)).toContain(
      "You can connect Curvi to an assistant such as ChatGPT. Actions it takes in your workspace with your permission count as yours, and credits it spends are charged the same way as in the app.",
    );
    expect(text(html)).toContain("Last updated October 5, 2026");
  });
});
