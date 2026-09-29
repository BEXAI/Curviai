import { describe, expect, it, vi } from "vitest";
import { CHANNEL_LIMIT_REASON } from "@curvi/pipeline";
import { HARMONIZE_SHAPE_REFUSED, ISOLATION_FAILED, PRODUCT_TOUCHING } from "@curvi/trigger/live-runtime";
import {
  SHOT_CHANNEL_FULL,
  SHOT_CONTENT_BLOCKED,
  SHOT_EXTRA_ITEMS,
  SHOT_NOT_DELIVERED,
  SHOT_PROVIDER_TROUBLE,
} from "@curvi/trigger/runner";
import { SETTLED_JOB_MESSAGES } from "@/lib/jobs/enqueue";
import { needsReviewNote, packSummaryLine, publicJobError, skippedCopy } from "./job-copy";

// enqueue.ts schedules inline packs with next/server's after(); only its
// settled messages are read here.
vi.mock("next/server", () => ({ after: vi.fn() }));

// Rule 9: plain spoken, no emojis, no arrows, no dashes as punctuation.
const FORBIDDEN = /[–—→←]| - |->|=>|[\u{1F300}-\u{1FAFF}]/u;

describe("skippedCopy", () => {
  it("names the planner reasons a seller can act on", () => {
    expect(skippedCopy("needs photo").label).toBe("Needs photo");
    expect(skippedCopy("not included in this plan tier").label).toBe("Not in your plan");
    expect(skippedCopy("Pro or Agency only").label).toBe("Not in your plan");
    expect(skippedCopy("provider not enabled").label).toBe("Coming soon");
    expect(skippedCopy("seller did not list contents").label).toBe("Needs details");
    expect(skippedCopy("dimensions not confirmed by the seller or packaging").label).toBe("Needs details");
    expect(skippedCopy("concept mode excludes marketplace channels").note).toContain("Concept");
  });

  it("falls back to a generic line for reasons it does not know", () => {
    expect(skippedCopy("something new").label).toBe("Skipped");
    expect(skippedCopy(null).note).toContain("No credits were charged");
  });

  it("shows Coming soon for video and avatar shots no plan delivers, never a higher plan", () => {
    // The planner's tier reasons for these shots (deterministic.ts), plus
    // other reasons they can carry.
    const cases: Array<[string, string]> = [
      ["video_hero_6s", "not included in this plan tier"],
      ["video_lifestyle_15s", "Pro or Agency only"],
      ["video_ugc_hook", "Pro or Agency only"],
      ["video_spin", "needs photo"],
      ["video_hero_6s", "channel not selected"],
      ["video_ugc_hook", "provider not enabled"],
    ];
    for (const [shotType, reason] of cases) {
      const copy = skippedCopy(reason, shotType);
      expect(copy.label, `${shotType}: ${reason}`).toBe("Coming soon");
      expect(copy.note).not.toMatch(/higher plan|Add a photo/);
      expect(copy.note).toContain("No credits were charged");
      expect(copy.note).not.toMatch(FORBIDDEN);
    }
  });

  it("keeps the plan and photo copy for still shots", () => {
    expect(skippedCopy("not included in this plan tier", "lifestyle").label).toBe("Not in your plan");
    expect(skippedCopy("needs photo", "alt_angle_white").label).toBe("Needs photo");
  });

  it("says a shot left out over a channel's image limit was left out for that reason", () => {
    const copy = skippedCopy(CHANNEL_LIMIT_REASON, "alt_angle_white");
    expect(copy.label).toBe("Skipped");
    expect(copy.note).toContain("as many images as it allows");
    expect(copy.note).toContain("No credits were charged");
    expect(copy.note).not.toMatch(FORBIDDEN);
  });
});

describe("needsReviewNote", () => {
  it("never repeats the engineering hint and always says it was not charged", () => {
    const hints = [
      "Fix failed checks: fill, background",
      "The lifestyle shot needs the image, cutout and storage providers, and at least one is not configured.",
      "Cost cap reached: pack cap",
      "No product was found in the source photo for the lifestyle shot.",
      "The job was stopped before this shot finished.",
      "",
      null,
    ];
    for (const hint of hints) {
      const note = needsReviewNote(hint);
      expect(note).toContain("No credits were charged");
      expect(note).not.toMatch(/Fix failed checks|providers|cap reached|configured/);
      expect(note).not.toMatch(FORBIDDEN);
    }
  });

  it("points at the photo when the product could not be found", () => {
    expect(needsReviewNote("No product was found in the source photo for the lifestyle shot.")).toContain("photo");
  });

  // Each runner hint gets its own true reason, never the quality bar line:
  // several of these shots passed every check or never reached one.
  const RUNNER_HINTS: Array<[name: string, hint: string, says: RegExp]> = [
    ["SHOT_CHANNEL_FULL", SHOT_CHANNEL_FULL, /passed our checks.*as many images as it allows.*left out of the pack/],
    ["SHOT_NOT_DELIVERED", SHOT_NOT_DELIVERED, /passed our checks.*could not add it to the pack/],
    ["SHOT_CONTENT_BLOCKED", SHOT_CONTENT_BLOCKED, /image service declined to make this scene/],
    ["HARMONIZE_SHAPE_REFUSED", HARMONIZE_SHAPE_REFUSED, /wrong shape.*placed back exactly/],
    ["SHOT_PROVIDER_TROUBLE", SHOT_PROVIDER_TROUBLE, /image service had trouble/],
    [
      "pack spend cap",
      "This pack reached its spending limit before this shot could be made, so it needs review.",
      /pack reached its spending limit/,
    ],
    ["unchecked shot", "We could not check this shot, so it needs review.", /could not run our checks/],
    ["PRODUCT_TOUCHING", PRODUCT_TOUCHING, /touches another product.*photo with only that product/],
    ["SHOT_EXTRA_ITEMS", SHOT_EXTRA_ITEMS, /still showed another product next to the one you picked/],
    ["ISOLATION_FAILED", ISOLATION_FAILED, /could not find the product clearly in your photo/],
  ];

  it.each(RUNNER_HINTS)("maps the runner's %s hint to its own plain reason", (_name, hint, says) => {
    const note = needsReviewNote(hint);
    expect(note).toMatch(says);
    expect(note).not.toContain("quality bar");
    expect(note).toMatch(/No credits were charged for it\.$/);
    expect(note).not.toMatch(FORBIDDEN);
  });

  it("never offers a fix the seller cannot make for a blocked scene", () => {
    expect(needsReviewNote(SHOT_CONTENT_BLOCKED)).not.toMatch(/style preset|try again/i);
  });
});

describe("publicJobError", () => {
  it("hides provider names and raw details behind plain copy", () => {
    const text = publicJobError("All providers failed for task image.generate: fal: 502 Bad Gateway");
    expect(text).not.toMatch(/providers|fal|502/i);
    expect(text).toContain("Nothing was charged");
  });

  it("keeps known cases specific", () => {
    expect(publicJobError("The run was interrupted before finishing. Reserved credits were released.")).toContain(
      "interrupted",
    );
    expect(publicJobError("The pack could not be queued.")).toContain("could not start");
    expect(publicJobError("We could not plan the shots for this product, so nothing was charged.")).toContain(
      "nothing was charged",
    );
    expect(publicJobError("credit reservation failed")).toContain("not enough credits");
  });

  it("returns null when there is no error", () => {
    expect(publicJobError(null)).toBeNull();
    expect(publicJobError("  ")).toBeNull();
  });

  // The inline runner's settled messages, one plain line each.
  const SETTLED: Record<keyof typeof SETTLED_JOB_MESSAGES, RegExp> = {
    not_started: /^Our server restarted before this pack could start\./,
    interrupted: /^Our server restarted while this pack was running\./,
    timed_out: /^This pack took longer than our time limit, so we stopped it\./,
    crashed: /^This pack stopped because of an error on our side\./,
  };

  it.each(Object.entries(SETTLED))("maps the inline runner's %s message to its own line", (reason, says) => {
    const text = publicJobError(SETTLED_JOB_MESSAGES[reason as keyof typeof SETTLED_JOB_MESSAGES]);
    expect(text).toMatch(says);
    expect(text).toContain("Credits held for it went back to your balance");
    expect(text).not.toContain("Something went wrong");
    expect(text).not.toMatch(FORBIDDEN);
  });

  it("covers every settle reason the runner has", () => {
    expect(Object.keys(SETTLED).sort()).toEqual(Object.keys(SETTLED_JOB_MESSAGES).sort());
  });
});

describe("packSummaryLine", () => {
  it("summarizes a done pack in plain words", () => {
    const line = packSummaryLine({ delivered: 14, needsReview: 2, skipped: 1, creditsCharged: 23 });
    expect(line).toBe(
      "14 shots delivered. 2 need review, no charge for those. 1 shot was left out of the plan. 23 credits charged.",
    );
    expect(line).not.toMatch(FORBIDDEN);
  });

  it("handles singulars and half credits", () => {
    expect(packSummaryLine({ delivered: 1, needsReview: 1, skipped: 0, creditsCharged: 0.5 })).toBe(
      "1 shot delivered. 1 needs review, no charge for that one. 0.5 credits charged.",
    );
  });
});
