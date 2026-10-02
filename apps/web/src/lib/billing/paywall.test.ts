import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { tierByKey, tiers, topUps } from "@curvi/pipeline/seed";
import { HeaderCreditBalance, LowBalanceNudge, OutOfCreditsDialog } from "@/components/app/paywall";
import { isOutOfCreditsRefusal, estimateOverBalanceLine } from "@/components/app/new-pack-form";
import { typicalPackCredits } from "@/lib/marketing-facts";
import {
  BILLING_HREF,
  TOP_UPS_HREF,
  headerBalanceLabel,
  isLowBalance,
  lowBalanceCopy,
  lowBalanceThreshold,
  outOfCreditsCopy,
  suggestedTier,
  suggestedTopUp,
  type PaywallContext,
  type PaywallCopy,
} from "./paywall";
import { formatUsd } from "./plans";

// The paywall moments: the out of credits dialog, the low balance nudge and
// the header balance. Prices and credit amounts must come from the seed
// (CLAUDE.md rule 2), and with Stripe off nothing may link to checkout.

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest compiles it to
  // React.createElement calls against a global React.
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const LIVE: PaywallContext = { plan: "free", creditBalance: 3, stripeLive: true, canBill: true };
const EARLY: PaywallContext = { ...LIVE, stripeLive: false };

/** Every string a copy object shows. */
function allText(copy: PaywallCopy): string {
  return [copy.title, ...copy.paragraphs, ...copy.actions.map((a) => a.label)].join(" ");
}

function expectPlainCopy(copy: PaywallCopy) {
  // CLAUDE.md rule 9: no arrows, no dashes as punctuation, no emojis.
  expect(allText(copy)).not.toMatch(/[–—→]| - |->|\p{Extended_Pictographic}/u);
  expect(allText(copy)).not.toMatch(/-\d/);
}

describe("low balance threshold", () => {
  it("is one default listing pack of stills, from the seed", () => {
    expect(lowBalanceThreshold()).toBe(typicalPackCredits());
    expect(lowBalanceThreshold()).toBeGreaterThan(0);
  });

  it("counts a balance under one pack as low, and a balance below zero as its own case", () => {
    const threshold = 7;
    expect(isLowBalance(0, threshold)).toBe(true);
    expect(isLowBalance(6.5, threshold)).toBe(true);
    expect(isLowBalance(7, threshold)).toBe(false);
    expect(isLowBalance(400, threshold)).toBe(false);
    expect(isLowBalance(-3, threshold)).toBe(false);
  });
});

describe("suggestedTier", () => {
  it("offers the next paid plan up that covers the pack", () => {
    expect(suggestedTier("free", 1)?.key).toBe("starter");
    expect(suggestedTier("starter", 1)?.key).toBe("growth");
    // A pack bigger than the next plan's month skips to one that covers it.
    const growth = tierByKey("growth");
    expect(suggestedTier("free", growth.creditsPerMonth)?.key).toBe("growth");
  });

  it("falls back to the next plan up when none covers the pack, and offers nothing on the top plan", () => {
    const biggest = Math.max(...tiers.map((t) => t.creditsPerMonth));
    expect(suggestedTier("free", biggest + 1)?.key).toBe("starter");
    expect(suggestedTier(tiers[tiers.length - 1].key, 1)).toBeNull();
  });

  it("treats an unknown plan as free", () => {
    expect(suggestedTier("legacy", 1)?.key).toBe("starter");
  });

  it("never offers Agency, which is set up by email (P20-08)", () => {
    const pro = tierByKey("pro");
    expect(suggestedTier("pro", 1)).toBeNull();
    expect(suggestedTier("growth", pro.creditsPerMonth + 1)?.key).toBe("pro");
  });
});

describe("suggestedTopUp", () => {
  it("picks the smallest top up that covers the shortfall, else the largest", () => {
    const sorted = [...topUps].sort((a, b) => a.credits - b.credits);
    expect(suggestedTopUp(1)).toEqual(sorted[0]);
    expect(suggestedTopUp(sorted[0].credits + 1)).toEqual(sorted[1]);
    expect(suggestedTopUp(sorted[sorted.length - 1].credits * 10)).toEqual(sorted[sorted.length - 1]);
  });
});

describe("outOfCreditsCopy with Stripe on", () => {
  it("states the need and the balance, and offers the next plan and a top up from the seed", () => {
    const copy = outOfCreditsCopy(LIVE, 7);
    const starter = tierByKey("starter");
    const text = allText(copy);
    expect(copy.title).toBe("Not enough credits for this pack");
    expect(text).toContain("This pack needs about 7 credits and you have 3 credits.");
    expect(text).toContain(`${starter.creditsPerMonth} credits every month for ${formatUsd(starter.monthlyUsd)} a month`);
    const topUp = suggestedTopUp(4)!;
    expect(text).toContain(`${topUp.credits} credits once for ${formatUsd(topUp.usd)}`);
    expect(copy.actions).toEqual([
      { label: "Upgrade to Starter", href: "/app/billing?checkout=starter&cadence=monthly", primary: true },
      { label: "Buy credits", href: TOP_UPS_HREF, primary: false },
    ]);
    expectPlainCopy(copy);
  });

  it("says no credits are left and explains a balance below zero without a negative number", () => {
    expect(allText(outOfCreditsCopy({ ...LIVE, creditBalance: 0 }, 7))).toContain("you have no credits left");
    const below = outOfCreditsCopy({ ...LIVE, creditBalance: -4 }, 7);
    expect(allText(below)).toContain("your balance is 4 credits below zero");
    expectPlainCopy(below);
  });

  it("offers only a top up on the top plan", () => {
    const copy = outOfCreditsCopy({ ...LIVE, plan: tiers[tiers.length - 1].key }, 7);
    expect(copy.actions).toEqual([{ label: "Buy credits", href: TOP_UPS_HREF, primary: true }]);
    expect(allText(copy)).toContain("Buy ");
    expect(allText(copy)).not.toContain("Or buy");
  });
});

describe("outOfCreditsCopy with Stripe off", () => {
  it("explains early access and links to billing, never to checkout", () => {
    const copy = outOfCreditsCopy(EARLY, 7);
    const text = allText(copy);
    expect(text).toContain("Credits are limited during early access");
    expect(text).toContain("Pick fewer channels");
    expect(copy.actions).toEqual([{ label: "Open Billing", href: BILLING_HREF, primary: true }]);
    expect(copy.actions.some((a) => a.href.includes("checkout"))).toBe(false);
    // No price is offered when nothing can be bought.
    expect(text).not.toContain("$");
    expectPlainCopy(copy);
  });

  it("sends a client seat to the workspace owner with no links, whether Stripe is on or off", () => {
    for (const context of [LIVE, EARLY]) {
      const copy = outOfCreditsCopy({ ...context, canBill: false }, 7);
      expect(copy.actions).toEqual([]);
      expect(allText(copy)).toContain("Ask the workspace owner");
    }
  });
});

describe("lowBalanceCopy", () => {
  it("is null when the balance covers a pack or is below zero", () => {
    expect(lowBalanceCopy({ ...LIVE, creditBalance: 7 }, 7)).toBeNull();
    expect(lowBalanceCopy({ ...LIVE, creditBalance: -2 }, 7)).toBeNull();
  });

  it("nudges a low balance toward the next plan with Stripe on", () => {
    const copy = lowBalanceCopy(LIVE, 7)!;
    expect(copy.title).toBe("You are running low on credits");
    expect(allText(copy)).toContain("You have 3 credits left. A default listing pack of still images uses about 7 credits.");
    expect(copy.actions[0]).toMatchObject({ label: "Upgrade to Starter", primary: true });
    expectPlainCopy(copy);
  });

  it("says out of credits at zero, and explains early access with Stripe off", () => {
    const copy = lowBalanceCopy({ ...EARLY, creditBalance: 0 }, 7)!;
    expect(copy.title).toBe("You are out of credits");
    expect(allText(copy)).toContain("You have no credits left.");
    expect(allText(copy)).toContain("Credits are limited during early access");
    expect(copy.actions).toEqual([{ label: "Open Billing", href: BILLING_HREF, primary: true }]);
    expectPlainCopy(copy);
  });
});

describe("header balance", () => {
  it("shows credits, the singular, and a word instead of a negative number", () => {
    expect(headerBalanceLabel(40)).toBe("40 credits");
    expect(headerBalanceLabel(1)).toBe("1 credit");
    expect(headerBalanceLabel(1200)).toBe("1,200 credits");
    expect(headerBalanceLabel(-5)).toBe("Balance below zero");
  });

  it("links to billing and warns when low", () => {
    const ok = renderToStaticMarkup(React.createElement(HeaderCreditBalance, { creditBalance: 40, lowThreshold: 7 }));
    expect(ok).toContain('href="/app/billing"');
    expect(ok).toContain("40 credits");
    expect(ok).not.toContain("amber");
    const low = renderToStaticMarkup(React.createElement(HeaderCreditBalance, { creditBalance: 2, lowThreshold: 7 }));
    expect(low).toContain("amber");
  });
});

describe("paywall components", () => {
  it("renders the nudge with its links, and nothing without copy", () => {
    const html = renderToStaticMarkup(
      React.createElement(LowBalanceNudge, { copy: lowBalanceCopy(LIVE, 7), moment: "dashboard" }),
    );
    expect(html).toContain('data-testid="low-balance-nudge"');
    expect(html).toContain('href="/app/billing?checkout=starter&amp;cadence=monthly"');
    expect(renderToStaticMarkup(React.createElement(LowBalanceNudge, { copy: null, moment: "dashboard" }))).toBe("");
  });

  it("renders the dialog only when there is copy", () => {
    const onClose = () => undefined;
    expect(renderToStaticMarkup(React.createElement(OutOfCreditsDialog, { copy: null, onClose }))).toBe("");
    const html = renderToStaticMarkup(
      React.createElement(OutOfCreditsDialog, { copy: outOfCreditsCopy(EARLY, 7), onClose }),
    );
    expect(html).toContain('data-testid="out-of-credits-dialog"');
    expect(html).toContain("Not enough credits for this pack");
    expect(html).toContain('href="/app/billing"');
    expect(html).not.toContain("checkout");
  });
});

describe("new pack form paywall helpers", () => {
  it("opens the dialog only for a 402 balance refusal of a pack with billable shots", () => {
    expect(isOutOfCreditsRefusal(402, "insufficient_credits", 7)).toBe(true);
    // createJob uses the same reason for a pick that plans no billable shots.
    expect(isOutOfCreditsRefusal(402, "insufficient_credits", 0)).toBe(false);
    expect(isOutOfCreditsRefusal(402, "upgrade_required", 7)).toBe(false);
    expect(isOutOfCreditsRefusal(400, "insufficient_credits", 7)).toBe(false);
    expect(isOutOfCreditsRefusal(402, undefined, 7)).toBe(false);
  });

  it("warns in the summary when the estimate is more than the balance", () => {
    expect(estimateOverBalanceLine(7, 3)).toBe(
      "This pack needs about 7 credits, more than you have. Pick fewer channels or add credits.",
    );
    expect(estimateOverBalanceLine(7, 7)).toBeNull();
    expect(estimateOverBalanceLine(0, 3)).toBeNull();
    // A balance below zero already has its own line.
    expect(estimateOverBalanceLine(7, -2)).toBeNull();
  });
});
