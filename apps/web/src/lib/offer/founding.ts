/**
 * The founding member offer banner (docs/phases/PHASE_18.md P18-21,
 * founder decisions 13 and 18). Server side: whether the banner shows and
 * how many seats are left.
 *
 * The offer itself is two Stripe promotion codes the founder creates
 * (seed foundingMemberOffer: `code` for Starter monthly, `annualCode` for
 * Starter annual, `seats` shared, open through `endsOn`). Checkout already
 * accepts promotion codes, so nothing here touches Checkout.
 *
 * The banner shows only when every one of these holds:
 * - the ops:founding_offer_enabled switch is on (off by default until founder
 *   decision 18, the generative still price),
 * - today is on or before endsOn (a UTC day, inclusive),
 * - acquisition is open (P18-03: no offer while packs are paused),
 * - Stripe answers and the monthly code is active there (never a banner
 *   for a code Checkout would refuse),
 * - seats are left.
 *
 * Seats used are Stripe's own redemption counts (times_redeemed) summed
 * over every promotion code with either code text, active or not, the same
 * count max_redemptions enforces. The plan counted funnel checkout events
 * instead; those carry only the promotion code id, which needs this same
 * Stripe read to match the code text, so Stripe's count is read directly.
 *
 * Cached per process (seed foundingOfferBanner), with one computation in
 * flight. Never throws: any failure hides the banner.
 */

import type Stripe from "stripe";
import { foundingMemberOffer, foundingOfferBanner, FOUNDING_OFFER_SETTING } from "@curvi/pipeline/seed";
import { sql, type Db } from "@curvi/db";

export type FoundingOffer = typeof foundingMemberOffer;

/** What the banner shows. Only public facts: no ids, no Stripe objects. */
export interface FoundingOfferView {
  code: string;
  /** Null when the annual code is not active in Stripe. */
  annualCode: string | null;
  monthlyUsd: number;
  annualUsd: number;
  seats: number;
  left: number;
  /** YYYY-MM-DD, the last day the offer is open (UTC). */
  endsOn: string;
}

export type FoundingOfferHidden =
  | "switch_off"
  | "ended"
  | "waitlist"
  | "stripe_unavailable"
  | "code_inactive"
  | "sold_out";

export type FoundingOfferResult =
  | { show: true; view: FoundingOfferView }
  | { show: false; reason: FoundingOfferHidden };

/** One promotion code as Stripe lists it, reduced to what the count needs. */
export interface PromotionCodeReading {
  code: string;
  active: boolean;
  timesRedeemed: number;
  maxRedemptions: number | null;
  /** Unix seconds, or null when it never expires. */
  expiresAt: number | null;
}

export interface FoundingOfferInputs {
  now: number;
  switchOn: boolean;
  acquisitionOpen: boolean;
  /** Every promotion code with either code text, or null when Stripe is not
   * configured or could not be read. */
  promotionCodes: PromotionCodeReading[] | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The first instant after the offer closes: midnight UTC after endsOn.
 * NaN for a malformed date, which reads as ended. */
export function foundingOfferClosesAt(endsOn: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endsOn);
  if (!match) {
    return Number.NaN;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + DAY_MS;
}

/** True while today (UTC) is on or before endsOn. */
export function foundingOfferOpen(endsOn: string, now: number): boolean {
  const closes = foundingOfferClosesAt(endsOn);
  return Number.isFinite(closes) && now < closes;
}

function sameCode(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A code Checkout accepts right now. Stripe turns a code inactive at its
 * cap or expiry, and the extra checks cover a reading taken just before. */
function redeemable(reading: PromotionCodeReading, now: number): boolean {
  return (
    reading.active &&
    (reading.expiresAt === null || reading.expiresAt * 1000 > now) &&
    (reading.maxRedemptions === null || reading.timesRedeemed < reading.maxRedemptions)
  );
}

/** Seats taken: every redemption of either code, active or not. */
export function foundingSeatsUsed(offer: Pick<FoundingOffer, "code" | "annualCode">, codes: PromotionCodeReading[]): number {
  return codes
    .filter((reading) => sameCode(reading.code, offer.code) || sameCode(reading.code, offer.annualCode))
    .reduce((sum, reading) => sum + (Number.isFinite(reading.timesRedeemed) ? Math.max(0, reading.timesRedeemed) : 0), 0);
}

/** Pure: the banner for these inputs. */
export function evaluateFoundingOffer(offer: FoundingOffer, inputs: FoundingOfferInputs): FoundingOfferResult {
  if (!inputs.switchOn) {
    return { show: false, reason: "switch_off" };
  }
  if (!foundingOfferOpen(offer.endsOn, inputs.now)) {
    return { show: false, reason: "ended" };
  }
  if (!inputs.acquisitionOpen) {
    return { show: false, reason: "waitlist" };
  }
  const codes = inputs.promotionCodes;
  if (!codes) {
    return { show: false, reason: "stripe_unavailable" };
  }
  if (!codes.some((reading) => sameCode(reading.code, offer.code) && redeemable(reading, inputs.now))) {
    return { show: false, reason: "code_inactive" };
  }
  const left = Math.max(0, offer.seats - foundingSeatsUsed(offer, codes));
  if (left <= 0) {
    return { show: false, reason: "sold_out" };
  }
  const annualActive = codes.some(
    (reading) => sameCode(reading.code, offer.annualCode) && redeemable(reading, inputs.now),
  );
  return {
    show: true,
    view: {
      code: offer.code,
      annualCode: annualActive ? offer.annualCode : null,
      monthlyUsd: offer.monthlyUsd,
      annualUsd: offer.annualUsd,
      seats: offer.seats,
      left,
      endsOn: offer.endsOn,
    },
  };
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

/** The founder's switch. Only a stored true turns the banner on. */
export async function readFoundingOfferSwitch(db: Pick<Db, "execute">): Promise<boolean> {
  const rows = rowsOf<{ on: unknown }>(
    await db.execute(sql`select value = 'true'::jsonb as on from platform_settings where key = ${FOUNDING_OFFER_SETTING}`),
  );
  return rows[0]?.on === true;
}

/** Lists the promotion codes with each code text (Stripe matches case
 * insensitively). One attempt per call, bounded by the seeded timeout. */
export async function readPromotionCodes(
  stripe: Pick<Stripe, "promotionCodes">,
  codes: readonly string[],
): Promise<PromotionCodeReading[]> {
  const readings: PromotionCodeReading[] = [];
  for (const code of codes) {
    const list = await stripe.promotionCodes.list(
      { code, limit: 100 },
      { timeout: foundingOfferBanner.stripeTimeoutMs, maxNetworkRetries: 0 },
    );
    for (const promo of list.data) {
      readings.push({
        code: promo.code,
        active: promo.active === true,
        timesRedeemed: typeof promo.times_redeemed === "number" ? promo.times_redeemed : 0,
        maxRedemptions: typeof promo.max_redemptions === "number" ? promo.max_redemptions : null,
        expiresAt: typeof promo.expires_at === "number" ? promo.expires_at : null,
      });
    }
  }
  return readings;
}

export interface FoundingOfferDeps {
  now?: () => number;
  /** Read through the cache unless fresh. */
  fresh?: boolean;
  readSwitch?: () => Promise<boolean>;
  acquisitionOpen?: () => Promise<boolean>;
  /** null when Stripe is not configured. */
  readCodes?: () => Promise<PromotionCodeReading[] | null>;
  log?: Pick<Console, "warn">;
}

const scope = globalThis as typeof globalThis & {
  __curviFoundingOffer?: { result: FoundingOfferResult; at: number; ttlMs: number };
  __curviFoundingOfferInFlight?: Promise<FoundingOfferResult>;
};

async function defaultReadSwitch(): Promise<boolean> {
  const { isDbMode } = await import("@/lib/services");
  if (!isDbMode()) {
    // Demo mode has no platform_settings: the banner stays off.
    return false;
  }
  const { getDb } = await import("@/lib/services/db");
  return readFoundingOfferSwitch(getDb());
}

async function defaultAcquisitionOpen(): Promise<boolean> {
  const { acquisitionStatus } = await import("@/lib/acquisition");
  return (await acquisitionStatus()).state === "open";
}

async function defaultReadCodes(): Promise<PromotionCodeReading[] | null> {
  // The banner sells, so it follows the checkout readiness (P20-01).
  const { isCheckoutOpen } = await import("@/lib/env");
  if (!isCheckoutOpen()) {
    return null;
  }
  const { getStripe } = await import("@/lib/billing/stripe");
  return readPromotionCodes(getStripe(), [foundingMemberOffer.code, foundingMemberOffer.annualCode]);
}

async function compute(deps: FoundingOfferDeps, now: number): Promise<{ result: FoundingOfferResult; failed: boolean }> {
  const log = deps.log ?? console;
  let failed = false;
  const switchOn = await (deps.readSwitch ?? defaultReadSwitch)().catch((err: unknown) => {
    log.warn("[founding-offer] could not read the switch; the banner stays off", err);
    failed = true;
    return false;
  });
  // The cheap checks first, so a banner that is off costs no Stripe call.
  const early = evaluateFoundingOffer(foundingMemberOffer, {
    now,
    switchOn,
    acquisitionOpen: true,
    promotionCodes: [],
  });
  if (!early.show && (early.reason === "switch_off" || early.reason === "ended")) {
    return { result: early, failed };
  }
  const acquisitionOpen = await (deps.acquisitionOpen ?? defaultAcquisitionOpen)().catch(() => false);
  if (!acquisitionOpen) {
    return { result: { show: false, reason: "waitlist" }, failed };
  }
  const promotionCodes = await (deps.readCodes ?? defaultReadCodes)().catch((err: unknown) => {
    log.warn("[founding-offer] could not read the promotion codes from Stripe; the banner stays off", err);
    failed = true;
    return null;
  });
  return {
    result: evaluateFoundingOffer(foundingMemberOffer, { now, switchOn, acquisitionOpen, promotionCodes }),
    failed,
  };
}

/** The banner for this process, cached. Never throws. */
export async function foundingOfferStatus(deps: FoundingOfferDeps = {}): Promise<FoundingOfferResult> {
  const now = deps.now ?? Date.now;
  const cached = scope.__curviFoundingOffer;
  if (!deps.fresh && cached && now() - cached.at < cached.ttlMs) {
    return cached.result;
  }
  if (!deps.fresh && scope.__curviFoundingOfferInFlight) {
    return scope.__curviFoundingOfferInFlight;
  }
  const work = (async (): Promise<FoundingOfferResult> => {
    try {
      const { result, failed } = await compute(deps, now());
      scope.__curviFoundingOffer = {
        result,
        at: now(),
        ttlMs: (failed ? foundingOfferBanner.failureCacheSeconds : foundingOfferBanner.cacheSeconds) * 1000,
      };
      return result;
    } catch {
      return { show: false, reason: "stripe_unavailable" };
    }
  })();
  scope.__curviFoundingOfferInFlight = work;
  try {
    return await work;
  } finally {
    if (scope.__curviFoundingOfferInFlight === work) {
      delete scope.__curviFoundingOfferInFlight;
    }
  }
}

/** Forgets the cached banner (tests). */
export function resetFoundingOfferForTests(): void {
  delete scope.__curviFoundingOffer;
  delete scope.__curviFoundingOfferInFlight;
}
