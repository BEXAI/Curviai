import { afterEach, describe, expect, it, vi } from "vitest";
import { foundingMemberOffer } from "@curvi/pipeline/seed";
import {
  FOUNDING_DISMISS_KEY,
  fetchFoundingOffer,
  foundingOfferHidden,
  hideFoundingOffer,
  parseOfferBody,
  resetClientFoundingOfferForTests,
} from "./founding-client";

// The browser side of the founding banner (P18-21): anything unexpected
// from /api/offer reads as no banner, and a hide is remembered per offer.

const view = {
  code: foundingMemberOffer.code,
  annualCode: foundingMemberOffer.annualCode,
  monthlyUsd: foundingMemberOffer.monthlyUsd,
  annualUsd: foundingMemberOffer.annualUsd,
  seats: foundingMemberOffer.seats,
  left: 12,
  endsOn: foundingMemberOffer.endsOn,
};

afterEach(() => {
  resetClientFoundingOfferForTests();
});

describe("parseOfferBody", () => {
  it("accepts the route's view", () => {
    expect(parseOfferBody({ founding: view })).toEqual(view);
    expect(parseOfferBody({ founding: { ...view, annualCode: null } })).toEqual({ ...view, annualCode: null });
  });

  it("reads no banner, a malformed one or an impossible seat count as none", () => {
    for (const body of [
      null,
      {},
      { founding: null },
      { founding: { ...view, code: "<script>" } },
      { founding: { ...view, left: 0 } },
      { founding: { ...view, left: view.seats + 1 } },
      { founding: { ...view, left: 1.5 } },
      { founding: { ...view, endsOn: "soon" } },
      { founding: { ...view, monthlyUsd: "19" } },
      { founding: { ...view, annualCode: 5 } },
    ]) {
      expect(parseOfferBody(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("fetchFoundingOffer", () => {
  it("asks once per minute and never rejects", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ founding: view }), { status: 200 }));
    expect(await fetchFoundingOffer(fetchImpl as unknown as typeof fetch, () => now)).toEqual(view);
    now = 59_999;
    await fetchFoundingOffer(fetchImpl as unknown as typeof fetch, () => now);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resetClientFoundingOfferForTests();
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await fetchFoundingOffer(failing as unknown as typeof fetch, () => now)).toBeNull();
  });
});

describe("hiding the banner", () => {
  it("remembers the hide for this offer only and survives storage that throws", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(foundingOfferHidden(view.endsOn, storage)).toBe(false);
    hideFoundingOffer(view.endsOn, storage);
    expect(store.get(FOUNDING_DISMISS_KEY)).toBe(view.endsOn);
    expect(foundingOfferHidden(view.endsOn, storage)).toBe(true);
    expect(foundingOfferHidden("2027-01-31", storage)).toBe(false);

    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(foundingOfferHidden(view.endsOn, broken)).toBe(false);
    expect(() => hideFoundingOffer(view.endsOn, broken)).not.toThrow();
    expect(foundingOfferHidden(view.endsOn, null)).toBe(false);
  });
});
