import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getSpec } from "@curvi/specs";
import { mainImageCheckerSpecIds } from "@curvi/pipeline/seed";
import { checkerChannels, checkerPagePath } from "@/lib/tools/checker-rules";
import { specSlug } from "./spec-slug";

// P18-10 render checks: the checker page follows ?channel=, and every main
// spec's requirements page links to the checker with its channel preset.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const audit = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/store-audit/switch", () => ({ storeAuditEnabled: async () => audit.on }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

/** The text inside the element with this data-testid. */
function testIdText(html: string, id: string): string {
  const at = html.indexOf(`data-testid="${id}"`);
  if (at < 0) {
    return "";
  }
  const start = html.indexOf(">", at) + 1;
  return html.slice(start, html.indexOf("</", start)).replace(/<[^>]+>/g, "");
}

async function checkerHtml(channel?: string): Promise<string> {
  const { default: CheckerPage } = await import("@/app/(marketing)/tools/main-image-checker/page");
  return render(await CheckerPage({ searchParams: Promise.resolve(channel ? { channel } : {}) }));
}

describe("main image checker page", () => {
  it("defaults to Amazon and offers every checker channel in the picker", async () => {
    const html = await checkerHtml();
    expect(html).toContain("Amazon Main Image Checker");
    expect(html).toContain("Which marketplace?");
    for (const channel of checkerChannels()) {
      expect(html).toContain(`<option value="${channel.key}"`);
    }
    expect(html).toContain(`href="/channels/amazon-main/image-requirements"`);
  });

  it("follows ?channel=google: title, intro rules and the link back", async () => {
    const google = checkerChannels().find((channel) => channel.key === "google");
    expect(google).toBeDefined();
    const html = await checkerHtml("google");
    expect(html).toContain("Google Merchant Main Image Checker");
    const intro = testIdText(html, "checker-intro");
    expect(intro).toContain(`${google?.rules.fillMinPercent} to ${google?.rules.fillMaxPercent} percent`);
    expect(intro).toContain("white or transparent");
    expect(html).toContain(`href="${google?.requirementsPath}"`);
  });

  it("falls back to Amazon for an unknown channel", async () => {
    const html = await checkerHtml("nowhere");
    expect(html).toContain("Amazon Main Image Checker");
  });
});

describe("requirement pages", () => {
  it("link each offered main spec to the checker with its channel preset", async () => {
    const page = await import("@/app/(marketing)/channels/[channel]/image-requirements/page");
    for (const channel of checkerChannels()) {
      const html = render(await page.default({ params: Promise.resolve({ channel: specSlug(channel.specId) }) }));
      expect(html, channel.specId).toContain('data-testid="channel-checker"');
      expect(html, channel.specId).toContain(`href="${checkerPagePath(channel.key)}"`);
      expect(html).not.toContain('href="/tools/main-image-checker"');
    }
  });

  it("show no checker block on a spec the checker does not offer", async () => {
    const page = await import("@/app/(marketing)/channels/[channel]/image-requirements/page");
    const offered = new Set(checkerChannels().map((channel) => channel.specId));
    for (const id of [...mainImageCheckerSpecIds, "meta.feed_1x1", "amazon.secondary"]) {
      if (offered.has(id)) {
        continue;
      }
      const html = render(await page.default({ params: Promise.resolve({ channel: specSlug(getSpec(id).id) }) }));
      expect(html, id).not.toContain('data-testid="channel-checker"');
    }
  });
});

describe("store image audit page (P18-18)", () => {
  it("answers 404 while the switch is off, and the checker does not link to it", async () => {
    audit.on = false;
    const { default: AuditPage } = await import("@/app/(marketing)/tools/store-image-audit/page");
    await expect(AuditPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await checkerHtml()).not.toContain('data-testid="checker-store-audit"');
  });

  it("renders the form and names only the checker's channels once on", async () => {
    audit.on = true;
    const { default: AuditPage } = await import("@/app/(marketing)/tools/store-image-audit/page");
    const html = render(await AuditPage());
    expect(html).toContain("Shopify Store Image Audit");
    expect(html).toContain("Your Shopify store address");
    for (const channel of checkerChannels()) {
      expect(html).toContain(channel.name);
    }
    expect(await checkerHtml()).toContain('href="/tools/store-image-audit"');
    audit.on = false;
  });
});
