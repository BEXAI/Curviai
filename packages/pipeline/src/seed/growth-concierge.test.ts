import { describe, expect, it } from "vitest";
import { hasSpec } from "@curvi/specs";
import { mainImageCheckerSpecIds, packFeedback, prospectClaims, shareLoop, staffMonthlyCreditCap } from "./growth";
import { channelChoices } from "./questions";

describe("prospect claims and credits (P18-04)", () => {
  it("caps prospect credits per month at a positive whole number above one add", () => {
    expect(Number.isInteger(staffMonthlyCreditCap) && staffMonthlyCreditCap > 0).toBe(true);
    expect(prospectClaims.maxCreditsPerAdd).toBeLessThanOrEqual(staffMonthlyCreditCap);
  });

  it("keeps a claim link 30 days and makes tokens the signup link accepts", () => {
    expect(prospectClaims.lifetimeDays).toBe(30);
    // Hex: two characters per byte; lib/attribution.ts takes 16 to 64.
    expect(prospectClaims.tokenBytes * 2).toBeGreaterThanOrEqual(32);
    expect(prospectClaims.tokenBytes * 2).toBeLessThanOrEqual(64);
  });

  it("starts with seeded channel choices and measures with a checker spec", () => {
    const values = channelChoices.map((choice) => choice.value);
    for (const channel of prospectClaims.defaultChannels) {
      expect(values).toContain(channel);
    }
    expect(hasSpec(prospectClaims.kitChannelSpec)).toBe(true);
    expect(mainImageCheckerSpecIds as readonly string[]).toContain(prospectClaims.kitChannelSpec);
    expect(prospectClaims.draftNoteMaxWords).toBe(80);
  });
});

// Lane 6 Concierge (P18-05, P18-14, P18-04): the seeded numbers.

describe("pack feedback", () => {
  it("keeps the caps the pack_feedback checks hold (500 and 60 characters)", () => {
    expect(packFeedback.commentMaxChars).toBe(500);
    expect(packFeedback.displayNameMaxChars).toBe(60);
  });

  it("uses positive whole numbers", () => {
    for (const [key, value] of Object.entries(packFeedback)) {
      expect(Number.isInteger(value) && value > 0, key).toBe(true);
    }
  });

  it("lets a feedback link outlive the day 2 email by more than a week", () => {
    expect(packFeedback.linkDays).toBeGreaterThanOrEqual(9);
  });
});

describe("share loop", () => {
  it("tags shared links with utm_medium share and utm_campaign pack_share (P18-14)", () => {
    expect(shareLoop.utmMedium).toBe("share");
    expect(shareLoop.utmCampaign).toBe("pack_share");
  });

  it("rereads the sitemap's shares hourly and caps them", () => {
    expect(shareLoop.sitemapRefreshSeconds).toBe(3600);
    expect(Number.isInteger(shareLoop.sitemapMaxShares) && shareLoop.sitemapMaxShares > 0).toBe(true);
  });
});
