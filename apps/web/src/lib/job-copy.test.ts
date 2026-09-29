import { describe, expect, it, vi } from "vitest";
import { CHANNEL_LIMIT_REASON } from "@curvi/pipeline";
import { HARMONIZE_SHAPE_REFUSED, ISOLATION_FAILED, PRODUCT_TOUCHING } from "@curvi/trigger/live-runtime";
import {
  SHOT_CHANNEL_FULL,
  SHOT_CONTENT_BLOCKED,
  SHOT_EXTRA_ITEMS,
  SHOT_NOT_DELIVERED,
  SHOT_OUT_OF_TIME,
  SHOT_PROVIDER_TROUBLE,
} from "@curvi/trigger/runner";
import {
  ADDED_OVERLAYS_REASON,
  MAX_SOURCE_UPSCALE,
  normalizeOutputOptions,
  resolveOutputOptions,
  SELLER_OFF_REASON,
  SOURCE_TOO_SMALL_REASON,
} from "@curvi/pipeline/output-options";
import { SCENE_COUNT_REASON } from "@curvi/pipeline/planner";
import { listSpecs } from "@curvi/specs";
import { SETTLED_JOB_MESSAGES } from "@/lib/jobs/enqueue";
import {
  ADDED_TEXT_COPY,
  needsReviewNote,
  outputOptionsSummary,
  packSummaryLine,
  publicJobError,
  SELLER_OFF_COPY,
  shotCopyContextOf,
  skippedCopy,
} from "./job-copy";

function keepDefaults() {
  return resolveOutputOptions(normalizeOutputOptions({ background: "keep" }), {
    colorHex: "#FFFFFF",
    brandSweepHex: "#1F2A44",
    keepMediaIds: ["ws/a"],
  });
}

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
    ["SHOT_OUT_OF_TIME", SHOT_OUT_OF_TIME, /pack ran out of time before this image could be made/],
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

describe("PHASE_15 reasons", () => {
  it("gives a shot the seller turned off its own copy", () => {
    const copy = skippedCopy(SELLER_OFF_REASON, "lifestyle");
    expect(copy).toEqual({ label: "Turned off", note: "You turned this off for this pack. Not charged." });
  });

  it("asks for a larger photo, with the enlarge limit from MAX_SOURCE_UPSCALE", () => {
    const copy = skippedCopy(`original_photo:amazon.secondary ${SOURCE_TOO_SMALL_REASON}`, "original_photo");
    expect(copy.label).toBe("Needs a larger photo");
    expect(copy.note).toBe(
      `Your photo is too small for this channel without enlarging it more than ${MAX_SOURCE_UPSCALE} times. Upload the original from your camera, or untick this channel. Not charged.`,
    );
  });

  it("never lands source too small in the needs photo or source photo branches", () => {
    expect(skippedCopy(SOURCE_TOO_SMALL_REASON).label).not.toBe("Needs photo");
    const note = needsReviewNote(SOURCE_TOO_SMALL_REASON);
    expect(note).toContain("too small for this channel");
    expect(note).toContain(`${MAX_SOURCE_UPSCALE} times`);
    expect(note).not.toContain("could not find the product");
    expect(note).toContain("No credits were charged");
    expect(needsReviewNote(SELLER_OFF_REASON)).toContain("You turned this off");
  });

  it("tells the seller to leave the channel out or upload a clean photo for added text (P1)", () => {
    const copy = skippedCopy(`original_photo:ebay.listing ${ADDED_OVERLAYS_REASON}`, "original_photo");
    expect(copy).toBe(ADDED_TEXT_COPY);
    expect(copy.label).toBe("Needs a clean photo");
    expect(copy.note).toContain("added text, a border or a watermark");
    expect(copy.note).toContain("Upload a clean photo, or untick this channel.");
    expect(copy.note).toContain("Your product's own logo and labels are fine.");
    expect(skippedCopy(ADDED_OVERLAYS_REASON).label).not.toBe("Needs photo");
  });

  it("names Never enlarge my photo when the pack ran with it, not the enlarge limit", () => {
    const stored = resolveOutputOptions(normalizeOutputOptions({ background: "keep", enlarge: false }), {
      colorHex: "#FFFFFF",
      brandSweepHex: "#1F2A44",
      keepMediaIds: ["ws/a"],
    });
    const context = shotCopyContextOf(stored);
    expect(context.maxUpscale).toBe(1);
    const copy = skippedCopy(SOURCE_TOO_SMALL_REASON, "original_photo", context);
    expect(copy.note).toBe(
      "Your photo is too small for this channel without enlarging it, since you chose Never enlarge my photo. Upload the original from your camera, or untick this channel. Not charged.",
    );
    expect(needsReviewNote(SOURCE_TOO_SMALL_REASON, context)).toContain("since you chose Never enlarge my photo");
    expect(shotCopyContextOf(null)).toEqual({});
    expect(shotCopyContextOf(keepDefaults()).maxUpscale).toBe(MAX_SOURCE_UPSCALE);
  });

  it("reads scenes trimmed to the pack's scene count as the pack's own choice, hidden like turned off", () => {
    const copy = skippedCopy(`lifestyle ${SCENE_COUNT_REASON}`, "lifestyle", { sceneCount: 1 });
    expect(copy).toEqual({
      label: SELLER_OFF_COPY.label,
      note: "This pack has 1 scene, so this extra one was left out. Not charged.",
    });
    expect(skippedCopy(SCENE_COUNT_REASON, "lifestyle", { sceneCount: 2 }).note).toContain("This pack has 2 scenes");
    expect(skippedCopy(SCENE_COUNT_REASON, "lifestyle").note).toContain("This pack has its full number of scenes");
  });

  it("keeps every new line plain spoken (rule 9)", () => {
    const lines = [
      skippedCopy(SOURCE_TOO_SMALL_REASON, null, { maxUpscale: 1 }).note,
      skippedCopy(SCENE_COUNT_REASON, null, { sceneCount: 1 }).note,
      ADDED_TEXT_COPY.label,
      ADDED_TEXT_COPY.note,
      skippedCopy(SELLER_OFF_REASON).label,
      skippedCopy(SELLER_OFF_REASON).note,
      skippedCopy(SOURCE_TOO_SMALL_REASON).label,
      skippedCopy(SOURCE_TOO_SMALL_REASON).note,
      needsReviewNote(SOURCE_TOO_SMALL_REASON),
      needsReviewNote(SELLER_OFF_REASON),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(FORBIDDEN);
    }
  });
});

describe("outputOptionsSummary", () => {
  const keepResolved = resolveOutputOptions(normalizeOutputOptions({ background: "keep" }), {
    colorHex: "#FFFFFF",
    brandSweepHex: "#1F2A44",
    keepMediaIds: ["ws/a", "ws/b", "ws/c"],
  });

  it("reads a job with no stored options as Marketplace ready on white", () => {
    expect(outputOptionsSummary(null, { specIds: ["amazon.main", "shopify.product"], photoCount: 1 })).toEqual({
      look: "marketplace",
      lines: ["Background removed, on white."],
    });
  });

  it("describes a Keep pack the way the plan's card does", () => {
    const summary = outputOptionsSummary(keepResolved, {
      specIds: ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"],
      photoCount: 3,
    });
    expect(summary.look).toBe("keep_photo");
    expect(summary.lines).toEqual([
      "Background kept as you took it, on 3 photos.",
      "Amazon main image: background removed, because Amazon requires white.",
      "Added space: white.",
      "Turned off: lifestyle scenes, studio backdrops, transparent PNG, graphics, social posts and banners.",
    ]);
  });

  it("leaves out added space when no kept output gets any", () => {
    const summary = outputOptionsSummary(keepResolved, { specIds: ["etsy.listing"], photoCount: 3 });
    expect(summary.lines.some((line) => line.startsWith("Added space"))).toBe(false);
  });

  it("names the color and the channels that stay white with Remove", () => {
    const resolved = resolveOutputOptions(
      normalizeOutputOptions({ color: { kind: "swatch", key: "sand" }, extras: { scenes: false } }),
      { colorHex: "#EADFCF", brandSweepHex: "#1F2A44", keepMediaIds: [] },
    );
    const summary = outputOptionsSummary(resolved, {
      specIds: ["amazon.main", "walmart.main", "etsy.listing"],
      photoCount: 1,
    });
    expect(summary.look).toBe("custom");
    expect(summary.lines).toEqual([
      "Background removed, on sand.",
      "Amazon main image: pure white, because Amazon requires white.",
      "Walmart main image: pure white, because Walmart requires white.",
      "Turned off: lifestyle scenes.",
    ]);
    const brand = resolveOutputOptions(normalizeOutputOptions({ color: { kind: "brand", index: 0 } }), {
      colorHex: "#1f2a44",
      brandSweepHex: "#1F2A44",
      keepMediaIds: [],
    });
    expect(outputOptionsSummary(brand, { specIds: [], photoCount: 1 }).lines[0]).toBe(
      "Background removed, on brand color 1, #1F2A44.",
    );
  });

  it("reads the kept photos from the keep list, not the pack's switch (per photo backgrounds)", () => {
    // Remove pack with one photo set to Keep as is.
    const removeWithKept = resolveOutputOptions(normalizeOutputOptions({ background: "remove" }), {
      colorHex: "#FFFFFF",
      brandSweepHex: "#1F2A44",
      keepMediaIds: ["ws/a"],
    });
    const mixed = outputOptionsSummary(removeWithKept, { specIds: ["amazon.main", "meta.feed_1x1"], photoCount: 3 });
    expect(mixed.lines.slice(0, 3)).toEqual([
      "Background kept as you took it, on 1 photo.",
      "Background removed on your other photos, on white.",
      "Amazon main image: background removed, because Amazon requires white.",
    ]);
    expect(mixed.lines).toContain("Added space: white.");
    // Unknown photo count: the Remove switch says the rest were removed.
    expect(outputOptionsSummary(removeWithKept, { specIds: [] }).lines.slice(0, 2)).toEqual([
      "Background kept as you took it, on 1 photo.",
      "Background removed on your other photos, on white.",
    ]);
    // Keep pack with every photo set to Remove: nothing was kept.
    const keepNoneKept = resolveOutputOptions(normalizeOutputOptions({ background: "keep" }), {
      colorHex: "#FFFFFF",
      brandSweepHex: "#1F2A44",
      keepMediaIds: [],
    });
    const none = outputOptionsSummary(keepNoneKept, { specIds: ["amazon.main", "meta.feed_1x1"], photoCount: 2 });
    expect(none.lines[0]).toBe("Background removed, on white.");
    expect(none.lines.some((line) => line.includes("kept as you took it") || line.startsWith("Added space"))).toBe(false);
    // Every photo kept: no removed line.
    expect(outputOptionsSummary(keepResolved, { specIds: [], photoCount: 3 }).lines[0]).toBe(
      "Background kept as you took it, on 3 photos.",
    );
    expect(outputOptionsSummary(keepResolved, { specIds: [], photoCount: 3 }).lines.join(" ")).not.toContain(
      "Background removed",
    );
  });

  it("keeps every line plain spoken (rule 9)", () => {
    const summary = outputOptionsSummary(keepResolved, { specIds: listSpecs().map((s) => s.id), photoCount: 1 });
    expect(summary.lines.length).toBeGreaterThan(2);
    for (const line of summary.lines) {
      expect(line).not.toMatch(FORBIDDEN);
    }
  });
});

describe("the cutout pause copy (audit trigger)", () => {
  it("says background removal is paused and points to Keep my photos", async () => {
    const { SHOT_CUTOUT_PAUSED } = await import("@curvi/trigger/runner");
    const { CUTOUT_PAUSED_NOTE } = await import("./job-copy");
    const note = needsReviewNote(SHOT_CUTOUT_PAUSED);
    expect(note).toContain(CUTOUT_PAUSED_NOTE);
    expect(note).toContain("Keep my photos");
    expect(note).not.toContain("had trouble");
  });
});
