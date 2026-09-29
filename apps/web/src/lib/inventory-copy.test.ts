import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { InventoryCard } from "@/components/app/inventory-card";
import { inventoryLines, inventoryView, pickedLine } from "./inventory-copy";

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

const item = (label: string, colorName: string, status: string) => ({
  label,
  labelSource: "intake",
  box: { x: 0, y: 0, width: 0.5, height: 0.5 },
  areaShare: 0.1,
  aspectRatio: 2,
  shape: "tall",
  colorHex: "#000000",
  colorName,
  status,
});

describe("inventory copy", () => {
  it("lists what a photo with two products held and what the pack did with each", () => {
    const view = inventoryView({
      version: 1,
      photos: [{ mediaId: "ws/a/src/p1", items: [item("blue tall bottle", "blue", "featured"), item("red tall bottle", "red", "removed")] }],
    });
    expect(view).toEqual([
      {
        items: [
          { label: "blue tall bottle", color: "blue", shape: "tall", status: "featured" },
          { label: "red tall bottle", color: "red", shape: "tall", status: "removed" },
        ],
      },
    ]);
    expect(inventoryLines(view)).toEqual(["Found 2 products: blue tall bottle (featured), red tall bottle (removed)"]);
  });

  it("says nothing about a photo with one product, and names the photo when several need a line", () => {
    const view = inventoryView({
      version: 1,
      photos: [
        { items: [item("mug", "white", "featured")] },
        { items: [item("mug", "white", "featured"), item("spoon", "gray", "removed")] },
        { items: [item("box", "brown", "kept"), item("cable", "black", "kept")] },
      ],
    });
    expect(inventoryLines(view)).toEqual([
      "Photo 2. Found 2 products: mug (featured), spoon (removed)",
      "Photo 3. Found 2 products: box (kept), cable (kept)",
    ]);
    for (const line of inventoryLines(view)) {
      expect(line).not.toMatch(/[–—]| - |->/);
    }
  });

  it("renders a card with each product and its status, and nothing for a single product", () => {
    const two = inventoryView({
      photos: [{ items: [item("blue tall bottle", "blue", "featured"), item("red tall bottle", "red", "removed")] }],
    });
    const html = renderToStaticMarkup(React.createElement(InventoryCard, { inventory: two }));
    expect(html).toContain("Found 2 products: blue tall bottle (featured), red tall bottle (removed)");
    expect(html).toContain("Featured");
    expect(html).toContain("Removed");
    const one = inventoryView({ photos: [{ items: [item("mug", "white", "featured")] }] });
    expect(renderToStaticMarkup(React.createElement(InventoryCard, { inventory: one }))).toBe("");
    expect(renderToStaticMarkup(React.createElement(InventoryCard, { inventory: null }))).toBe("");
  });

  it("says when the product was picked by looking at the photo, only for a vision pick", () => {
    const vision = { choice: 2, confidence: "high", reason: "Only the blue bottle has a gold cap.", outcome: "accepted" };
    const picked = inventoryView({
      photos: [{ rule: "vision", vision, items: [item("red tall object", "red", "removed"), item("blue tall object", "blue", "featured")] }],
    });
    expect(picked?.[0].pickedReason).toBe("Only the blue bottle has a gold cap.");
    expect(pickedLine(picked![0])).toBe("Picked by looking at the photo: Only the blue bottle has a gold cap.");
    const html = renderToStaticMarkup(React.createElement(InventoryCard, { inventory: picked }));
    expect(html).toContain("Picked by looking at the photo: Only the blue bottle has a gold cap.");
    // A refused answer is kept on the job but never shown.
    const refused = inventoryView({
      photos: [{ rule: "ambiguous", vision: { ...vision, outcome: "low_confidence" }, items: [item("a", "red", "kept"), item("b", "blue", "kept")] }],
    });
    expect(refused?.[0].pickedReason).toBeUndefined();
    expect(pickedLine(refused![0])).toBeNull();
  });

  it("drops anything malformed", () => {
    expect(inventoryView(null)).toBeNull();
    expect(inventoryView({ photos: "x" })).toBeNull();
    expect(inventoryView({ photos: [{ items: [{ label: 3, status: "featured" }, { label: "a", status: "gone" }] }] })).toEqual([
      { items: [] },
    ]);
    expect(inventoryLines(null)).toEqual([]);
  });
});
