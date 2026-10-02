import { describe, expect, it } from "vitest";
import {
  firstTouchCookieDays,
  funnelDigest,
  isSignupSourceChoiceKey,
  signupSourceChoices,
  validationGates,
} from "./growth";
import * as seed from "./index";

// Lane 1 Measure (docs/phases/PHASE_18.md P18-01 and P18-02): the signup
// answer choices, the first touch cookie lifetime, the weekly funnel email
// schedule and the dated validation gates live in the seed (CLAUDE.md
// rule 2).

// CLAUDE.md rule 9, as in apps/web/src/components/marketing/claims.test.ts.
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

describe("signup source choices", () => {
  it("are exported from the seed index", () => {
    expect(seed.signupSourceChoices).toBe(signupSourceChoices);
    expect(seed.validationGates).toBe(validationGates);
  });

  it("match the plan's eleven answers, in order, ending with Other", () => {
    expect(signupSourceChoices.map((choice) => choice.label)).toEqual([
      "Search engine",
      "ChatGPT or another AI assistant",
      "YouTube",
      "TikTok",
      "Instagram or Facebook",
      "Reddit",
      "A seller community or forum",
      "An email from Curvi",
      "A friend or colleague",
      "A directory or launch site",
      "Other",
    ]);
    expect(signupSourceChoices.at(-1)?.key).toBe("other");
  });

  it("have unique keys that fit the stored column", () => {
    const keys = signupSourceChoices.map((choice) => choice.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      expect(isSignupSourceChoiceKey(key)).toBe(true);
    }
    expect(isSignupSourceChoiceKey("Search engine")).toBe(false);
    expect(isSignupSourceChoiceKey(undefined)).toBe(false);
  });

  it("use plain copy", () => {
    for (const choice of signupSourceChoices) {
      expect(choice.label, choice.key).not.toMatch(FORBIDDEN_COPY);
    }
  });
});

describe("funnel digest and first touch numbers", () => {
  it("send weekly on Monday afternoon UTC over seven days since day 0", () => {
    expect(funnelDigest.sendWeekday).toBeGreaterThanOrEqual(1);
    expect(funnelDigest.sendWeekday).toBeLessThanOrEqual(7);
    expect(funnelDigest.sendHourUtc).toBeGreaterThanOrEqual(0);
    expect(funnelDigest.sendHourUtc).toBeLessThan(24);
    expect(funnelDigest.windowDays).toBe(7);
    expect(Number.isNaN(Date.parse(`${funnelDigest.since}T00:00:00Z`))).toBe(false);
    expect(funnelDigest.repeatWindowDays).toBe(30);
    expect(funnelDigest.topRows).toBeGreaterThan(0);
    expect(funnelDigest.pageWeeks).toBeGreaterThan(0);
  });

  it("keeps the first touch cookie for 90 days (founder decision 2)", () => {
    expect(firstTouchCookieDays).toBe(90);
  });
});

describe("validation gates", () => {
  it("follow the dated decisions of docs/marketing.md section 5.5", () => {
    const byKey = Object.fromEntries(validationGates.map((gate) => [gate.key, gate]));
    expect(byKey.day14_usable).toMatchObject({ date: "2026-10-15", target: 50, doubtBelow: 30, minSample: 10 });
    expect(byKey.day30_activation).toMatchObject({ date: "2026-10-31", target: 35, doubtBelow: 20, minSample: 20 });
    expect(byKey.day30_first_payments).toMatchObject({ date: "2026-10-31", target: 1, unit: "count" });
    expect(byKey.day60_payer_repeat).toMatchObject({ date: "2026-11-30", target: 20, unit: "percent" });
    expect(byKey.day60_paid_share).toMatchObject({ date: "2026-11-30", target: 3, unit: "percent" });
    expect(byKey.day90_payers).toMatchObject({ date: "2026-12-30", target: 10, unit: "count" });
  });

  it("have unique keys, dates on their day and plain labels", () => {
    const keys = validationGates.map((gate) => gate.key);
    expect(new Set(keys).size).toBe(keys.length);
    const dayZero = Date.parse(`${funnelDigest.since}T00:00:00Z`);
    for (const gate of validationGates) {
      const days = Math.round((Date.parse(`${gate.date}T00:00:00Z`) - dayZero) / 86_400_000);
      expect(days, gate.key).toBe(gate.day);
      expect(gate.label, gate.key).not.toMatch(FORBIDDEN_COPY);
      if (gate.doubtBelow !== null) {
        expect(gate.doubtBelow).toBeLessThan(gate.target);
      }
    }
  });
});
