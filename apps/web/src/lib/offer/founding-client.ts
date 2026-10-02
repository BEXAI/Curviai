/**
 * The browser side of the founding member banner (docs/phases/PHASE_18.md
 * P18-21): one GET /api/offer per page and per minute at most. Client safe:
 * no server imports. Anything unexpected reads as no banner, so a broken
 * route never shows a wrong code or seat count.
 */

import type { FoundingOfferView } from "./founding";

export const OFFER_PATH = "/api/offer";

/** A page reuses its answer for this long before asking again. */
export const CLIENT_OFFER_TTL_MS = 60_000;

/** Where a visitor's "hide" is remembered (per browser only). */
export const FOUNDING_DISMISS_KEY = "curvi_founding_offer_hidden";

const CODE = /^[A-Za-z0-9-]{1,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The route's body as a view, or null. */
export function parseOfferBody(body: unknown): FoundingOfferView | null {
  const founding = (body as { founding?: unknown } | null)?.founding;
  if (!founding || typeof founding !== "object") {
    return null;
  }
  const view = founding as Record<string, unknown>;
  const annualCode = view.annualCode;
  if (
    typeof view.code !== "string" ||
    !CODE.test(view.code) ||
    !(annualCode === null || (typeof annualCode === "string" && CODE.test(annualCode))) ||
    !count(view.seats) ||
    !count(view.left) ||
    view.left <= 0 ||
    view.left > view.seats ||
    typeof view.monthlyUsd !== "number" ||
    !(view.monthlyUsd > 0) ||
    typeof view.annualUsd !== "number" ||
    !(view.annualUsd > 0) ||
    typeof view.endsOn !== "string" ||
    !DAY.test(view.endsOn)
  ) {
    return null;
  }
  return {
    code: view.code,
    annualCode: annualCode as string | null,
    monthlyUsd: view.monthlyUsd,
    annualUsd: view.annualUsd,
    seats: view.seats,
    left: view.left,
    endsOn: view.endsOn,
  };
}

let cached: { at: number; view: Promise<FoundingOfferView | null> } | null = null;

/** The banner as the browser sees it. Never rejects. */
export function fetchFoundingOffer(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<FoundingOfferView | null> {
  if (cached && now() - cached.at < CLIENT_OFFER_TTL_MS) {
    return cached.view;
  }
  const view = fetchImpl(OFFER_PATH, { credentials: "omit", headers: { accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then(parseOfferBody)
    .catch(() => null);
  cached = { at: now(), view };
  return view;
}

/** Whether this browser hid the banner for this offer (keyed on its last
 * day, so a later offer shows again). Storage can be missing or throw. */
export function foundingOfferHidden(endsOn: string, storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(FOUNDING_DISMISS_KEY) === endsOn;
  } catch {
    return false;
  }
}

/** Remembers the hide. A failed write only means it shows again next visit. */
export function hideFoundingOffer(endsOn: string, storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(FOUNDING_DISMISS_KEY, endsOn);
  } catch {
    // Private mode or blocked storage: hidden for this page view only.
  }
}

/** Forgets the cached answer (tests). */
export function resetClientFoundingOfferForTests(): void {
  cached = null;
}
