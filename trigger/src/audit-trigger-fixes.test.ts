import { describe, expect, it } from "vitest";
import {
  AllProvidersFailedError,
  ProviderError,
  type CostAwareProvider,
  type GeminiImageInput,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import { decodeToRgba, encodePng, solidCanvas } from "@curvi/pipeline";
import { HARMONIZE_TASK, imageModelSeedRows, SCENE_PLATE_TASK } from "@curvi/pipeline/seed";
import { BFL_HARMONIZE_MAX_PIXELS, bflHarmonizeDraft, ScenePlateBridge } from "./live-runtime";
import { isBadRequest } from "./pipeline-runner";
import { withShotClassSlot } from "./shot-concurrency";

/** A Gemini shaped inner adapter that never answers until the request aborts. */
class HangingInner implements CostAwareProvider {
  readonly kind = "image" as const;
  readonly name = "hanging-gemini";
  supports(): boolean {
    return true;
  }
  estimateCostMicros(): number {
    return 67_000;
  }
  invoke<TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const signal = (req as { signal?: AbortSignal }).signal;
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

/** A Gemini shaped inner adapter that answers at once. */
class QuickInner extends HangingInner {
  override invoke<TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    void (req.input as unknown as GeminiImageInput);
    return encodePng(solidCanvas(8, 8, 200, 200, 200)).then((png) => ({
      output: { images: [{ mimeType: "image/png", dataBase64: png.toString("base64") }], raw: {} } as TOut,
      costMicros: 67_000,
    }));
  }
}

describe("sync image calls cut off by the router are metered (audit trigger)", () => {
  it("reports the image price as billed when the attempt is aborted in flight", async () => {
    const bridge = new ScenePlateBridge(new HangingInner(), "gemini", "gemini-image");
    const controller = new AbortController();
    const billed: number[] = [];
    const req = {
      task: SCENE_PLATE_TASK,
      input: { prompt: "p", width: 64, height: 64 },
      signal: controller.signal,
      onBilled: (micros: number) => billed.push(micros),
    };
    const pending = bridge.invoke(req);
    controller.abort(new Error("timeout"));
    await expect(pending).rejects.toThrow();
    expect(billed).toEqual([67_000]);
  });

  it("reports nothing when the call finishes before any abort", async () => {
    const bridge = new ScenePlateBridge(new QuickInner(), "gemini", "gemini-image");
    const controller = new AbortController();
    const billed: number[] = [];
    const req = {
      task: SCENE_PLATE_TASK,
      input: { prompt: "p", width: 64, height: 64 },
      signal: controller.signal,
      onBilled: (micros: number) => billed.push(micros),
    };
    await bridge.invoke(req);
    controller.abort(new Error("late"));
    expect(billed).toEqual([]);
  });

  it("never meters OpenAI's free harmonize pass through", async () => {
    const bridge = new ScenePlateBridge(new HangingInner(), "openai", "openai-image");
    const controller = new AbortController();
    const billed: number[] = [];
    const png = await encodePng(solidCanvas(8, 8, 1, 2, 3));
    const req = {
      task: HARMONIZE_TASK,
      input: { prompt: "p", png, width: 8, height: 8 },
      signal: controller.signal,
      onBilled: (micros: number) => billed.push(micros),
    };
    await bridge.invoke(req);
    controller.abort(new Error("late"));
    expect(billed).toEqual([]);
  });

  it("seeds a timeout floor above the 60 s default for the sync image models", () => {
    for (const row of imageModelSeedRows.filter((r) => r.family !== "bfl")) {
      expect(row.minTimeoutMs ?? 0).toBeGreaterThan(60_000);
    }
  });
});

describe("BFL harmonize draft size (audit trigger)", () => {
  it("keeps a draft at or under the cap unchanged", async () => {
    const png = await encodePng(solidCanvas(640, 480, 10, 20, 30));
    const draft = await bflHarmonizeDraft(png);
    expect(draft.png).toBe(png);
    expect(draft.width).toBeUndefined();
  });

  it("scales a 2000 px canvas under the cap in multiples of 16, keeping its shape", async () => {
    const png = await encodePng(solidCanvas(2000, 2000, 10, 20, 30));
    const draft = await bflHarmonizeDraft(png);
    expect(draft.width).toBeDefined();
    expect(draft.width! % 16).toBe(0);
    expect(draft.height! % 16).toBe(0);
    expect(draft.width! * draft.height!).toBeLessThanOrEqual(BFL_HARMONIZE_MAX_PIXELS);
    expect(draft.width).toBe(draft.height);
    const decoded = await decodeToRgba(draft.png);
    expect([decoded.width, decoded.height]).toEqual([draft.width, draft.height]);
  });

  it("keeps a wide canvas wide", async () => {
    const png = await encodePng(solidCanvas(2400, 1200, 10, 20, 30));
    const draft = await bflHarmonizeDraft(png);
    expect(Math.abs(draft.width! / draft.height! - 2)).toBeLessThan(0.04);
  });
});

describe("the serial kept photo queue never sticks (audit trigger)", () => {
  it("lets the next kept photo run after a hung one holds the slot past its bound", async () => {
    const hung = withShotClassSlot("original_photo", () => new Promise<string>(() => {}), 20);
    void hung;
    const next = await withShotClassSlot("original_photo", async () => "ran", 20);
    expect(next).toBe("ran");
  });

  it("still runs kept photos one at a time while they settle", async () => {
    let running = 0;
    let peak = 0;
    const job = () =>
      withShotClassSlot("original_photo", async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running -= 1;
      });
    await Promise.all([job(), job(), job()]);
    expect(peak).toBe(1);
  });
});

describe("isBadRequest reads only the chain's primary (audit trigger)", () => {
  it("does not treat a fallback's 400 after a primary timeout as a strict schema refusal", () => {
    const err = new AllProvidersFailedError("shot_planner", [
      new ProviderError("sonnet timed out after 60000 ms", "anthropic:claude-sonnet-5", "shot_planner", true),
      new ProviderError(
        'anthropic:claude-opus-5-5 responded 400: tool_choice: type "tool" and "any" are not supported',
        "anthropic:claude-opus-5-5",
        "shot_planner",
        false,
      ),
    ]);
    expect(isBadRequest(err)).toBe(false);
  });

  it("treats the primary's 400 as a strict schema refusal", () => {
    const err = new AllProvidersFailedError("shot_planner", [
      new ProviderError("anthropic:claude-sonnet-5 responded 400: invalid schema", "anthropic:claude-sonnet-5", "shot_planner", false),
    ]);
    expect(isBadRequest(err)).toBe(true);
    expect(isBadRequest(new ProviderError("x responded 400: bad", "x", "t", false))).toBe(true);
  });
});
