import { describe, expect, it } from "vitest";
import { platformSettingSeedRows } from "./credits";
import { opsSwitchDefaults } from "./operations";
import {
  LIFECYCLE_EMAIL_SETTING,
  emailLimits,
  emailSwitches,
  growthPlatformSettingSeedRows,
  lifecycleSchedule,
  lifecycleTemplateKeys,
} from "./growth";

// Lane 3 Email seed (docs/phases/PHASE_18.md P18-06): the send caps sit
// inside Resend's free tier (100 a day, 3,000 a month, 10 requests a
// second, checked 2026-10-01) with room for the auth mail and founder
// alerts on the same account; the switch ships off and a reseed never
// flips it (CLAUDE.md rule 2: numbers live here, not in code).

describe("emailLimits", () => {
  it("stays inside Resend's free tier with room for auth mail", () => {
    expect(emailLimits.perUtcDay).toBeLessThan(100);
    expect(emailLimits.perUtcDay * 31).toBeLessThan(3000);
    expect(emailLimits.perRun).toBeLessThanOrEqual(emailLimits.perUtcDay);
    // At most 10 requests a second.
    expect(emailLimits.sendSpacingMs).toBeGreaterThanOrEqual(100);
  });

  it("retries a failed send a few times and never waits longer than Resend keeps an idempotency key", () => {
    expect(emailLimits.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(emailLimits.staleClaimMinutes).toBeLessThan(24 * 60);
    expect(emailLimits.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});

describe("lifecycle_email_enabled", () => {
  it("ships off as an operator switch the seed never writes", () => {
    // P20-20: an operator switch under its ops: key, never seeded, so no
    // later seed resets it; a missing row reads as the default.
    expect(LIFECYCLE_EMAIL_SETTING).toBe("ops:lifecycle_email_enabled");
    expect(emailSwitches).toEqual([]);
    expect(growthPlatformSettingSeedRows.filter((row) => row.key.endsWith("lifecycle_email_enabled"))).toEqual([]);
    expect(platformSettingSeedRows.filter((row) => row.key.endsWith("lifecycle_email_enabled"))).toEqual([]);
    expect(opsSwitchDefaults[LIFECYCLE_EMAIL_SETTING]).toMatchObject({ default: false });
  });
});

describe("lifecycleSchedule (P18-07)", () => {
  it("times every lifecycle template, the plan's delays included", () => {
    expect(Object.keys(lifecycleSchedule.templates).sort()).toEqual([...lifecycleTemplateKeys].sort());
    const t = lifecycleSchedule.templates;
    expect(t.first_pack_nudge_1.afterHours).toBe(24);
    expect(t.first_pack_nudge_2.afterHours).toBe(72);
    expect(t.feedback_ask.afterHours).toBe(48);
    expect(t.win_back.afterHours).toBe(21 * 24);
    expect(t.lead_tip.afterHours).toBe(72);
    expect(t.lead_offer.afterHours).toBe(240);
    expect(lifecycleSchedule.outOfCreditsRepeatDays).toBe(30);
    for (const [key, timing] of Object.entries(t)) {
      expect(timing.maxLateHours, key).toBeGreaterThan(0);
    }
  });

  it("holds the pack invitations while packs are paused, never the transactional mail", () => {
    const held = Object.entries(lifecycleSchedule.templates)
      .filter(([, timing]) => timing.holdWhilePaused)
      .map(([key]) => key)
      .sort();
    expect(held).toEqual(["first_pack_nudge_1", "first_pack_nudge_2", "lead_offer", "lead_tip", "out_of_credits", "win_back"]);
  });

  it("enables signed feedback and reward receipts within the unchanged lifecycle gate, and skips paid nudges", () => {
    expect(lifecycleSchedule.templates.feedback_ask.enabled).toBe(true);
    expect(lifecycleSchedule.templates.referral_rewarded).toMatchObject({ enabled: true, afterHours: 0, holdWhilePaused: false });
    expect(lifecycleSchedule.nudgePlans).toEqual(["free"]);
    expect(lifecycleSchedule.outOfCreditsPlans).toEqual(["free", "starter"]);
  });

  it("reads back far enough for the latest win back", () => {
    const winBack = lifecycleSchedule.templates.win_back;
    expect(lifecycleSchedule.lookbackDays * 24).toBeGreaterThan(winBack.afterHours + winBack.maxLateHours);
  });
});
