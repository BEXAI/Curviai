import { describe, expect, it } from "vitest";
import { DEFAULT_OUTPUT_OPTIONS } from "@curvi/pipeline/output-options";
import { jobRequestFingerprint } from "./job-request";
import type { CreateJobInput } from "./types";

const base: CreateJobInput = {
  idempotencyKey: "request-1",
  productId: "new",
  mode: "listing",
  channels: ["amazon.main", "shopify.product"],
  newProductTitle: "Mug",
  userDescription: "A ceramic mug",
  sku: "MUG",
  boxContents: ["Mug"],
  comparisonFacts: ["300 ml"],
  endorsements: ["Best mug"],
  uploads: [
    { key: "ws/w/src/front", sha256: "a".repeat(64), kind: "image", angle: "front" },
    { key: "ws/w/src/back", sha256: "b".repeat(64), kind: "image", angle: "back" },
  ],
};

describe("the immutable pack request fingerprint", () => {
  it.each<[string, Partial<CreateJobInput>]>([
    ["product", { productId: "existing" }],
    ["title", { newProductTitle: "Cup" }],
    ["note", { userDescription: "A steel mug" }],
    ["SKU", { sku: "CUP" }],
    ["box contents", { boxContents: ["Mug", "Lid"] }],
    ["comparison facts", { comparisonFacts: ["500 ml"] }],
    ["endorsements", { endorsements: ["Top pick"] }],
    ["answers", { answers: { mood: "gym" } }],
    ["seller answers", { sellerAnswers: { key: "ws/w/src/front", picks: { target: "item:2" } } }],
    ["audience", { audience: "assistant" }],
    ["angle", { uploads: [{ ...base.uploads![0], angle: "back" }, base.uploads![1]] }],
    ["target", { uploads: [{ ...base.uploads![0], targetBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }, base.uploads![1]] }],
    ["photo hash", { uploads: [{ ...base.uploads![0], sha256: "c".repeat(64) }, base.uploads![1]] }],
    ["photo key", { uploads: [{ ...base.uploads![0], key: "ws/w/src/other" }, base.uploads![1]] }],
    ["photo subset", { uploads: base.uploads!.slice(0, 1) }],
    ["no photos", { uploads: [] }],
    ["photo order", { uploads: [...base.uploads!].reverse() }],
    ["background", { uploads: [{ ...base.uploads![0], background: "keep" }, base.uploads![1]] }],
  ])("distinguishes a changed %s", (_name, change) => {
    expect(jobRequestFingerprint({ ...base, ...change })).not.toBe(jobRequestFingerprint(base));
  });

  it("keeps missing seller inputs distinct from clearing them", () => {
    expect(jobRequestFingerprint({ ...base, sku: undefined })).not.toBe(jobRequestFingerprint({ ...base, sku: "" }));
    expect(jobRequestFingerprint({ ...base, boxContents: undefined })).not.toBe(jobRequestFingerprint({ ...base, boxContents: [] }));
  });

  it("normalizes default options, channel order and omitted pack backgrounds", () => {
    expect(jobRequestFingerprint({ ...base, outputOptions: DEFAULT_OUTPUT_OPTIONS, channels: [...base.channels].reverse(),
      uploads: base.uploads!.map((photo) => ({ ...photo, background: "pack" })) })).toBe(jobRequestFingerprint(base));
  });

  it("binds API photos to verified bytes while allowing fresh physical upload keys", () => {
    const api = { ...base, origin: "api" as const };
    const retry = { ...api, uploads: api.uploads!.map((photo) => ({ ...photo, key: `${photo.key}-retry` })) };
    expect(jobRequestFingerprint(retry)).toBe(jobRequestFingerprint(api));
    expect(jobRequestFingerprint({ ...retry, uploads: [...retry.uploads].reverse() })).not.toBe(jobRequestFingerprint(api));
  });

  it("compares answer objects without depending on their property order", () => {
    expect(jobRequestFingerprint({ ...base, sellerAnswers: { key: "photo", picks: { mood: "gym", target: "item:1" } } }))
      .toBe(jobRequestFingerprint({ ...base, sellerAnswers: { key: "photo", picks: { target: "item:1", mood: "gym" } } }));
  });
});
