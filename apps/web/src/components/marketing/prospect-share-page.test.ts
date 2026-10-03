import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicShare } from "@/lib/shares/types";

// P18-04 on the share page: a prospect pack is titled "{store} listing
// pack, made by Curvi"; its live claim link swaps Make mine for "Make it
// yours" with source=concierge and the claim token; the footer offers the
// takedown to the link's holder and the email address to everyone else.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

const TOKEN = "0123456789abcdef0123456789abcdef01234567";
const share: PublicShare = {
  slug: "prospect23",
  kind: "pack",
  title: "Lavender candle",
  category: null,
  before: null,
  after: { ref: "v_1", src: "/s/prospect23/image/v_1", alt: "Lavender candle", specId: "amazon.main" },
  images: [],
  inGallery: false,
  illustration: false,
  sizedForChannels: false,
};
const view = vi.hoisted(() => ({
  current: null as null | { store: string; claimToken: string | null; takedownToken: string | null },
  calls: [] as unknown[],
  headers: new Headers({ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" }),
  recordView: vi.fn(async () => undefined),
}));

vi.mock("next/headers", () => ({ headers: async () => view.headers }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/s/prospect23",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/shares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shares")>()),
  getShareStore: () => ({ getPublic: async () => share, recordView: view.recordView }),
}));
vi.mock("@/lib/prospects/runtime", () => ({
  loadProspectShareView: async (_slug: string, claim: unknown) => {
    view.calls.push(claim);
    return view.current;
  },
}));

const { default: SharePage, generateMetadata } = await import("@/app/(marketing)/s/[slug]/page");

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="(\/signup[^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));
}

async function render(claim?: string): Promise<string> {
  return renderToStaticMarkup(
    await SharePage({ params: Promise.resolve({ slug: "prospect23" }), searchParams: Promise.resolve({ claim }) }),
  );
}

beforeEach(() => {
  view.current = null;
  view.calls = [];
  view.recordView.mockClear();
  view.headers = new Headers({ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" });
});

describe("share view counting", () => {
  it("counts a real browser page view", async () => {
    await render();
    expect(view.recordView).toHaveBeenCalledWith("prospect23");
  });

  it.each(["CurviIndexNowBot/1.0 (+https://curvi.ai)", "bingbot/2.0", ""])("does not count crawler or unidentified visits: %s", async (userAgent) => {
    view.headers.set("user-agent", userAgent);
    await render();
    expect(view.recordView).not.toHaveBeenCalled();
  });

  it("does not count browser prefetches", async () => {
    view.headers.set("sec-purpose", "prefetch;prerender");
    await render();
    expect(view.recordView).not.toHaveBeenCalled();
  });
});

describe("a prospect's share page", () => {
  it("offers Make it yours with the claim on its live link", async () => {
    view.current = { store: "Juniper Candles", claimToken: TOKEN, takedownToken: TOKEN };
    const html = await render(TOKEN);
    expect(view.calls).toContain(TOKEN);
    expect(html).toContain("Juniper Candles listing pack, made by Curvi");
    expect(html).toContain("This pack was made for Juniper Candles from your current listing photo.");
    expect(hrefs(html)).toEqual([`/signup?source=concierge&claim=${TOKEN}`]);
    expect(html).not.toContain("Make mine");
    expect(html).toContain('data-testid="prospect-takedown"');
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "prospect23" }) });
    expect(String(metadata.title)).toContain("Juniper Candles listing pack, made by Curvi");
    expect(metadata.robots).toMatchObject({ index: false });
  });

  it("keeps Make mine and the email footer without a live link", async () => {
    view.current = { store: "Juniper Candles", claimToken: null, takedownToken: null };
    const html = await render();
    expect(html).toContain("Juniper Candles listing pack, made by Curvi");
    expect(hrefs(html)).toEqual(["/signup?source=share&s=prospect23"]);
    expect(html).not.toContain('data-testid="prospect-takedown"');
    expect(html).toContain("Email hello@curvi.ai and we take it down.");
  });

  it("is an ordinary share page for any other pack", async () => {
    const html = await render(TOKEN);
    expect(html).toContain("Lavender candle");
    expect(html).not.toContain("made by Curvi");
    expect(html).not.toContain('data-testid="prospect-footer"');
  });
});
