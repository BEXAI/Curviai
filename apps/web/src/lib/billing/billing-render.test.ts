import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tierByKey } from "@curvi/pipeline/seed";
import {
  annualSavingsPercentRange,
  freeCredits,
  packsForCredits,
  topUpMonths,
  typicalPackCredits,
  UNUSED_CREDITS_SENTENCE,
} from "@/lib/marketing-facts";
import type { BillingAccount } from "./account";
import { paidTiers } from "./plans";

// Rendered /pricing, /app/billing and the app header banner: what they say
// must match the rest of the site and what the billing code actually does.

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest emits
  // React.createElement calls that need a global React.
  (globalThis as { React?: typeof React }).React = React;
});

const nav = vi.hoisted(() => ({ pathname: "/app" }));
const page = vi.hoisted(() => ({
  workspace: { id: "ws_1", name: "Shop", plan: "growth", creditBalance: 120, role: "owner" } as {
    id: string;
    name: string;
    plan: string;
    creditBalance: number;
    role: string;
  },
  account: { stripeCustomerId: null, subscription: null } as BillingAccount,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

vi.mock("@/lib/services", () => ({
  isDbMode: () => false,
  getServices: () => ({ ensureWorkspace: async () => page.workspace }),
}));

vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));

vi.mock("@/lib/billing/account", async (importOriginal) => {
  const original = await importOriginal<typeof import("./account")>();
  return { ...original, loadBillingAccount: async () => page.account, isCheckoutConfirmed: async () => null };
});

const { PricingTiers } = await import("@/components/marketing/pricing-tiers");
const { default: PricingPage } = await import("@/app/(marketing)/pricing/page");
const { default: BillingPage } = await import("@/app/app/billing/page");
const { PastDueBanner } = await import("@/components/app/billing-actions");

/** Visible text only, with tags and scripts removed. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function renderBilling(): Promise<string> {
  const element = await BillingPage({ searchParams: Promise.resolve({}) });
  return textOf(renderToStaticMarkup(element));
}

const ROLLOVER = /roll(s|ed)? ?over|carr(y|ies) over|capped at one month/i;
// CLAUDE.md rule 9: no emojis, no arrows, no dashes as punctuation.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

afterEach(() => {
  vi.unstubAllEnvs();
  nav.pathname = "/app";
  page.workspace.creditBalance = 120;
  page.account = { stripeCustomerId: null, subscription: null };
});

describe("/pricing", () => {
  it("states pack sizes and savings with the same numbers as the rest of the site", () => {
    const text = textOf(renderToStaticMarkup(React.createElement(PricingTiers)));
    expect(text).toContain(`A typical listing pack of still images uses about ${typicalPackCredits()} credits.`);
    for (const tier of paidTiers) {
      expect(text).toContain(`About ${packsForCredits(tier.creditsPerMonth).toLocaleString("en-US")} listing packs a month`);
    }
    expect(text).toContain(`Annual, save up to ${annualSavingsPercentRange().max} percent`);
    expect(text).toContain(`${freeCredits()} credits once, no card needed`);
    expect(text).toContain(`stay usable for ${topUpMonths()} months`);
    expect(text).not.toMatch(FORBIDDEN_COPY);
  });

  it("makes no rollover promise, since nothing enforces one", () => {
    const text = textOf(renderToStaticMarkup(React.createElement(PricingTiers)));
    expect(text).not.toMatch(ROLLOVER);
    expect(text).toContain(UNUSED_CREDITS_SENTENCE);
  });

  it("labels features and assets that do not run yet with the site's Coming soon badge", () => {
    const html = renderToStaticMarkup(React.createElement(PricingTiers));
    const badges = html.match(/data-testid="coming-soon"/g) ?? [];
    // One per tier list plus the unbuilt rows of the credit table.
    expect(badges.length).toBeGreaterThanOrEqual(paidTiers.length + 1);
    expect(html).toMatch(/data-testid="coming-soon-growth"[^>]*>.*Generative video/);
  });

  it("uses the typical pack for the intro and says paid plans are not open without Stripe", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const text = textOf(renderToStaticMarkup(PricingPage()));
    expect(text).toContain(
      `uses about ${typicalPackCredits()} credits, so Starter covers about ${packsForCredits(tierByKey("starter").creditsPerMonth)} listing packs a month`,
    );
    expect(text).toContain("Paid plans open soon.");
    expect(text).not.toMatch(ROLLOVER);

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_render");
    expect(textOf(renderToStaticMarkup(PricingPage()))).not.toContain("Paid plans open soon.");
  });
});

describe("/app/billing", () => {
  it("makes no rollover promise and states the top up term from the seed", async () => {
    const text = await renderBilling();
    expect(text).not.toMatch(ROLLOVER);
    expect(text).toContain(UNUSED_CREDITS_SENTENCE);
    expect(text).toContain(`Stays usable for ${topUpMonths()} months.`);
    expect(text).not.toMatch(FORBIDDEN_COPY);
  });

  it("explains a balance below zero after a downgrade took credits back", async () => {
    expect(await renderBilling()).not.toContain("Your credit balance is below zero.");
    page.workspace.creditBalance = -350;
    const text = await renderBilling();
    expect(text).toContain("Your credit balance is below zero.");
    expect(text).toContain("New packs can start again once a top up or your next renewal brings the balance back up.");
    expect(text).toContain("You are on the Growth plan with a balance 350 credits below zero.");
    expect(text).toContain("Balance 350 credits below zero.");
    expect(text).not.toContain("-350");
  });

  it("offers Cancel plan on a paid plan to members who can bill, and never on Free or to client seats", async () => {
    const saved = { ...page.workspace };
    try {
      expect(await renderBilling()).toContain("Cancel plan");
      page.workspace = { ...saved, role: "client" };
      expect(await renderBilling()).not.toContain("Cancel plan");
      page.workspace = { ...saved, plan: "free" };
      expect(await renderBilling()).not.toContain("Cancel plan");
    } finally {
      page.workspace = saved;
    }
  });

  it("shows the past due notice with the plan name", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_render");
    page.account = {
      stripeCustomerId: "cus_1",
      subscription: { externalId: "sub_1", tier: "growth", status: "past_due", periodEnd: null },
    };
    const text = await renderBilling();
    expect(text).toContain("Your last payment did not go through.");
    expect(text).toContain("Update the card to keep the Growth plan.");
  });
});

describe("app header past due banner", () => {
  it("shows on app pages with a link to Billing", () => {
    nav.pathname = "/app/new";
    const html = renderToStaticMarkup(React.createElement(PastDueBanner, { message: "Update the card." }));
    expect(textOf(html)).toContain("Your last payment did not go through. Update the card. Open Billing");
    expect(html).toContain('href="/app/billing"');
  });

  it("stays out of the way on the billing page, which has its own notice", () => {
    nav.pathname = "/app/billing";
    expect(renderToStaticMarkup(React.createElement(PastDueBanner, { message: "Update the card." }))).toBe("");
  });
});
