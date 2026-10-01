import { describe, expect, it } from "vitest";
import type { LlmContentBlock } from "@curvi/ai";
import { withImageDetail } from "./pipeline-runner";

const image: LlmContentBlock = { type: "image", mediaType: "image/jpeg", base64: "AAAA" };
const text: LlmContentBlock = { type: "text", text: "hi" };

describe("withImageDetail (recipe body.imageDetail on runner image blocks)", () => {
  it("leaves blocks unchanged when the recipe sets no detail", () => {
    expect(withImageDetail([image, text], undefined)).toEqual([image, text]);
  });

  it("sets the recipe detail on image blocks only", () => {
    expect(withImageDetail([image, text], "low")).toEqual([{ ...image, detail: "low" }, text]);
  });

  it("keeps a detail a block already carries", () => {
    const high: LlmContentBlock = { ...image, detail: "high" };
    expect(withImageDetail([high], "low")).toEqual([high]);
  });
});
