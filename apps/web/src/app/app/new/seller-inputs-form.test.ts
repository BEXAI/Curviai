import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Switch } from "@curvi/ui";
import {
  ANGLE_LABELS,
  NewPackForm,
  channelChip,
  nextAngle,
  optionPhotosOf,
  photoBlockReason,
  sellerDetailsProblem,
  type PhotoItem,
} from "@/components/app/new-pack-form";
import { OutputOptionsPanel, type OutputOptionsPanelProps } from "@/components/app/output-options-panel";
import { conflictLines, OTHER_ITEMS_KEPT_COPY } from "@/lib/output-options-copy";
import {
  conflictContextOf,
  formConflicts,
  initialOutputForm,
  outputFormReducer,
  planningPhotos,
  previewFrames,
  resolveFormOutput,
  type OutputFormState,
} from "@/lib/output-options-form";
import { estimatePackCredits } from "@/lib/pack-estimate";
import type { PreflightView } from "@/lib/preflight/types";

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

describe("the Switch", () => {
  it("renders a button with role=switch and aria-checked", () => {
    const on = renderToStaticMarkup(React.createElement(Switch, { checked: true, "aria-label": "Remove the background" }));
    expect(on).toMatch(/^<button[^>]*type="button"[^>]*role="switch"[^>]*aria-checked="true"/);
    expect(on).toContain("min-h-11");
    const off = renderToStaticMarkup(React.createElement(Switch, { checked: false, "aria-label": "x" }));
    expect(off).toContain('aria-checked="false"');
  });
});

describe("new pack form with output options", () => {
  const channels = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1", "meta.story_9x16"].map((id) => ({
    id,
    marketplace: !id.startsWith("meta."),
    requiresWhite: id === "amazon.main",
    exactSize: id === "meta.story_9x16" ? { width: 1080, height: 1920 } : null,
  }));

  function render(extra: Record<string, unknown> = {}): string {
    return renderToStaticMarkup(
      React.createElement(NewPackForm, {
        products: [],
        channels,
        tier: "growth",
        paywall: { plan: "growth", creditBalance: 100, stripeLive: false, canBill: true },
        creditBalance: 100,
        outputOptionsEnabled: true,
        brandColors: ["#1F2A44"],
        brandKitsAllowed: true,
        ...extra,
      }),
    );
  }

  it("renders the look radiogroup, the switch and the phone bar", () => {
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*tabindex="0"/);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(html).toContain('data-testid="create-pack-bar"');
    expect(html).toContain("env(safe-area-inset-bottom)");
    expect(html).toMatch(/aria-live="polite"[^>]*data-testid="bar-total"/);
    expect(html).toContain("Add a photo to see it here.");
  });

  it("chips the channel rows from the registry flags", () => {
    expect(channelChip({ requiresWhite: true })).toBe("Stays white");
    expect(channelChip({ exactSize: { width: 1080, height: 1920 } })).toBe("Set shape, 1080 by 1920");
    expect(channelChip({})).toBeNull();
    const html = render();
    expect(html).toContain("Stays white");
    expect(html).toContain("Set shape, 1080 by 1920");
  });

  it("renders as before with output options off", () => {
    const html = render({ outputOptionsEnabled: false });
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("Stays white");
    expect(html).toContain("3. How it is made");
  });
});

describe("the output options panel", () => {
  const selected = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1", "ebay.listing"];

  function panel(state: OutputFormState, extra: Partial<OutputOptionsPanelProps> = {}): string {
    const photos = planningPhotos([]);
    const { resolved } = resolveFormOutput({ choices: state.choices, brandColors: [], brandKitsAllowed: true, photos });
    const headsUp = conflictLines(
      formConflicts(selected, resolved, photos),
      conflictContextOf(state.choices.background, photos),
    );
    return renderToStaticMarkup(
      React.createElement(OutputOptionsPanel, {
        state,
        onAction: () => undefined,
        tier: "growth",
        brandColors: ["#1F2A44"],
        brandKitsAllowed: true,
        colorHex: resolved.colorHex,
        headsUp,
        onLeaveOut: () => undefined,
        addedSpace: false,
        frames: previewFrames(selected),
        hasPhoto: false,
        ...extra,
      }),
    );
  }

  it("shows no heads up for today's pack", () => {
    const html = panel(initialOutputForm());
    expect(html).not.toContain("Heads up for your channels");
    expect(html).toContain("Background color");
    expect(html).not.toContain("More options");
  });

  it("shows the white required and added text heads ups for Keep, with Leave it out", () => {
    const keep = outputFormReducer(initialOutputForm(), { type: "look", look: "keep_photo" });
    const html = panel(keep);
    expect(html).toContain("Heads up for your channels");
    expect(html).toContain("Amazon&#x27;s main image must be pure white");
    expect(html).toContain("eBay does not allow added text");
    expect(html).toContain("Leave it out");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    // With Keep the color shows only where added space needs it.
    expect(html).not.toContain("Color for added space");
    expect(panel(keep, { addedSpace: true })).toContain("Color for added space");
    expect(html).toContain("More options");
    expect(html).toContain("These are made from a cut out copy of your product.");
  });

  it("names the white channels in one line with Remove and a color", () => {
    const sand = outputFormReducer(initialOutputForm(), { type: "color", color: { kind: "swatch", key: "sand" } });
    const html = panel(sand);
    expect(html).toContain("Amazon main image stays pure white. Your color is used everywhere else.");
    expect(html).toContain("Custom, started from Marketplace ready");
  });

  it("hides the switch and the color in concept mode", () => {
    const html = panel(initialOutputForm(), { conceptMode: true });
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('role="radiogroup"');
  });
});

describe("kept photos in section 1", () => {
  const view: PreflightView = {
    status: "choose",
    items: [
      { number: 1, name: "mug", box: { x: 0, y: 0, width: 10, height: 10 }, longSide: 900 },
      { number: 2, name: "plate", box: { x: 10, y: 0, width: 10, height: 10 }, longSide: 900 },
    ],
    sizes: [],
    photo: { width: 1200, height: 900 },
  } as unknown as PreflightView;
  const photo: PhotoItem = {
    id: 1,
    name: "shelf.jpg",
    phase: "uploaded",
    kind: "image",
    angle: "front",
    key: "ws/uploads/a.jpg",
    sha256: "x",
    preflightPhase: "done",
    preflight: view,
  };

  it("does not ask for the product when a kept photo feeds no cutout, and does when it does", () => {
    expect(photoBlockReason(photo, ["amazon.secondary"])).toBe("Tap the product this pack is for.");
    expect(photoBlockReason(photo, ["amazon.secondary"], { kept: true, feedsCutout: false })).toBeNull();
    expect(photoBlockReason(photo, ["amazon.main"], { kept: true, feedsCutout: true })).toBe(
      "Tap the product this pack is for.",
    );
  });

  it("carries the preflight size and other items into the options", () => {
    expect(optionPhotosOf([photo])).toEqual([
      { id: "ws/uploads/a.jpg", angle: "front", width: 1200, height: 900, otherItems: true },
    ]);
    expect(OTHER_ITEMS_KEPT_COPY).toContain("This photo shows other items.");
  });
});
