import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisitorStats } from "@/lib/visits/stats";

// /app/ops/visitors is for the emails in OPS_EMAILS only. Everyone else gets
// notFound(), so the page answers 404 and does not show that it exists.

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest compiles it to
  // React.createElement calls against a global React.
  (globalThis as { React?: typeof React }).React = React;
});

const state = vi.hoisted(() => ({
  user: null as null | { email?: string; email_confirmed_at?: string },
  dbMode: true,
  statsError: false,
}));

vi.mock("@/lib/supabase/server", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));

function sampleStats(): VisitorStats {
  const daily = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-09-${String(i + 2).padStart(2, "0")}`.replace("2026-09-31", "2026-10-01"),
    visitors: i === 29 ? 12 : i % 3,
    pageViews: i === 29 ? 40 : i % 3,
  }));
  return {
    today: "2026-10-01",
    ranges: [
      { key: "today", label: "Today", visitors: 12, pageViews: 40 },
      { key: "yesterday", label: "Yesterday", visitors: 1, pageViews: 1 },
      { key: "last7", label: "Last 7 days", visitors: 19, pageViews: 47 },
      { key: "last30", label: "Last 30 days", visitors: 41, pageViews: 69 },
    ],
    daily,
    topPages: [{ label: "/pricing", visitors: 9, pageViews: 14 }],
    topReferrers: [{ label: "news.ycombinator.com", visitors: 5, pageViews: 5 }],
    topSources: [{ label: "newsletter", visitors: 3, pageViews: 3 }],
    topCampaigns: [{ label: "launch", visitors: 3, pageViews: 3 }],
    devices: [
      { label: "desktop", visitors: 30, pageViews: 50 },
      { label: "mobile", visitors: 11, pageViews: 19 },
    ],
  };
}

vi.mock("@/lib/visits/stats", () => ({
  loadVisitorStats: async () => {
    if (state.statsError) {
      throw new Error("db down");
    }
    return sampleStats();
  },
}));

const { default: VisitorsPage } = await import("./page");

const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
// CLAUDE.md rule 9, as in components/marketing/claims.test.ts.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

async function render(): Promise<string> {
  return renderToStaticMarkup(await VisitorsPage());
}

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.stubEnv("OPS_EMAILS", " Founder@Curvi.ai , ops@example.com ");
  state.user = null;
  state.dbMode = true;
  state.statsError = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ops visitors page gate", () => {
  it("is not found for a visitor who is not signed in", async () => {
    await expect(VisitorsPage()).rejects.toMatchObject(NOT_FOUND);
  });

  it("is not found for a signed in user who is not an operator", async () => {
    state.user = { email: "seller@example.com", email_confirmed_at: "2026-09-30T00:00:00Z" };
    await expect(VisitorsPage()).rejects.toMatchObject(NOT_FOUND);
  });

  it("is not found for an operator email that is not confirmed", async () => {
    state.user = { email: "founder@curvi.ai" };
    await expect(VisitorsPage()).rejects.toMatchObject(NOT_FOUND);
  });

  it("is not found for anyone when OPS_EMAILS is not set", async () => {
    vi.stubEnv("OPS_EMAILS", "");
    state.user = { email: "founder@curvi.ai", email_confirmed_at: "2026-09-30T00:00:00Z" };
    await expect(VisitorsPage()).rejects.toMatchObject(NOT_FOUND);
  });

  it("shows the counts to an operator, matching the email without regard to case", async () => {
    state.user = { email: "FOUNDER@curvi.ai", email_confirmed_at: "2026-09-30T00:00:00Z" };
    const html = await render();
    expect(html).toContain('data-testid="visitors-dashboard"');
    expect(html).toContain("Site visitors");
    expect(html).toContain("Daily visitors, added up");
    expect(html).toContain("counts again");
    expect(html).toContain("/pricing");
    expect(html).toContain("news.ycombinator.com");
    expect(html).toContain("newsletter");
    expect(html).toContain("launch");
    expect(html).toContain('data-testid="visitors-daily-chart"');
    expect(html).toContain("Oct 1: 12 visitors, 40 page views");
    expect(visibleText(html)).not.toMatch(FORBIDDEN_COPY);
  });

  it("tells an operator that counts need the database when there is none", async () => {
    state.user = { email: "ops@example.com", email_confirmed_at: "2026-09-30T00:00:00Z" };
    state.dbMode = false;
    const html = await render();
    expect(html).toContain("Visitor counts need the database");
    expect(html).not.toContain('data-testid="visitors-dashboard"');
    expect(visibleText(html)).not.toMatch(FORBIDDEN_COPY);
  });

  it("shows a plain notice when the counts cannot be read", async () => {
    state.user = { email: "ops@example.com", email_confirmed_at: "2026-09-30T00:00:00Z" };
    state.statsError = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const html = await render();
    expect(html).toContain("could not be read just now");
  });
});
