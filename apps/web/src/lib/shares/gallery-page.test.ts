import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GalleryEntry } from "./types";

// P18-14 on the gallery page: a team made pack says "Made by the Curvi
// team" and never carries a quote; a seller's pack says "Shared by the
// seller" with the seller's consented quote and name when there is one.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

const entries: GalleryEntry[] = [
  {
    slug: "teampack23",
    title: "Founder candle",
    category: null,
    before: null,
    after: { ref: "v_1", src: "/s/teampack23/image/v_1", alt: "Founder candle" },
    madeByTeam: true,
    quote: { text: "Should never show", name: "Founder" },
  },
  {
    slug: "sellerpack",
    title: "Oak soap",
    category: null,
    before: null,
    after: { ref: "v_2", src: "/s/sellerpack/image/v_2", alt: "Oak soap" },
    madeByTeam: false,
    quote: { text: "Listed it the same day.", name: "Sam, Oak Soap" },
  },
  {
    slug: "plainpack2",
    title: "Tea tin",
    category: null,
    before: null,
    after: { ref: "v_3", src: "/s/plainpack2/image/v_3", alt: "Tea tin" },
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/gallery",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/shares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shares")>()),
  getShareStore: () => ({ listGallery: async () => entries }),
}));

describe("gallery page labels", () => {
  it("name who made each pack and quote only sellers", async () => {
    const { default: GalleryPage } = await import("@/app/(marketing)/gallery/page");
    const html = renderToStaticMarkup(await GalleryPage());
    const labels = [...html.matchAll(/data-testid="gallery-made-by">([^<]+)</g)].map((match) => match[1]);
    expect(labels).toEqual(["Made by the Curvi team", "Shared by the seller", "Shared by the seller"]);
    expect(html).toContain("Listed it the same day.");
    expect(html).toContain("Sam, Oak Soap");
    expect(html).not.toContain("Should never show");
    expect(html.match(/data-testid="gallery-quote"/g)).toHaveLength(1);
  });
});
