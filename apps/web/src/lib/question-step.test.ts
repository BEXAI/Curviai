import { describe, expect, it } from "vitest";
import { deterministicQuestions } from "@curvi/pipeline/questions";
import { demoPreflight } from "@/lib/preflight/demo";
import type { PreflightView } from "@/lib/preflight/types";
import {
  channelsAfterAnswer,
  knownKinds,
  QUESTION_STEP_COPY,
  questionSourcePhoto,
  sellerAnswersBody,
  targetPickOf,
  targetValueOf,
  visibleQuestions,
  type QuestionPhoto,
} from "./question-step";

// docs/phases/PHASE_16.md workstream 4: the question step on the new pack form.

const items = [
  { number: 1, label: "silver watch", colorName: "gray" },
  { number: 2, label: "white sneakers", colorName: "white" },
];
const questions = deterministicQuestions(["target", "channels", "mood"], items);
const view = { status: "choose", questions } as unknown as PreflightView;

function photo(overrides: Partial<QuestionPhoto> = {}): QuestionPhoto {
  return {
    id: 1,
    kind: "image",
    phase: "uploaded",
    angle: "front",
    key: "ws/w/src/a.jpg",
    preflightPhase: "done",
    preflight: view,
    ...overrides,
  };
}

describe("the question step", () => {
  it("shows the front photo's questions, else the first checked photo's", () => {
    const side = photo({ id: 2, angle: "side", key: "ws/w/src/b.jpg" });
    const front = photo({ id: 3 });
    expect(questionSourcePhoto([side, front])?.id).toBe(3);
    expect(questionSourcePhoto([side])?.id).toBe(2);
    expect(questionSourcePhoto([photo({ preflightPhase: "checking" })])).toBeNull();
    expect(questionSourcePhoto([photo({ preflight: { ...view, questions: [] } })])).toBeNull();
  });

  it("never asks what the form already knows, and never more than four", () => {
    const all = knownKinds({ photoAngle: "front", optionsOn: true, scenesOn: true, scenePreset: "auto" });
    expect(visibleQuestions(view, all).map((q) => q.kind)).toEqual(["target", "channels", "mood"]);
    const styled = knownKinds({ photoAngle: "front", optionsOn: true, scenesOn: true, scenePreset: "outdoor" });
    expect(visibleQuestions(view, styled).map((q) => q.kind)).toEqual(["target", "channels"]);
    const noScenes = knownKinds({ photoAngle: "front", optionsOn: true, scenesOn: false, scenePreset: "auto" });
    expect(visibleQuestions(view, noScenes).map((q) => q.kind)).not.toContain("mood");
    const inBox = knownKinds({ photoAngle: "in_the_box", optionsOn: false, scenesOn: true, scenePreset: "auto" });
    expect(visibleQuestions(view, inBox).map((q) => q.kind)).toEqual(["channels", "mood"]);
    const many = { ...view, questions: [...questions, ...questions] } as PreflightView;
    expect(visibleQuestions(many, {}).length).toBeLessThanOrEqual(4);
  });

  it("turns a target tap into the photo's pick, or every item", () => {
    expect(targetPickOf("item:2")).toEqual({ chosen: 2, targetAll: false });
    expect(targetPickOf("all")).toEqual({ chosen: null, targetAll: true });
    expect(targetPickOf("nope")).toBeNull();
    expect(targetValueOf({ chosen: 2 })).toBe("item:2");
    expect(targetValueOf({ chosen: null, targetAll: true })).toBe("all");
    expect(targetValueOf({})).toBeNull();
  });

  it("swaps the marketplace picks for the answered ones and keeps the rest", () => {
    const channels = questions.find((q) => q.kind === "channels")!;
    const lookup = (id: string) =>
      id.startsWith("meta.")
        ? { pickable: true, marketplace: false }
        : id === "shopify.product" || id.startsWith("amazon.") || id === "etsy.listing"
          ? { pickable: true, marketplace: true }
          : null;
    const current = ["amazon.main", "amazon.secondary", "meta.feed_1x1", "etsy.listing"];
    expect(channelsAfterAnswer(current, "shopify", channels, lookup)).toEqual(["meta.feed_1x1", "shopify.product"]);
    expect(channelsAfterAnswer(current, "all", channels, lookup)).toEqual([
      "meta.feed_1x1",
      "amazon.main",
      "amazon.secondary",
      "shopify.product",
    ]);
    // Nothing pickable in the answer: the picks stay as they are.
    expect(channelsAfterAnswer(current, "shopify", channels, () => null)).toEqual(current);
  });

  it("sends ids and values only, and nothing when skipped or untouched", () => {
    const tapped = photo({ chosen: 2 });
    expect(sellerAnswersBody({ photo: tapped, questions, picks: { mood: "gym", channels: "made up" }, skipped: false })).toEqual({
      key: "ws/w/src/a.jpg",
      picks: { target: "item:2", mood: "gym" },
    });
    expect(sellerAnswersBody({ photo: tapped, questions, picks: { mood: "gym" }, skipped: true })).toBeUndefined();
    expect(sellerAnswersBody({ photo: photo(), questions, picks: {}, skipped: false })).toBeUndefined();
    expect(sellerAnswersBody({ photo: null, questions, picks: { mood: "gym" }, skipped: false })).toBeUndefined();
  });

  it("asks the demo's questions only for a questions photo, so other demo flows are unchanged", () => {
    expect(demoPreflight("ws/w/src/questions.jpg").questions?.map((q) => q.kind)).toEqual(["target", "channels", "mood"]);
    expect(demoPreflight("ws/w/src/several.jpg").questions).toBeUndefined();
    expect(demoPreflight("ws/w/src/photo.jpg").questions).toBeUndefined();
  });

  it("keeps the step's copy plain", () => {
    const copy = [QUESTION_STEP_COPY.intro, QUESTION_STEP_COPY.skip, QUESTION_STEP_COPY.reopen, ...Object.values(QUESTION_STEP_COPY.prompts)];
    for (const line of copy) {
      expect(line).not.toMatch(/[‒-―←-⇿]|->| - |\p{Extended_Pictographic}/u);
    }
  });
});
