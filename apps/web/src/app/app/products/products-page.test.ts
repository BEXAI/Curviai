import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ProductLibraryEntry } from "@/lib/services/types";
import {
  newPackHref,
  packChannelsLine,
  packCreditsLine,
  packDateLine,
  productFactsLine,
} from "@/lib/product-library";

// The products library: each product with its photos, saved details and
// pack history (date, status, channels, credits), and a link that opens the
// new pack form with the product picked.

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest compiles it to
  // React.createElement calls against a global React.
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const state = vi.hoisted(() => ({ signedIn: true, library: [] as unknown[] }));

vi.mock("@/lib/services", () => ({
  getServices: () => ({
    ensureWorkspace: async () =>
      state.signedIn ? { id: "ws_1", name: "Test shop", plan: "growth", creditBalance: 40, role: "owner" } : null,
    listProductLibrary: async () => state.library,
  }),
}));

const MUG: ProductLibraryEntry = {
  id: "00000000-0000-4000-8000-000000000101",
  title: "Pour over mug",
  mode: "listing",
  category: "home_kitchen",
  createdAt: "2026-09-20T09:00:00.000Z",
  sku: "MUG-12",
  boxContents: ["Mug", "Pour over cone"],
  comparisonFacts: [],
  photoCount: 3,
  packs: [
    {
      id: "00000000-0000-4000-8000-00000000a002",
      status: "generating",
      channels: ["shopify.product"],
      createdAt: "2026-09-28T10:00:00.000Z",
      creditsReserved: 12,
      creditsCharged: 0,
    },
    {
      id: "00000000-0000-4000-8000-00000000a001",
      status: "done",
      channels: ["amazon.main", "amazon.secondary", "meta.feed_1x1"],
      createdAt: "2026-09-21T10:00:00.000Z",
      creditsReserved: 20,
      creditsCharged: 14.5,
    },
  ],
};

const LAMP: ProductLibraryEntry = {
  ...MUG,
  id: "00000000-0000-4000-8000-000000000102",
  title: "Desk lamp",
  sku: null,
  boxContents: [],
  photoCount: 1,
  packs: [],
};

async function renderPage(): Promise<string> {
  const { default: ProductsPage } = await import("./page");
  return renderToStaticMarkup(await ProductsPage());
}

describe("products library copy", () => {
  it("names the channel families a pack covered, once each", () => {
    expect(packChannelsLine(["amazon.main", "amazon.secondary", "meta.feed_1x1", "google.merchant.main"])).toBe(
      "Amazon, Meta, Google Merchant",
    );
    expect(packChannelsLine(["video.social_9x16"])).toBe("Video");
    expect(packChannelsLine([])).toBe("No channels");
  });

  it("shows the hold while a pack runs and the charge once it settled", () => {
    expect(packCreditsLine({ status: "qc", creditsReserved: 12, creditsCharged: 0 })).toBe("12 credits held");
    expect(packCreditsLine({ status: "done", creditsReserved: 20, creditsCharged: 14.5 })).toBe("14.5 credits charged");
    expect(packCreditsLine({ status: "done", creditsReserved: 2, creditsCharged: 1 })).toBe("1 credit charged");
    expect(packCreditsLine({ status: "failed", creditsReserved: 8, creditsCharged: 0 })).toBe("Nothing charged");
    expect(packCreditsLine({ status: "canceled", creditsReserved: 8, creditsCharged: 0 })).toBe("Nothing charged");
  });

  it("formats dates the same in every time zone", () => {
    expect(packDateLine("2026-09-28T23:30:00.000Z")).toBe("Sep 28, 2026");
  });

  it("sums up photos and SKU, and links to a new pack for the product", () => {
    expect(productFactsLine({ photoCount: 1, sku: null })).toBe("1 photo");
    expect(productFactsLine({ photoCount: 3, sku: "MUG-12" })).toBe("3 photos, SKU MUG-12");
    expect(newPackHref("abc")).toBe("/app/new?product=abc");
  });
});

describe("products page", () => {
  it("lists each product with its pack history and a new pack link", async () => {
    state.signedIn = true;
    state.library = [MUG, LAMP];
    const html = await renderPage();
    expect(html).toContain("Pour over mug");
    expect(html).toContain("3 photos, SKU MUG-12");
    expect(html).toContain("In the box: Mug, Pour over cone");
    expect(html).toContain(`href="/app/new?product=${MUG.id}"`);
    expect(html).toContain(`href="/app/new?product=${LAMP.id}"`);
    expect(html.match(/data-testid="pack-history-row"/g)).toHaveLength(2);
    expect(html).toContain("Sep 28, 2026");
    expect(html).toContain("Amazon, Meta");
    expect(html).toContain("14.5 credits charged");
    expect(html).toContain("12 credits held");
    expect(html).toContain(`href="/app/jobs/${MUG.packs[1].id}"`);
    expect(html).toContain("No packs yet.");
  });

  it("shows an empty state with a way to start", async () => {
    state.signedIn = true;
    state.library = [];
    const html = await renderPage();
    expect(html).toContain('data-testid="products-empty"');
    expect(html).toContain("No products yet. Your first pack creates one.");
  });

  it("asks a signed out visitor to log in", async () => {
    state.signedIn = false;
    const html = await renderPage();
    expect(html).toContain("Sign in to see your products");
    expect(html).toContain("/login?next=/app/products");
  });
});
