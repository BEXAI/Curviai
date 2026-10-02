import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WELCOME_QUESTIONS_COPY } from "@/components/marketing/welcome-questions";

// /welcome (docs/phases/PHASE_18.md P18-20): a new workspace with no saved
// answers gets two optional questions, preselected from ?category= and
// ?channel=; everyone else gets the page as before.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const state = vi.hoisted(() => ({
  workspace: { id: "ws_1", name: "Shop", plan: "free", creditBalance: 15, role: "owner" } as {
    id: string;
    name: string;
    plan: string;
    creditBalance: number;
    role: string;
  } | null,
  profile: null as unknown,
  throws: false,
}));

vi.mock("@/lib/services", () => ({
  getServices: () => {
    if (state.throws) {
      throw new Error("demo mode refused");
    }
    return {
      getCurrentWorkspace: async () => state.workspace,
      getSellerProfile: async () => state.profile,
    };
  },
}));

beforeEach(() => {
  state.workspace = { id: "ws_1", name: "Shop", plan: "free", creditBalance: 15, role: "owner" };
  state.profile = null;
  state.throws = false;
});

async function renderWelcome(params: Record<string, string> = {}): Promise<string> {
  const { default: WelcomePage } = await import("./page");
  return renderToStaticMarkup(await WelcomePage({ searchParams: Promise.resolve(params) }));
}

function pressed(html: string, testId: string): boolean {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, testId).toBeGreaterThan(-1);
  const tagStart = html.lastIndexOf("<", at);
  const tag = html.slice(tagStart, html.indexOf(">", at));
  return tag.includes('aria-pressed="true"');
}

describe("/welcome first run questions", () => {
  it("asks a new workspace both questions, with every seeded answer", async () => {
    const html = await renderWelcome();
    expect(html).toContain('data-testid="welcome-questions"');
    expect(html).toContain(WELCOME_QUESTIONS_COPY.intro);
    expect(html).toContain("What do you sell?");
    expect(html).toContain("Where do you sell?");
    expect(html).toContain("Candles and home fragrance");
    expect(html).toContain('data-testid="welcome-channel-tiktokshop"');
    expect(html).toContain('data-testid="welcome-skip"');
    expect(html).toContain("Make your first pack");
    expect(pressed(html, "welcome-category-candles")).toBe(false);
  });

  it("preselects the answers a category or channel page sent, and ignores unseeded ones", async () => {
    const html = await renderWelcome({ category: "beauty", channel: "walmart" });
    expect(pressed(html, "welcome-category-beauty")).toBe(true);
    expect(pressed(html, "welcome-channel-walmart")).toBe(true);
    expect(pressed(html, "welcome-channel-amazon")).toBe(false);
    const odd = await renderWelcome({ category: "sports", channel: "myspace" });
    expect(odd).not.toContain('aria-pressed="true"');
  });

  it("is the plain page once answered, for a client seat, signed out, or when services fail", async () => {
    state.profile = { category: "pet", channels: [], answeredAt: "2026-10-01T00:00:00.000Z" };
    expect(await renderWelcome()).not.toContain("welcome-questions");
    state.profile = null;
    state.workspace = { id: "ws_1", name: "Shop", plan: "free", creditBalance: 15, role: "client" };
    expect(await renderWelcome()).not.toContain("welcome-questions");
    state.workspace = null;
    const signedOut = await renderWelcome();
    expect(signedOut).not.toContain("welcome-questions");
    expect(signedOut).toContain('href="/app/new"');
    state.throws = true;
    expect(await renderWelcome()).toContain('data-testid="welcome-continue"');
  });

  it("keeps the destination on site", async () => {
    state.workspace = null;
    const html = await renderWelcome({ next: "https://evil.example/" });
    expect(html).not.toContain("evil.example");
  });

  it("uses plain copy: no emojis, arrows or dashes as punctuation (rule 9)", async () => {
    const text = (await renderWelcome()).replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/[–—→←]| - |->|<-/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
