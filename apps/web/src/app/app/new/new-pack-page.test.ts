import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TierFeature, TierKey } from "@curvi/pipeline/seed";
import { listSpecs } from "@curvi/specs";
import { checkChannelEntitlements } from "@/lib/entitlements";
import { newPackChannelOptions } from "./channel-options";

// The new pack form must never offer a channel createJob refuses: a channel
// whose feature is not live shows Coming soon and cannot be picked, and one
// outside the plan links to billing (Phase 10 decision 1). The server check
// in createJob stays; this covers the form side.

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest compiles it to
  // React.createElement calls against a global React.
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const page = vi.hoisted(() => ({ plan: "growth" }));

vi.mock("@/lib/services", () => ({
  getServices: () => ({
    ensureWorkspace: async () => ({
      id: "ws_1",
      name: "Test shop",
      plan: page.plan,
      creditBalance: 40,
      role: "owner",
    }),
    listProducts: async () => [],
  }),
}));

const ALL_TIERS: TierKey[] = ["free", "starter", "growth", "pro", "agency"];

describe("newPackChannelOptions", () => {
  it("lists every registry channel with the verdict createJob would give it", () => {
    const lives: Array<(feature: TierFeature) => boolean> = [
      () => false,
      (feature) => feature === "templatedVideo",
      () => true,
    ];
    for (const isLive of lives) {
      for (const tier of ALL_TIERS) {
        const options = newPackChannelOptions(tier, isLive);
        expect(options.map((o) => o.id)).toEqual(listSpecs().map((s) => s.id));
        for (const option of options) {
          const accepted = checkChannelEntitlements([option.id], tier, isLive).ok;
          expect(option.availability === "available", `${option.id} on ${tier}`).toBe(accepted);
        }
      }
    }
  });

  it("marks video Coming soon on every plan today", () => {
    for (const tier of ALL_TIERS) {
      const video = newPackChannelOptions(tier).filter((o) => o.id.startsWith("video."));
      expect(video.length).toBeGreaterThan(0);
      expect(video.every((o) => o.availability === "coming_soon" && o.upgradeTo === null)).toBe(true);
    }
  });

  it("names the plan to upgrade to once a video feature ships outside this plan", () => {
    const templated = (feature: TierFeature) => feature === "templatedVideo";
    const listing = newPackChannelOptions("free", templated).find((o) => o.id === "video.amazon_listing");
    expect(listing).toMatchObject({ availability: "upgrade_required", upgradeTo: "starter" });
  });
});

async function renderPage(): Promise<string> {
  const { default: NewPackPage } = await import("./page");
  const element = await NewPackPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element);
}

/** The markup of one channel row, found by its test id. */
function channelRow(html: string, id: string): string {
  const start = html.indexOf(`data-testid="channel-${id}"`);
  expect(start, `row for ${id}`).toBeGreaterThan(-1);
  const end = html.indexOf('data-testid="channel-', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

describe("/app/new", () => {
  it("shows video channels with a Coming soon label and a disabled checkbox", async () => {
    const html = await renderPage();
    for (const id of ["video.social_9x16", "video.amazon_listing"]) {
      const row = channelRow(html, id);
      expect(row).toContain('disabled=""');
      expect(row).toContain("Coming soon");
      expect(row).not.toContain('checked=""');
    }
  });

  it("keeps image channels pickable, with the defaults checked", async () => {
    const html = await renderPage();
    const main = channelRow(html, "amazon.main");
    expect(main).not.toContain('disabled=""');
    expect(main).toContain('checked=""');
    expect(main).not.toContain("Coming soon");
    const pin = channelRow(html, "pinterest.pin");
    expect(pin).not.toContain('disabled=""');
    expect(pin).not.toContain('checked=""');
  });

  it("does the same on a plan that includes video, since video does not ship yet", async () => {
    page.plan = "agency";
    try {
      const html = await renderPage();
      expect(channelRow(html, "video.social_9x16")).toContain("Coming soon");
      expect(html).not.toContain('data-testid="channel-upgrade"');
    } finally {
      page.plan = "growth";
    }
  });
});
