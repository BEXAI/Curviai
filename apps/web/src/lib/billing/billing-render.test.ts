import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tierByKey } from "@curvi/pipeline/seed";
import {
  annualSavingsPercentRange,
  CREDIT_TERMS_SENTENCE,
  freeCredits,
  packsForCredits,
  typicalPackCredits,
} from "@/lib/marketing-facts";
import type { BillingAccount } from "./account";
import { comingSoonFeatures } from "./plan-features";
import { selfServeTierKeys, selfServeTiers } from "./plans";
import { stubKeyOnly, stubOpenCheckout } from "@/lib/billing/test-env";

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
    for (const tier of selfServeTiers) {
      expect(text).toContain(`About ${packsForCredits(tier.creditsPerMonth).toLocaleString("en-US")} listing packs a month`);
    }
    expect(text).toContain(`Annual, save up to ${annualSavingsPercentRange().max} percent`);
    expect(text).toContain(`${freeCredits()} credits once, no card needed`);
    expect(text).toContain(CREDIT_TERMS_SENTENCE);
    expect(text).not.toMatch(/expire|usable for \d+ months/i);
    expect(text).not.toMatch(FORBIDDEN_COPY);
  });

  it("makes no rollover promise, since nothing enforces one", () => {
    const text = textOf(renderToStaticMarkup(React.createElement(PricingTiers)));
    expect(text).not.toMatch(ROLLOVER);
    expect(text).toContain(CREDIT_TERMS_SENTENCE);
  });

  it("labels features and assets that do not run yet with the site's Coming soon badge", () => {
    const html = renderToStaticMarkup(React.createElement(PricingTiers));
    const badges = html.match(/data-testid="coming-soon"/g) ?? [];
    // The On the way list plus the unbuilt rows of the credit table.
    expect(badges.length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/data-testid="on-the-way".*Generative video, coming soon to Growth and up\./);
  });

  it("shows only the plans sold online, with live lines in each card and the larger plan line (P20-08)", () => {
    const html = renderToStaticMarkup(React.createElement(PricingTiers));
    for (const key of selfServeTierKeys) {
      expect(html).toContain(`data-testid="tier-${key}"`);
    }
    expect(html).not.toContain('data-testid="tier-agency"');
    expect(html).not.toContain('data-testid="price-agency"');
    expect(html).not.toMatch(/data-testid="coming-soon-(starter|growth|pro|agency)"/);
    for (const key of selfServeTierKeys) {
      const card =
        html.slice(html.indexOf(`data-testid="tier-${key}"`)).split(/data-testid="(?:tier-|on-the-way)/)[1] ?? "";
      for (const label of comingSoonFeatures(key)) {
        expect(card, `${key} card lists ${label}`).not.toContain(label);
      }
    }
    const text = textOf(html);
    expect(text).toContain("Need more than Pro? Email us and we will set up a larger plan.");
    expect(text).toContain("Everything in Growth");
    expect(text).not.toMatch(FORBIDDEN_COPY);
  });

  it("uses the typical pack for the intro and says paid plans are not open without Stripe", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const text = textOf(renderToStaticMarkup(PricingPage()));
    expect(text).toContain(
      `uses about ${typicalPackCredits()} credits, so Starter covers about ${packsForCredits(tierByKey("starter").creditsPerMonth)} listing packs a month`,
    );
    expect(text).toContain("Paid plans open soon.");
    expect(text).not.toMatch(ROLLOVER);

    stubOpenCheckout(vi.stubEnv);
    expect(textOf(renderToStaticMarkup(PricingPage()))).not.toContain("Paid plans open soon.");
  });
});

describe("/app/billing", () => {
  it("keeps an interrupted unknown schedule visible and cancellable", async () => {
    stubOpenCheckout(vi.stubEnv);
    page.workspace.role = "owner";
    page.account = { stripeCustomerId: "cus_1", subscription: { externalId: "sub_1", tier: "growth", status: "active", periodEnd: null, pending: null, attachedScheduleId: "sched_orphan" } };
    const html = renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }));
    expect(textOf(html)).toContain("A billing schedule is attached to this plan.");
    expect(html).toContain('data-testid="keep-current-plan"');
    expect(textOf(html)).not.toContain("Your plan changes to");
  });
  it("offers only the plans sold online, with the On the way list and the larger plan line (P20-08)", async () => {
    const element = await BillingPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);
    for (const key of selfServeTierKeys) {
      expect(html).toContain(`data-testid="billing-price-${key}"`);
    }
    expect(html).not.toContain('data-testid="billing-price-agency"');
    expect(html).toContain('data-testid="on-the-way"');
    expect(textOf(html)).toContain("Need more than Pro? Email us and we will set up a larger plan.");
  });

  it("schedules smaller plans at renewal and opens the portal for upgrades", async () => {
    stubOpenCheckout(vi.stubEnv);
    page.account = {
      stripeCustomerId: "cus_1",
      subscription: { externalId: "sub_1", tier: "growth", status: "active", periodEnd: null },
    };
    try {
      const element = await BillingPage({ searchParams: Promise.resolve({}) });
      const html = renderToStaticMarkup(element);
      expect(html).toContain('data-testid="schedule-plan-starter"');
      expect(html).not.toContain('data-testid="schedule-plan-growth"');
      expect(html).not.toContain('data-testid="schedule-plan-pro"');
      const text = textOf(html);
      expect(text).toContain("Starts at your next renewal.");
      expect(text).toContain("Switch to Pro");
      expect(text).toContain("Switch to Starter at renewal");
    } finally {
      page.account = { stripeCustomerId: null, subscription: null };
    }
  });

  it("starts a yearly subscriber on yearly prices and schedules monthly changes at renewal", async () => {
    stubOpenCheckout(vi.stubEnv);
    page.account = {
      stripeCustomerId: "cus_1",
      subscription: { externalId: "sub_1", tier: "growth", status: "active", periodEnd: null, cadence: "annual" },
    };
    try {
      const yearly = renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }));
      expect(yearly).toMatch(/data-testid="cadence-toggle"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="cadence-toggle"/);
      expect(textOf(yearly)).toContain("Switch to Pro");
      expect(yearly).not.toContain('data-testid="schedule-plan-pro"');
      expect(textOf(yearly)).toContain(
        "Smaller plans and changes from yearly to monthly billing start at your next renewal.",
      );

      // A monthly link (or the toggle) shows the email line on every card,
      // even the bigger plan, and the finish card offers no button.
      const monthly = renderToStaticMarkup(
        await BillingPage({ searchParams: Promise.resolve({ checkout: "pro", cadence: "monthly" }) }),
      );
      expect(monthly).toContain('data-testid="schedule-plan-pro"');
      expect(monthly).toContain('data-testid="schedule-plan-growth"');
      const text = textOf(monthly);
      expect(text).toContain("Starts at your next renewal.");
      expect(text).toContain("Switch to Pro at renewal");
    } finally {
      page.account = { stripeCustomerId: null, subscription: null };
    }
  });

  it("labels a monthly subscriber's move to yearly and shows its renewal terms (law review major 3)", async () => {
    stubOpenCheckout(vi.stubEnv);
    page.account = {
      stripeCustomerId: "cus_1",
      subscription: { externalId: "sub_1", tier: "growth", status: "active", periodEnd: null, cadence: "monthly" },
    };
    try {
      const html = renderToStaticMarkup(
        await BillingPage({ searchParams: Promise.resolve({ checkout: "growth", cadence: "annual" }) }),
      );
      const text = textOf(html);
      expect(text).toContain("Switch to yearly billing");
      expect(text).toContain("Switch Growth to yearly billing");
      expect(text).toContain("Your Curvi Growth plan renews automatically every year");
      expect(html).not.toContain('data-testid="downgrade-by-email-growth"');
    } finally {
      page.account = { stripeCustomerId: null, subscription: null };
    }
  });

  it("ignores a crafted Agency checkout link (P20-08)", async () => {
    const element = await BillingPage({ searchParams: Promise.resolve({ checkout: "agency", cadence: "annual" }) });
    expect(renderToStaticMarkup(element)).not.toContain('data-testid="finish-upgrade"');
  });

  it("makes no rollover promise and states the one credit sentence by the top ups (P20-05)", async () => {
    const text = await renderBilling();
    expect(text).not.toMatch(ROLLOVER);
    expect(text).toContain(CREDIT_TERMS_SENTENCE);
    expect(text).toContain(`One time credit packs on top of any plan, including Free. ${CREDIT_TERMS_SENTENCE}`);
    expect(text).not.toMatch(/expire|usable for \d+ months/i);
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
    stubOpenCheckout(vi.stubEnv);
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

describe("a Stripe key without the webhook secret keeps every surface closed (P20-01)", () => {
  it("pricing still says paid plans are not open", () => {
    stubKeyOnly(vi.stubEnv);
    expect(textOf(renderToStaticMarkup(PricingPage()))).toContain("Paid plans open soon.");
  });

  it("billing shows the not open notice instead of checkout", async () => {
    stubKeyOnly(vi.stubEnv);
    expect(await renderBilling()).toContain("Card payments are not open yet.");
    stubOpenCheckout(vi.stubEnv);
    expect(await renderBilling()).not.toContain("Card payments are not open yet.");
  });

  it("keeps Update card and the customer portal for a subscriber while checkout is closed (law and copy review major 6)", async () => {
    stubKeyOnly(vi.stubEnv);
    page.account = {
      stripeCustomerId: "cus_1",
      subscription: { externalId: "sub_1", tier: "growth", status: "past_due", periodEnd: null },
    };
    try {
      const text = await renderBilling();
      expect(text).toContain("Card payments are not open yet.");
      expect(text).toContain("Update card");
      expect(text).toContain("Update cards and download invoices in the customer portal.");
      // No customer yet: no portal.
      page.account = { stripeCustomerId: null, subscription: null };
      expect(await renderBilling()).not.toContain("Update cards and download invoices in the customer portal.");
    } finally {
      page.account = { stripeCustomerId: null, subscription: null };
    }
  });
});
