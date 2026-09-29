import { describe, expect, it } from "vitest";
import { normalizeOutputOptions, resolveOutputOptions } from "@curvi/pipeline/output-options";
import type { Shot } from "@curvi/pipeline/schemas";
import { creditCosts, stillStyle } from "@curvi/pipeline/seed";
import { buildShotViews, RERUN_NOT_RUN_NOTE, type ShotStepRow } from "./job-shots";
import {
  angleLabel,
  angleOfSkippedShot,
  cancelNotice,
  followUpCredits,
  isRetryable,
  planAngleShots,
  retryShotFor,
  specsWithRoom,
  storedShot,
  withAddedPhoto,
} from "./shot-ops";

const SHOT: Shot = {
  id: "s04_alt_angle_white",
  type: "alt_angle_white",
  sourceMediaId: "ws/w/src/photo.jpg",
  method: "deterministic",
  channels: ["amazon.secondary", "shopify.product"],
  stylePreset: "none",
  scene: "side angle on white",
  credits: creditCosts.deterministic,
  priority: 2,
};

describe("storedShot and isRetryable", () => {
  it("reads the planned shot stored on the asset row", () => {
    expect(storedShot({ shotId: SHOT.id, shot: SHOT })).toEqual(SHOT);
    expect(storedShot({ shotId: SHOT.id })).toBeNull();
    expect(storedShot({ shot: { id: "x" } })).toBeNull();
  });

  it("offers a retry only for a stored shot that was not left out over a full channel", () => {
    expect(isRetryable({ shot: SHOT, repairHint: "The product edge was soft." })).toBe(true);
    expect(isRetryable({ repairHint: "The product edge was soft." })).toBe(false);
    expect(
      isRetryable({
        shot: SHOT,
        repairHint:
          "This channel already has as many images as it allows, so this one was left out of the pack and not charged.",
      }),
    ).toBe(false);
  });
});

describe("angleOfSkippedShot", () => {
  it("reads the angle from the planner's needs photo rows", () => {
    expect(angleOfSkippedShot("alt_angle_white:back", "needs photo")).toBe("back");
    expect(angleOfSkippedShot("alt_angle_white:45", "needs photo")).toBe("45");
    expect(angleOfSkippedShot("alt_angle_white:front", "needs photo")).toBe("front");
    expect(angleOfSkippedShot("amazon_main", "needs photo")).toBe("front");
  });

  it("is null for any other skipped shot", () => {
    expect(angleOfSkippedShot("alt_angle_white:back", "credit budget")).toBeNull();
    expect(angleOfSkippedShot("video_spin", "needs photo")).toBeNull();
    expect(angleOfSkippedShot("alt_angle_white:ceiling", "needs photo")).toBeNull();
    expect(angleOfSkippedShot(null, null)).toBeNull();
  });

  it("names angles in plain words", () => {
    expect(angleLabel("45")).toBe("three quarter");
    expect(angleLabel("in_use")).toBe("in use");
    expect(angleLabel("back")).toBe("back");
  });
});

describe("channel room and credits", () => {
  it("keeps only specs that still have room under their image limit", () => {
    // amazon.main takes 1 image, amazon.secondary 8.
    expect(specsWithRoom(["amazon.main", "amazon.secondary"], { "amazon.main": 1, "amazon.secondary": 7 })).toEqual([
      "amazon.secondary",
    ]);
    expect(specsWithRoom(["amazon.secondary"], { "amazon.secondary": 8 })).toEqual([]);
    expect(specsWithRoom(["not.a.spec"], {})).toEqual([]);
  });

  it("retries a shot on the channels with room, or not at all", () => {
    expect(retryShotFor(SHOT, { "amazon.secondary": 8 })?.channels).toEqual(["shopify.product"]);
    expect(retryShotFor({ ...SHOT, channels: ["amazon.secondary"] }, { "amazon.secondary": 8 })).toBeNull();
  });

  it("holds the sum of the shots' seed prices, to one decimal", () => {
    expect(followUpCredits([{ credits: 0.5 }])).toBe(0.5);
    expect(followUpCredits([{ credits: 0.5 }, { credits: 2 }, { credits: 0.1 }, { credits: 0.2 }])).toBe(2.8);
    expect(followUpCredits([])).toBe(0);
  });
});

describe("planAngleShots", () => {
  const base = {
    mediaKey: "ws/w/src/back.jpg",
    shotId: "skipped_03_alt_angle_white:back",
    channels: ["amazon.main", "amazon.secondary", "shopify.product"],
    tier: "starter" as const,
    existingFilesBySpec: {},
  };

  it("plans the white image of the new angle from the new photo, priced from the seed", () => {
    const shots = planAngleShots({ ...base, angle: "back" });
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      id: base.shotId,
      type: "alt_angle_white",
      sourceMediaId: base.mediaKey,
      method: "deterministic",
      credits: creditCosts.deterministic,
    });
    expect(shots[0].channels).toContain("amazon.secondary");
    expect(shots[0].channels).not.toContain("amazon.main");
  });

  it("plans the main image when the front was the missing photo", () => {
    const shots = planAngleShots({ ...base, angle: "front", shotId: "skipped_01_amazon_main" });
    expect(shots.map((s) => [s.type, s.sourceMediaId])).toEqual([["amazon_main", base.mediaKey]]);
    expect(shots[0].channels[0]).toBe("amazon.main");
  });

  it("plans nothing when every channel the shot is for is full", () => {
    expect(
      planAngleShots({
        ...base,
        angle: "back",
        channels: ["amazon.secondary"],
        existingFilesBySpec: { "amazon.secondary": 8 },
      }),
    ).toEqual([]);
  });

  describe("with the pack's stored output options (PHASE_15)", () => {
    const keep = resolveOutputOptions(normalizeOutputOptions({ background: "keep" }), {
      colorHex: stillStyle.whiteHex,
      brandSweepHex: stillStyle.fallbackBrandHex,
      keepMediaIds: ["ws/w/src/front.jpg"],
    });
    const remove = resolveOutputOptions(normalizeOutputOptions({ color: { kind: "swatch", key: "sand" } }), {
      colorHex: "#EADFCF",
      brandSweepHex: stillStyle.fallbackBrandHex,
      keepMediaIds: [],
    });

    it("plans an added angle on a Keep pack as the seller's own photo, on the gallery specs", () => {
      const shots = planAngleShots({ ...base, angle: "back", output: withAddedPhoto(keep, base.mediaKey) });
      expect(shots).toHaveLength(1);
      expect(shots[0]).toMatchObject({
        id: base.shotId,
        type: "original_photo",
        sourceMediaId: base.mediaKey,
        credits: creditCosts.deterministic,
      });
      expect(shots[0].channels).toEqual(["amazon.secondary", "shopify.product"]);
    });

    it("adds the made white copy for channels that require white after the kept photo", () => {
      const shots = planAngleShots({
        ...base,
        angle: "front",
        shotId: "skipped_01_amazon_main",
        output: withAddedPhoto(keep, base.mediaKey),
      });
      expect(shots.map((s) => [s.id, s.type])).toEqual([
        ["skipped_01_amazon_main", "original_photo"],
        ["skipped_01_amazon_main_amazon_main", "amazon_main"],
      ]);
      expect(shots[1].channels).toEqual(["amazon.main"]);
    });

    it("plans today's white angle on a Remove pack, whatever the color", () => {
      const shots = planAngleShots({ ...base, angle: "back", output: remove });
      expect(shots.map((s) => s.type)).toEqual(["alt_angle_white"]);
    });

    it("leaves out a kept photo too small for a channel", () => {
      const shots = planAngleShots({
        ...base,
        angle: "back",
        output: withAddedPhoto(keep, base.mediaKey),
        photoSize: { width: 300, height: 300 },
      });
      // Amazon's gallery needs a longer side than 1.5 times 300 pixels.
      expect(shots.flatMap((s) => s.channels)).not.toContain("amazon.secondary");
      const amazonOnly = planAngleShots({
        ...base,
        channels: ["amazon.secondary"],
        angle: "back",
        output: withAddedPhoto(keep, base.mediaKey),
        photoSize: { width: 300, height: 300 },
      });
      expect(amazonOnly).toEqual([]);
    });

    it("leaves a kept photo with added text off the channels that refuse it", () => {
      const args = {
        ...base,
        channels: ["amazon.secondary", "ebay.listing"],
        angle: "back" as const,
        output: withAddedPhoto(keep, base.mediaKey),
      };
      const clean = planAngleShots(args);
      expect(clean.find((s) => s.type === "original_photo")?.channels).toContain("ebay.listing");
      const flagged = planAngleShots({ ...args, addedOverlays: true });
      expect(flagged.flatMap((s) => (s.type === "original_photo" ? s.channels : []))).toEqual(["amazon.secondary"]);
    });

    it("keeps the added photo only on a Keep pack", () => {
      expect(withAddedPhoto(keep, base.mediaKey).keepMediaIds).toEqual(["ws/w/src/front.jpg", base.mediaKey]);
      expect(withAddedPhoto(withAddedPhoto(keep, base.mediaKey), base.mediaKey).keepMediaIds).toHaveLength(2);
      expect(withAddedPhoto(remove, base.mediaKey)).toBe(remove);
    });
  });
});

describe("cancelNotice", () => {
  it("says what went back to the balance in plain words", () => {
    expect(cancelNotice("canceled", 12)).toBe("This pack was canceled. 12 credits went back to your balance.");
    expect(cancelNotice("canceled", 1)).toBe("This pack was canceled. 1 credit went back to your balance.");
    expect(cancelNotice("stopped", 0.5)).toContain("0.5 credits went back to your balance.");
    expect(cancelNotice("canceled", 0)).toContain("No credits were held for it.");
    for (const text of [cancelNotice("canceled", 3), cancelNotice("stopped", 2), cancelNotice("finished", 0)]) {
      // CLAUDE.md rule 9: no dashes as punctuation, no arrows.
      expect(text).not.toMatch(/ [-–—] |→|->/);
    }
  });
});

const T0 = new Date("2026-09-28T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
function step(row: Partial<ShotStepRow> & Pick<ShotStepRow, "shotId" | "status">): ShotStepRow {
  return { stage: "alt_angle_white", provider: "worker", error: null, createdAt: T0, ...row };
}
const DONE = { status: "done" as const, mode: "listing" as const };

describe("buildShotViews with pack operations", () => {
  const reviewAsset = { id: "a1", shotType: "alt_angle_white", qc: { shotId: SHOT.id, shot: SHOT, repairHint: "soft edge" } };

  it("offers a retry on a needs review card of a delivered pack", () => {
    const [view] = buildShotViews([step({ shotId: SHOT.id, status: "needs_review" })], [reviewAsset], DONE);
    expect(view).toMatchObject({ status: "needs_review", action: "retry" });
  });

  it("offers nothing while the pack runs, on a concept pack, or without a stored shot", () => {
    const steps = [step({ shotId: SHOT.id, status: "needs_review" })];
    expect(buildShotViews(steps, [reviewAsset], { status: "generating", mode: "listing" })[0].action).toBeUndefined();
    expect(buildShotViews(steps, [reviewAsset], { status: "done", mode: "concept" })[0].action).toBeUndefined();
    expect(
      buildShotViews(steps, [{ ...reviewAsset, qc: { shotId: SHOT.id } }], DONE)[0].action,
    ).toBeUndefined();
  });

  it("offers an added photo on a needs photo card, with the angle in plain words", () => {
    const [view] = buildShotViews(
      [step({ shotId: "skipped_03_alt_angle_white:45", stage: "alt_angle_white:45", status: "skipped", error: "needs photo", provider: "planner" })],
      [],
      DONE,
    );
    expect(view).toMatchObject({ status: "skipped", label: "Needs photo", action: "add_photo", angle: "three quarter" });
  });

  it("a rerun row puts a finished card back in progress until its own final row", () => {
    const steps = [
      step({ shotId: SHOT.id, status: "needs_review", createdAt: at(0) }),
      step({ shotId: SHOT.id, status: "rerun", createdAt: at(1000) }),
    ];
    expect(buildShotViews(steps, [reviewAsset], { status: "generating", mode: "listing" })[0].status).toBe("generating");

    const passed = { id: "a2", shotType: "alt_angle_white", qc: { shotId: SHOT.id, pass: true, credits: 0.5 } };
    const [view] = buildShotViews(
      [...steps, step({ shotId: SHOT.id, status: "done", createdAt: at(2000) })],
      [reviewAsset, passed],
      DONE,
    );
    expect(view).toMatchObject({ status: "done", credits: 0.5 });
    expect(view.action).toBeUndefined();
  });

  it("a rerun that never ran reads as needs review once the pack stopped, and can be tried again", () => {
    const steps = [
      step({ shotId: SHOT.id, status: "needs_review", createdAt: at(0) }),
      step({ shotId: SHOT.id, status: "rerun", createdAt: at(1000) }),
    ];
    const [view] = buildShotViews(steps, [reviewAsset], DONE);
    expect(view).toMatchObject({ status: "needs_review", note: RERUN_NOT_RUN_NOTE, action: "retry" });
  });
});
