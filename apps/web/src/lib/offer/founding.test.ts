/**
 * The founding member banner (docs/phases/PHASE_18.md P18-21, founder
 * decisions 13 and 18): visible only while the switch is on, the offer is
 * open, packs run, the code is live in Stripe and seats are left.
 */

import type Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { foundingMemberOffer, foundingOfferBanner, FOUNDING_OFFER_SETTING } from "@curvi/pipeline/seed";
import { platformSettings } from "@curvi/db/schema";
import { createTestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import {
  evaluateFoundingOffer,
  foundingOfferClosesAt,
  foundingOfferOpen,
  foundingOfferStatus,
  foundingSeatsUsed,
  readFoundingOfferSwitch,
  readPromotionCodes,
  resetFoundingOfferForTests,
  type PromotionCodeReading,
} from "./founding";

const offer = foundingMemberOffer;
const OPEN_DAY = Date.UTC(2026, 9, 15, 12);
const LAST_MOMENT = foundingOfferClosesAt(offer.endsOn) - 1;

function reading(code: string, timesRedeemed = 0, extra: Partial<PromotionCodeReading> = {}): PromotionCodeReading {
  return { code, active: true, timesRedeemed, maxRedemptions: offer.seats, expiresAt: null, ...extra };
}

const live = { now: OPEN_DAY, switchOn: true, acquisitionOpen: true };

afterEach(() => {
  resetFoundingOfferForTests();
});

describe("foundingOfferOpen", () => {
  it("is open through the whole of endsOn in UTC and closed from the next midnight", () => {
    expect(foundingOfferClosesAt("2026-11-30")).toBe(Date.UTC(2026, 11, 1));
    expect(foundingOfferOpen("2026-11-30", Date.UTC(2026, 10, 30, 23, 59, 59))).toBe(true);
    expect(foundingOfferOpen("2026-11-30", Date.UTC(2026, 11, 1))).toBe(false);
  });

  it("reads a malformed day as ended", () => {
    expect(foundingOfferOpen("November 30", OPEN_DAY)).toBe(false);
  });
});

describe("evaluateFoundingOffer", () => {
  it("shows the seeded offer with the seats left and both codes", () => {
    const result = evaluateFoundingOffer(offer, { ...live, promotionCodes: [reading(offer.code, 3), reading(offer.annualCode, 2)] });
    expect(result).toEqual({
      show: true,
      view: {
        code: offer.code,
        annualCode: offer.annualCode,
        monthlyUsd: offer.monthlyUsd,
        annualUsd: offer.annualUsd,
        seats: offer.seats,
        left: offer.seats - 5,
        endsOn: offer.endsOn,
      },
    });
  });

  it("stays off while the switch is off (founder decision 18)", () => {
    expect(evaluateFoundingOffer(offer, { ...live, switchOn: false, promotionCodes: [reading(offer.code)] })).toEqual({
      show: false,
      reason: "switch_off",
    });
  });

  it("hides after endsOn and shows on its last moment", () => {
    const codes = [reading(offer.code)];
    expect(evaluateFoundingOffer(offer, { ...live, now: LAST_MOMENT, promotionCodes: codes }).show).toBe(true);
    expect(evaluateFoundingOffer(offer, { ...live, now: LAST_MOMENT + 1, promotionCodes: codes })).toEqual({
      show: false,
      reason: "ended",
    });
  });

  it("hides while acquisition is waitlisted", () => {
    expect(
      evaluateFoundingOffer(offer, { ...live, acquisitionOpen: false, promotionCodes: [reading(offer.code)] }),
    ).toEqual({ show: false, reason: "waitlist" });
  });

  it("hides when Stripe cannot be read or the monthly code is not live there", () => {
    expect(evaluateFoundingOffer(offer, { ...live, promotionCodes: null })).toEqual({
      show: false,
      reason: "stripe_unavailable",
    });
    for (const codes of [
      [],
      [reading(offer.annualCode)],
      [reading(offer.code, 0, { active: false })],
      [reading(offer.code, 0, { expiresAt: Math.floor(OPEN_DAY / 1000) - 1 })],
      [reading(offer.code, 4, { maxRedemptions: 4 })],
    ]) {
      expect(evaluateFoundingOffer(offer, { ...live, promotionCodes: codes })).toEqual({
        show: false,
        reason: "code_inactive",
      });
    }
  });

  it("hides at zero seats, counting every redemption of either code", () => {
    const half = Math.floor(offer.seats / 2);
    const codes = [
      reading(offer.code, half, { maxRedemptions: null }),
      reading(offer.annualCode, offer.seats - half, { maxRedemptions: null }),
    ];
    expect(evaluateFoundingOffer(offer, { ...live, promotionCodes: codes })).toEqual({ show: false, reason: "sold_out" });
    const oneLeft = [
      reading(offer.code, half, { maxRedemptions: null }),
      reading(offer.annualCode, offer.seats - half - 1, { maxRedemptions: null }),
    ];
    const result = evaluateFoundingOffer(offer, { ...live, promotionCodes: oneLeft });
    expect(result.show && result.view.left).toBe(1);
  });

  it("drops the annual line when the annual code is not live, and matches codes in any case", () => {
    const result = evaluateFoundingOffer(offer, {
      ...live,
      promotionCodes: [reading(offer.code.toLowerCase(), 1), reading(offer.annualCode, 1, { active: false })],
    });
    expect(result.show && result.view).toMatchObject({ annualCode: null, left: offer.seats - 2 });
  });
});

describe("foundingSeatsUsed", () => {
  it("adds the founding codes only, inactive ones included, and ignores other codes", () => {
    expect(
      foundingSeatsUsed(offer, [
        reading(offer.code, 2),
        reading(offer.code, 1, { active: false }),
        reading(offer.annualCode, 4),
        reading("OTHER", 9),
        reading(offer.code, Number.NaN),
      ]),
    ).toBe(7);
  });
});

describe("readPromotionCodes", () => {
  it("lists each code text with one bounded attempt and keeps only the counting fields", async () => {
    const list = vi.fn(async (params: { code: string }) => ({
      data: [
        {
          id: `promo_${params.code}`,
          code: params.code,
          active: true,
          times_redeemed: params.code === offer.code ? 3 : 1,
          max_redemptions: 50,
          expires_at: 1_796_083_200,
        },
      ],
    }));
    const stripe = { promotionCodes: { list } } as unknown as Pick<Stripe, "promotionCodes">;
    const readings = await readPromotionCodes(stripe, [offer.code, offer.annualCode]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]).toEqual([
      { code: offer.code, limit: 100 },
      { timeout: foundingOfferBanner.stripeTimeoutMs, maxNetworkRetries: 0 },
    ]);
    expect(readings).toEqual([
      { code: offer.code, active: true, timesRedeemed: 3, maxRedemptions: 50, expiresAt: 1_796_083_200 },
      { code: offer.annualCode, active: true, timesRedeemed: 1, maxRedemptions: 50, expiresAt: 1_796_083_200 },
    ]);
  });
});

describe("readFoundingOfferSwitch", () => {
  it("is on only for a stored true", async () => {
    const { client, db } = await createTestDb();
    try {
      expect(await readFoundingOfferSwitch(db as unknown as Db)).toBe(false);
      await db.insert(platformSettings).values({ key: FOUNDING_OFFER_SETTING, value: "true" });
      expect(await readFoundingOfferSwitch(db as unknown as Db)).toBe(false);
      await client.query("update platform_settings set value = 'true'::jsonb where key = $1", [FOUNDING_OFFER_SETTING]);
      expect(await readFoundingOfferSwitch(db as unknown as Db)).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("foundingOfferStatus", () => {
  it("makes no Stripe call while the switch is off", async () => {
    const readCodes = vi.fn(async () => [reading(offer.code)]);
    const result = await foundingOfferStatus({
      now: () => OPEN_DAY,
      readSwitch: async () => false,
      acquisitionOpen: async () => true,
      readCodes,
    });
    expect(result).toEqual({ show: false, reason: "switch_off" });
    expect(readCodes).not.toHaveBeenCalled();
  });

  it("caches the answer per process and reads again after the seeded time", async () => {
    let now = OPEN_DAY;
    const readCodes = vi.fn(async () => [reading(offer.code, 1)]);
    const deps = { now: () => now, readSwitch: async () => true, acquisitionOpen: async () => true, readCodes };
    expect((await foundingOfferStatus(deps)).show).toBe(true);
    now += foundingOfferBanner.cacheSeconds * 1000 - 1;
    await foundingOfferStatus(deps);
    expect(readCodes).toHaveBeenCalledTimes(1);
    now += 1;
    await foundingOfferStatus(deps);
    expect(readCodes).toHaveBeenCalledTimes(2);
  });

  it("hides the banner on a Stripe failure and retries sooner", async () => {
    let now = OPEN_DAY;
    const readCodes = vi.fn(async (): Promise<PromotionCodeReading[]> => {
      throw new Error("stripe down");
    });
    const log = { warn: vi.fn() };
    const deps = { now: () => now, readSwitch: async () => true, acquisitionOpen: async () => true, readCodes, log };
    expect(await foundingOfferStatus(deps)).toEqual({ show: false, reason: "stripe_unavailable" });
    expect(log.warn).toHaveBeenCalled();
    now += foundingOfferBanner.failureCacheSeconds * 1000;
    await foundingOfferStatus(deps);
    expect(readCodes).toHaveBeenCalledTimes(2);
  });

  it("hides while packs are paused without reading Stripe", async () => {
    const readCodes = vi.fn(async () => [reading(offer.code)]);
    const result = await foundingOfferStatus({
      now: () => OPEN_DAY,
      readSwitch: async () => true,
      acquisitionOpen: async () => false,
      readCodes,
    });
    expect(result).toEqual({ show: false, reason: "waitlist" });
    expect(readCodes).not.toHaveBeenCalled();
  });

  it("stays off in demo mode, where there is no switch to read", async () => {
    vi.stubEnv("DATABASE_URL", "");
    try {
      expect(await foundingOfferStatus({ now: () => OPEN_DAY, fresh: true })).toEqual({ show: false, reason: "switch_off" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
