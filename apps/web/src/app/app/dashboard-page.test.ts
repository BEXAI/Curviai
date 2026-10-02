import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { JobSummary } from "@/lib/services/types";
import { stubOpenCheckout } from "@/lib/billing/test-env";

// The dashboard's credit card: a balance a plan change took below zero is
// explained (what happened, and that a top up or the next renewal lets packs
// start again), never shown as a bare negative number.

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest compiles it to
  // React.createElement calls against a global React.
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const page = vi.hoisted(() => ({ creditBalance: 40, jobs: [] as JobSummary[] }));

vi.mock("@/lib/services", () => ({
  getServices: () => ({
    ensureWorkspace: async () => ({
      id: "ws_1",
      name: "Test shop",
      plan: "starter",
      creditBalance: page.creditBalance,
      role: "owner",
    }),
    listProducts: async () => [],
    listRecentJobs: async () => page.jobs,
  }),
}));

async function renderDashboard(creditBalance: number): Promise<string> {
  page.creditBalance = creditBalance;
  const { default: DashboardPage } = await import("./page");
  return renderToStaticMarkup(await DashboardPage());
}

/** The markup of the credit card, found by its test id. */
function creditCard(html: string): string {
  const start = html.indexOf('data-testid="credit-balance"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("Manage billing", start));
}

describe("dashboard credit card", () => {
  it("shows a positive balance as a number", async () => {
    const card = creditCard(await renderDashboard(40));
    expect(card).toContain(">40<");
    expect(card).not.toContain('data-testid="negative-balance"');
  });

  it("explains a balance below zero instead of a raw negative number", async () => {
    const card = creditCard(await renderDashboard(-12));
    expect(card).toContain('data-testid="negative-balance"');
    expect(card).toContain("12 credits below zero");
    expect(card).toContain("A plan change returned money for time you had already been billed for");
    expect(card).toContain("were taken back");
    expect(card).toContain("a top up or your next renewal");
    expect(card).not.toContain("-12");
    expect(card).not.toMatch(/[–—→]| - |->/);
  });

  it("uses the singular for one credit and keeps fractions", async () => {
    expect(creditCard(await renderDashboard(-1))).toContain("1 credit below zero");
    expect(creditCard(await renderDashboard(-2.5))).toContain("2.5 credits below zero");
  });
});

describe("dashboard low balance nudge", () => {
  it("nudges a balance under one pack, and stays quiet otherwise", async () => {
    const low = await renderDashboard(2);
    expect(low).toContain('data-testid="low-balance-nudge"');
    expect(low).toContain("You are running low on credits");
    // No Stripe keys in tests: early access copy, and no checkout link.
    expect(low).toContain("Credits are limited during early access");
    expect(low).not.toContain("checkout=");
    expect(await renderDashboard(0)).toContain("You are out of credits");
    expect(await renderDashboard(40)).not.toContain('data-testid="low-balance-nudge"');
    // A balance below zero keeps its own explanation instead.
    expect(await renderDashboard(-12)).not.toContain('data-testid="low-balance-nudge"');
  });

  it("offers the next plan up from the seed when Stripe is on", async () => {
    stubOpenCheckout(vi.stubEnv);
    try {
      const html = await renderDashboard(2);
      expect(html).toContain("Upgrade to Growth");
      expect(html).toContain("/app/billing?checkout=growth&amp;cadence=monthly");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("dashboard recent packs", () => {
  const summary = (partial: Partial<JobSummary>): JobSummary => ({
    id: "00000000-0000-4000-8000-000000000001",
    productTitle: "Mug",
    status: "done",
    creditsReserved: 24,
    creditsCharged: 0,
    createdAt: new Date(0).toISOString(),
    ...partial,
  });

  it("shows the hold while a pack runs and the charge once it settles", async () => {
    page.jobs = [
      summary({ id: "00000000-0000-4000-8000-000000000001", status: "generating" }),
      summary({ id: "00000000-0000-4000-8000-000000000002", status: "done", creditsCharged: 18 }),
      summary({ id: "00000000-0000-4000-8000-000000000003", status: "canceled" }),
    ];
    try {
      const html = await renderDashboard(40);
      expect(html).toContain("24 credits held");
      expect(html).toContain("18 credits charged");
      expect(html).toContain("Nothing charged");
      expect(html).not.toContain("credits reserved");
    } finally {
      page.jobs = [];
    }
  });
});

describe("dashboard example pack (P18-20)", () => {
  it("shows the real candle pack files on an empty dashboard, labeled as an example", async () => {
    const html = await renderDashboard(15);
    expect(html).toContain('data-testid="example-pack"');
    expect(html).toContain("Example made by Curvi from one candle photo");
    expect(html).toContain('src="/home/pack/amazon-main.webp"');
    expect(html).toContain('src="/home/pack/lifestyle-warm.webp"');
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/[–—→←]| - |->|<-/);
  });

  it("points only at files that ship in public/home/pack", async () => {
    const { EXAMPLE_PACK_FILES } = await import("@/components/app/example-pack");
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../../../public/home/pack/", import.meta.url));
    expect(EXAMPLE_PACK_FILES.length).toBeGreaterThan(0);
    for (const file of EXAMPLE_PACK_FILES) {
      expect(existsSync(`${dir}${file.src}`), file.src).toBe(true);
      expect(file.alt.length).toBeGreaterThan(10);
    }
  });

  it("is gone once the workspace has a pack", async () => {
    page.jobs = [
      {
        id: "00000000-0000-4000-8000-000000000009",
        productTitle: "Candle",
        status: "done",
        creditsReserved: 8,
        creditsCharged: 8,
        createdAt: new Date(0).toISOString(),
      },
    ];
    try {
      expect(await renderDashboard(15)).not.toContain('data-testid="example-pack"');
    } finally {
      page.jobs = [];
    }
  });
});
