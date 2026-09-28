import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ANGLE_LABELS, NewPackForm, nextAngle, sellerDetailsProblem } from "@/components/app/new-pack-form";
import { estimatePackCredits } from "@/lib/pack-estimate";

// The new pack form's seller inputs: every photo gets a role, starting with
// the first role no photo has yet; the optional details are checked with the
// same limits the API applies; a picked product brings its saved details.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

describe("photo roles", () => {
  it("starts each new photo at the first role no photo has", () => {
    expect(nextAngle([])).toBe("front");
    expect(nextAngle(["front"])).toBe("back");
    expect(nextAngle(["front", "back", "side"])).toBe("detail");
    expect(nextAngle(["front", "back", "side", "detail", "in_the_box", "scale"])).toBe("detail");
  });

  it("labels every role in plain words", () => {
    expect(Object.keys(ANGLE_LABELS)).toEqual(["front", "back", "side", "detail", "in_the_box", "scale"]);
    for (const label of Object.values(ANGLE_LABELS)) {
      expect(label).not.toMatch(/[‒-―]| - |->/);
    }
  });
});

describe("sellerDetailsProblem", () => {
  it("accepts empty and valid details", () => {
    expect(sellerDetailsProblem("", [], [])).toBeNull();
    expect(sellerDetailsProblem(" MUG-12_a.b ", ["Mug"], ["Holds 12 oz, most hold 8 oz"])).toBeNull();
  });

  it("explains what to fix", () => {
    expect(sellerDetailsProblem("MUG/12", [], [])).toMatch(/letters, digits/);
    expect(sellerDetailsProblem("A".repeat(41), [], [])).toMatch(/40 characters/);
    expect(sellerDetailsProblem("", ["a", "b", "c", "d", "e", "f"], [])).toMatch(/at most 5 lines for what is in the box/);
    expect(sellerDetailsProblem("", [], ["x".repeat(41)])).toMatch(/how it compares to 40 characters/);
  });
});

describe("new pack form details", () => {
  const product = {
    id: "00000000-0000-4000-8000-000000000101",
    title: "Juniper bottle",
    mode: "listing" as const,
    sku: "JUNIPER-750",
    boxContents: ["Glass bottle", "Bamboo lid"],
    comparisonFacts: ["Holds 24 oz, most hold 16 oz"],
  };

  function render(initialProductId: string | null): string {
    return renderToStaticMarkup(
      React.createElement(NewPackForm, {
        products: [product],
        channels: [
          { id: "amazon.main", marketplace: true },
          { id: "shopify.product", marketplace: true },
        ],
        tier: "growth",
        paywall: { plan: "growth", creditBalance: 100, stripeLive: false, canBill: true },
        creditBalance: 100,
        initialProductId,
      }),
    );
  }

  it("prefills the picked product's saved details", () => {
    const html = render(product.id);
    expect(html).toContain('value="JUNIPER-750"');
    expect(html).toContain("Glass bottle\nBamboo lid");
    expect(html).toContain("Holds 24 oz, most hold 16 oz");
  });

  it("starts a new product with empty details and lets several photos be picked", () => {
    const html = render(null);
    expect(html).toContain('data-testid="seller-details"');
    expect(html).not.toContain("JUNIPER-750");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple/);
  });

  it("estimates the extra images the details add", () => {
    const channels = ["amazon.main", "shopify.product"];
    const bare = estimatePackCredits(channels, "listing", "growth").total;
    const rich = estimatePackCredits(channels, "listing", "growth", {
      angles: ["front", "side", "detail"],
      hasBoxContents: true,
      hasComparisonFacts: true,
    });
    expect(rich.total).toBeGreaterThan(bare);
    expect(rich.lines.map((l) => l.label)).toEqual(expect.arrayContaining(["In the box image", "Comparison image"]));
  });
});
