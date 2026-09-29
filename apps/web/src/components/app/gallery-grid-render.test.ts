import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { GalleryGrid } from "@/components/app/gallery-grid";
import type { GalleryItem } from "@/lib/library";

// PHASE_16 workstream 6: the gallery on /app/library and the job page.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

function item(overrides: Partial<GalleryItem>): GalleryItem {
  return {
    assetId: "a1",
    jobId: "j1",
    shotId: "s1",
    shotType: "main_white",
    productTitle: "Navy mug",
    channels: ["amazon.main"],
    width: 1000,
    height: 1000,
    imageUrl: "https://files.example/a1.jpg",
    downloadUrl: "/api/files/a1",
    favorite: false,
    createdAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function render(items: GalleryItem[]): string {
  return renderToStaticMarkup(
    React.createElement(GalleryGrid, { items, canFavorite: true, emptyText: "No images yet." }),
  );
}

describe("the gallery grid", () => {
  it("draws the checkerboard behind a transparent cutout only", () => {
    const html = render([
      item({ assetId: "cut", shotType: "cutout_png", imageUrl: "https://files.example/cut.png" }),
      item({ assetId: "main" }),
    ]);
    const tiles = html.split('data-testid="gallery-item"').slice(1);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toContain('data-transparent="true"');
    expect(tiles[0]).toContain("repeating-conic-gradient");
    expect(tiles[1]).not.toContain('data-transparent="true"');
    expect(tiles[1]).not.toContain("repeating-conic-gradient");
  });

  it("gives the favorite star and the filter chips a full size tap target", () => {
    const html = render([item({})]);
    const star = /<button[^>]*data-testid="favorite-toggle"[^>]*>/.exec(html)?.[0] ?? "";
    expect(star).toContain("h-11 w-11");
    expect(star).toContain("text-ink-500");
    expect(html).not.toContain("min-h-9");
  });
});
