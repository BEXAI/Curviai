import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { homeHero, homeHeroCtas, homeHeroFeatures, homeHeroNote } from "@/components/marketing/home-copy";
import { shaderAllowed, type ShaderEnvironment } from "./liquid-metal-backdrop";

// Same setup as marketing-render.test.ts: JSX compiles to React.createElement.
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

// CLAUDE.md rule 9, as in claims.test.ts.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function h1Markup(html: string): string {
  return /<h1\b[\s\S]*?<\/h1>/.exec(html)?.[0] ?? "";
}

async function renderHero(props: Record<string, unknown>): Promise<string> {
  const { LiquidMetalHero } = await import("./liquid-metal-hero");
  return renderToStaticMarkup(React.createElement(LiquidMetalHero, props as never));
}

const homeProps = {
  badge: homeHero.eyebrow,
  title: "Shot once. Ready everywhere.",
  subtitle: homeHero.lead,
  primaryCtaLabel: homeHeroCtas.primary.label,
  primaryCtaHref: homeHeroCtas.primary.href,
  secondaryCtaLabel: homeHeroCtas.secondary.label,
  secondaryCtaHref: homeHeroCtas.secondary.href,
  note: homeHeroNote,
  features: homeHeroFeatures.map((feature) => feature.label),
};

describe("liquid metal hero", () => {
  it("server renders the headline, subtitle and link calls to action", async () => {
    const html = await renderHero(homeProps);
    expect(h1Markup(html)).toContain("Shot once. Ready everywhere.");
    expect(html).toContain(homeHero.lead);
    expect(html).toContain(`href="${homeHeroCtas.primary.href}"`);
    expect(html).toContain(`href="${homeHeroCtas.secondary.href}"`);
    expect(html).toContain(">Start free<");
    expect(html).toContain(">Test your main image free<");
    for (const feature of homeHeroFeatures) {
      expect(html).toContain(feature.label);
    }
  });

  it("never hides the headline or subtitle in the server HTML", async () => {
    const html = await renderHero(homeProps);
    // No inline styles at all on the hero text, and never the fade in class.
    expect(h1Markup(html)).not.toMatch(/style=|opacity/);
    expect(h1Markup(html)).not.toContain("animate-fade-in-up");
    const subtitle = /<p\b[^>]*>[^<]*AI product images for[^<]*<\/p>/.exec(html)?.[0] ?? "";
    expect(subtitle).not.toMatch(/style=|opacity|animate-fade-in-up/);
  });

  it("renders the static metal on the server and no canvas", async () => {
    const html = await renderHero(homeProps);
    expect(html).toContain('data-testid="hero-metal-fallback"');
    expect(html).toContain('data-shader="off"');
    expect(html).not.toContain("<canvas");
    // Scoped to the hero, never fixed behind the whole page.
    expect(html).not.toMatch(/position:\s*fixed/);
  });

  it("follows the copy rules and states only live features", async () => {
    const html = await renderHero(homeProps);
    expect(visibleText(html)).not.toMatch(FORBIDDEN_COPY);
    expect(html).not.toContain('data-testid="coming-soon"');
    expect(html).not.toMatch(/data-testid="feature-/);
  });

  it("renders both calls to action as links, never as buttons without a target", async () => {
    const html = await renderHero({
      title: "Title",
      subtitle: "Subtitle",
      primaryCtaLabel: "Primary",
      primaryCtaHref: "/one",
      secondaryCtaLabel: "Secondary",
      secondaryCtaHref: "/two",
      features: ["One", "Two", "Three"],
    });
    expect(html).toMatch(/<a href="\/one"[^>]*>Primary<\/a>/);
    expect(html).toMatch(/<a href="\/two"[^>]*>Secondary<\/a>/);
    // The motion toggle renders only once the shader runs, never on the server.
    expect(html).not.toContain("<button");
    expect(html).toContain(">Three<");
  });

  it("animates the entrance only for visitors without a reduced motion preference", async () => {
    const html = await renderHero(homeProps);
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) => (match[1] ?? "").split(/\s+/));
    const entrance = classes.filter((name) => /animate-(fade-in-up|rise-in)|animation-delay/.test(name));
    expect(entrance.length).toBeGreaterThan(0);
    expect(entrance.filter((name) => !name.startsWith("motion-safe:"))).toEqual([]);
  });

  it("keeps backdrop blur off the hero, where it would repaint over the moving metal", async () => {
    const html = await renderHero(homeProps);
    expect(html).not.toMatch(/backdrop-blur/);
  });
});

describe("home page hero", () => {
  it("has one H1, visible without JavaScript, with no fade in", async () => {
    const { default: HomePage } = await import("@/app/(marketing)/page");
    const html = renderToStaticMarkup(React.createElement(HomePage));
    expect(html.match(/<h1\b/g)?.length).toBe(1);
    const h1 = h1Markup(html);
    expect(visibleText(h1)).toBe("Shot once. Ready everywhere.");
    expect(h1).not.toMatch(/style=|opacity|animate-fade-in-up/);
    expect(html).toContain('id="home-hero-title"');
    expect(html).toContain('aria-labelledby="home-hero-title"');
  });
});

describe("shader gate", () => {
  const capable: ShaderEnvironment = {
    reducedMotion: false,
    wideScreen: true,
    saveData: false,
    deviceMemory: 8,
    hardwareConcurrency: 8,
    webgl2: () => true,
  };

  it("runs on a capable desktop", () => {
    expect(shaderAllowed(capable)).toBe(true);
    expect(shaderAllowed({ ...capable, deviceMemory: undefined, hardwareConcurrency: undefined })).toBe(true);
  });

  it("stays on the static metal when any condition fails", () => {
    expect(shaderAllowed({ ...capable, reducedMotion: true })).toBe(false);
    expect(shaderAllowed({ ...capable, wideScreen: false })).toBe(false);
    expect(shaderAllowed({ ...capable, saveData: true })).toBe(false);
    expect(shaderAllowed({ ...capable, deviceMemory: 2 })).toBe(false);
    expect(shaderAllowed({ ...capable, hardwareConcurrency: 2 })).toBe(false);
    expect(shaderAllowed({ ...capable, webgl2: () => false })).toBe(false);
  });

  it("never probes WebGL for reduced motion visitors or tiny screens", () => {
    const webgl2 = vi.fn(() => true);
    shaderAllowed({ ...capable, reducedMotion: true, webgl2 });
    shaderAllowed({ ...capable, wideScreen: false, webgl2 });
    expect(webgl2).not.toHaveBeenCalled();
  });
});
