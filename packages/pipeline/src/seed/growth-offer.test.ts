import { describe, expect, it } from "vitest";
import { creditExpiry, foundingMemberOffer, platformSettingSeedRows, referralReward, tierByKey } from "./credits";
import { opsSwitchDefaults } from "./operations";
import {
  FOUNDING_OFFER_SETTING,
  REFERRALS_SETTING,
  foundingOfferBanner,
  offerSwitches,
  referralCodePolicy,
  studioPriceComparison,
} from "./growth";
import * as seed from "./index";

// Lane 9 Offer seed (docs/phases/PHASE_18.md P18-21 and P18-24, founder
// decisions 12, 13 and 18). The numbers are the decision defaults; a change is a seed change,
// never code (CLAUDE.md rule 2).

describe("founding member offer (decision 13)", () => {
  it("is 50 seats on Starter at $19 a month or $190 a year, open through 2026-11-30", () => {
    expect(foundingMemberOffer).toMatchObject({ seats: 50, monthlyUsd: 19, annualUsd: 190, endsOn: "2026-11-30" });
    expect(foundingMemberOffer.monthlyUsd).toBeLessThan(tierByKey("starter").monthlyUsd);
    expect(foundingMemberOffer.annualUsd).toBeLessThan(tierByKey("starter").annualUsdPerMonth * 12);
  });

  it("has two different promotion codes Stripe accepts as code text", () => {
    for (const code of [foundingMemberOffer.code, foundingMemberOffer.annualCode]) {
      expect(code).toMatch(/^[A-Za-z0-9-]{1,40}$/);
    }
    expect(foundingMemberOffer.code.toLowerCase()).not.toBe(foundingMemberOffer.annualCode.toLowerCase());
  });

  it("ships the banner switched off until decision 18, an operator switch the seed never writes", () => {
    // P20-20: an operator switch under its ops: key, never seeded, so no
    // later seed resets it; a missing row reads as the default.
    expect(offerSwitches).toEqual([]);
    expect(platformSettingSeedRows.filter((row) => row.key.endsWith("founding_offer_enabled"))).toEqual([]);
    expect(opsSwitchDefaults[FOUNDING_OFFER_SETTING]).toMatchObject({ default: false });
  });

  it("caches the Stripe read for minutes and bounds each call", () => {
    expect(foundingOfferBanner.cacheSeconds).toBeGreaterThanOrEqual(60);
    expect(foundingOfferBanner.failureCacheSeconds).toBeLessThanOrEqual(foundingOfferBanner.cacheSeconds);
    expect(foundingOfferBanner.stripeTimeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe("referral reward (decision 12)", () => {
  it("is 50 credits to each side, at most 10 rewards per referrer a month, with no expiry (P20-05)", () => {
    expect(referralReward).toEqual({ credits: 50, monthlyCapPerReferrer: 10, clawbackDays: 30 });
    expect(creditExpiry).toEqual({ kind: "none" });
  });

  it("ships switched off until decision 18, an operator switch the seed never writes", () => {
    // P20-20: an operator switch under its ops: key, never seeded, so no
    // later seed resets it; a missing row reads as the default.
    expect(platformSettingSeedRows.filter((row) => row.key.endsWith("referrals_enabled"))).toEqual([]);
    expect(opsSwitchDefaults[REFERRALS_SETTING]).toMatchObject({ default: false });
  });

  it("issues codes the ref landing parameter carries (4 to 32 lower case letters and digits)", () => {
    expect(referralCodePolicy.length).toBeGreaterThanOrEqual(4);
    expect(referralCodePolicy.length).toBeLessThanOrEqual(32);
    expect(referralCodePolicy.issueAttempts).toBeGreaterThan(1);
  });

  it("is reachable through the seed index", () => {
    expect(seed.referralReward).toBe(referralReward);
    expect(seed.referralCodePolicy).toBe(referralCodePolicy);
  });
});

describe("studio price comparison", () => {
  it("is dated and sourced (docs/verification.md)", () => {
    expect(studioPriceComparison.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(studioPriceComparison.source).toMatch(/^https:\/\//);
    expect(studioPriceComparison.usdPerPhoto).toBeGreaterThan(0);
  });

  it("is reachable through the seed index", () => {
    expect(seed.studioPriceComparison).toBe(studioPriceComparison);
    expect(seed.foundingMemberOffer).toBe(foundingMemberOffer);
  });
});
