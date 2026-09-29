import { describe, expect, it } from "vitest";
import { callWithFailover } from "../router";
import { CircuitBreaker, InMemoryBreakerStore } from "../breaker";
import { InMemoryCostMeter } from "../meter";
import { ProviderRegistry } from "../registry";
import { AllProvidersFailedError, ProviderError } from "../types";
import { FalCutoutProvider, type CutoutInput, type CutoutOutput } from "./falCutout";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
const MODEL = "fal-ai/birefnet/v2";
const PARAMS = { model: "General Use (Light 2K)", operating_resolution: "2048x2048", output_format: "png" };

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fal queue that completes at once and serves `result` as the cutout. */
function falQueue(opts: { submitStatus?: number; submitBody?: string; result?: Uint8Array; imageUrl?: string } = {}) {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url === `https://queue.fal.run/${MODEL}`) {
      if (opts.submitStatus && opts.submitStatus !== 200) {
        return new Response(opts.submitBody ?? "", { status: opts.submitStatus });
      }
      return Response.json({
        request_id: "r1",
        status_url: `https://queue.fal.run/fal-ai/birefnet/requests/r1/status`,
        response_url: `https://queue.fal.run/fal-ai/birefnet/requests/r1`,
      });
    }
    if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (url.endsWith("/requests/r1")) {
      return Response.json({
        image: { url: opts.imageUrl ?? "https://v3.fal.media/files/cutout.png", content_type: "image/png", width: 4, height: 4 },
      });
    }
    return new Response(opts.result ?? PNG, { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function provider(fetchFn: typeof fetch): FalCutoutProvider {
  return new FalCutoutProvider({
    name: "fal-birefnet",
    tasks: ["cutout"],
    apiKey: "fal-test-key",
    modelId: MODEL,
    modelParams: PARAMS,
    priceTable: { perCallMicros: 10_000 },
    fetchFn,
    pollIntervalMs: 0,
  });
}

describe("FalCutoutProvider", () => {
  it("submits the photo as a data URI with the seeded params and returns the downloaded PNG", async () => {
    const queue = falQueue();
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
    const res = await provider(queue.fetchFn).invoke<CutoutInput, CutoutOutput>({
      task: "cutout",
      input: { imageBytes: photo, format: "png" },
    });
    expect(res.costMicros).toBe(10_000);
    expect(res.output.contentType).toBe("image/png");
    expect([...res.output.imageBytes]).toEqual([...PNG]);

    const submit = queue.calls[0];
    expect(submit.method).toBe("POST");
    expect(submit.headers.authorization).toBe("Key fal-test-key");
    const body = JSON.parse(submit.body ?? "{}");
    expect(body).toMatchObject(PARAMS);
    expect(body.image_url).toBe(`data:image/jpeg;base64,${Buffer.from(photo).toString("base64")}`);
    // The result is downloaded without the fal credential.
    const download = queue.calls.at(-1)!;
    expect(download.url).toBe("https://v3.fal.media/files/cutout.png");
    expect(download.headers.authorization).toBeUndefined();
  });

  it("refuses a result that is not a PNG, since the cutout needs its alpha", async () => {
    const queue = falQueue({ result: JPEG });
    await expect(
      provider(queue.fetchFn).invoke({ task: "cutout", input: { imageBytes: PNG } }),
    ).rejects.toMatchObject({ code: "empty_output", retryable: false });
  });

  it("refuses a result url that is not https", async () => {
    const queue = falQueue({ imageUrl: "http://example.com/x.png" });
    await expect(
      provider(queue.fetchFn).invoke({ task: "cutout", input: { imageBytes: PNG } }),
    ).rejects.toMatchObject({ code: "empty_output" });
  });

  it("classifies a 402 exhausted balance as provider_quota, never retried", async () => {
    const queue = falQueue({ submitStatus: 402, submitBody: '{"detail":"Exhausted balance"}' });
    const err = await provider(queue.fetchFn)
      .invoke({ task: "cutout", input: { imageBytes: PNG } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "provider_quota", retryable: false, transient: false });
  });

  it("behind the router: a quota answer opens the breaker for quota and the next call is not sent", async () => {
    const queue = falQueue({ submitStatus: 402, submitBody: '{"detail":"Exhausted balance"}' });
    const registry = new ProviderRegistry();
    registry.register(provider(queue.fetchFn));
    const store = new InMemoryBreakerStore();
    const call = () =>
      callWithFailover(
        registry,
        { cutout: ["fal-birefnet"] },
        new InMemoryCostMeter(),
        store,
        { task: "cutout", input: { imageBytes: PNG } },
        { sleep: async () => {}, onInternalError: () => {} },
      );
    await expect(call()).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(queue.calls).toHaveLength(1);
    expect(await new CircuitBreaker(store).openReason("fal-birefnet")).toBe("quota");
    const second = await call().catch((e: unknown) => e);
    expect(queue.calls).toHaveLength(1);
    expect(second).toMatchObject({ errors: [expect.objectContaining({ code: "provider_quota", name: "BreakerOpenError" })] });
  });
});
