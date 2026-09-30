import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BrandKitForm } from "@/components/app/brand-kit-form";
import { BrandPaletteSuggestion } from "@/components/app/brand-palette-suggestion";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import type { BrandKitSuggestion } from "@/lib/brand/types";

// PHASE_16 workstream 7 on the page: the logo palette shows as suggestions
// with a confirm step, and rendering it never saves the kit.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

const suggestion: BrandKitSuggestion = {
  colors: [
    {
      hex: "#1B2A4A",
      name: "deep navy",
      share: 0.5,
      text: { backgroundHex: "#1B2A4A", textHex: "#FFFFFF", ratio: 14.2, passes: true },
    },
    {
      hex: "#7A7A7A",
      name: "gray",
      share: 0.3,
      text: { backgroundHex: "#7A7A7A", textHex: "#FFFFFF", ratio: 4.3, passes: false },
    },
  ],
  background: { hex: "#EEF1F7", text: { backgroundHex: "#EEF1F7", textHex: "#1B1F24", ratio: 14.9, passes: true } },
  source: "vision",
  ambiguous: true,
};

describe("BrandPaletteSuggestion", () => {
  it("lists each color with its text sample, readability and a confirm button", () => {
    const onUse = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(BrandPaletteSuggestion, { suggestion, maxColors: 6, onUse, onDismiss: vi.fn() }),
    );
    expect(html).toContain("deep navy");
    expect(html).toContain("#1B2A4A");
    expect(html).toContain("#EEF1F7");
    expect(html).toContain(brandKitCopy.paletteIntro);
    expect(html).toContain(brandKitCopy.paletteNamedNote);
    expect(html).toContain(brandKitCopy.paletteReadable);
    expect(html).toContain(brandKitCopy.paletteHardToRead);
    expect(html).toContain(brandKitCopy.paletteUse);
    // Every color starts checked; nothing is applied by rendering.
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(3);
    expect(onUse).not.toHaveBeenCalled();
  });
});

describe("BrandKitForm with a stored logo", () => {
  it("offers the palette button and saves nothing on render", () => {
    const save = vi.fn();
    const suggestPalette = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(BrandKitForm, {
        initial: {
          name: "Default",
          colors: ["#1B2A4A", "#D7263D", "#F4B400"],
          fonts: { heading: "", body: "" },
          stylePreset: "auto",
          hasLogo: true,
          logoKey: "ws/w/src/logo.png",
        },
        presetOptions: [{ value: "auto", label: "Automatic" }],
        fontOptions: [{ value: "", label: "Inter" }],
        save,
        suggestPalette,
        maxColors: 6,
      }),
    );
    expect(html).toContain(brandKitCopy.paletteButton);
    // Three filled colors show a fourth, empty slot.
    expect(html.match(/aria-label="Brand color \d"/g)).toHaveLength(4);
    expect(save).not.toHaveBeenCalled();
    expect(suggestPalette).not.toHaveBeenCalled();
  });

  it("hides the palette button without a logo", () => {
    const html = renderToStaticMarkup(
      React.createElement(BrandKitForm, {
        initial: { name: "Default", colors: [], fonts: { heading: "", body: "" }, stylePreset: "auto", hasLogo: false },
        presetOptions: [],
        fontOptions: [],
        save: vi.fn(),
        suggestPalette: vi.fn(),
      }),
    );
    expect(html).not.toContain(brandKitCopy.paletteButton);
    expect(html.match(/aria-label="Brand color \d"/g)).toHaveLength(3);
  });
});
