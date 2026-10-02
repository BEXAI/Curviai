/**
 * Key probes: each adapter's probe hits its free metadata endpoint with the
 * right auth header, never a generation endpoint, and every failure comes
 * back as data within the timeout. fetch is always a mock here.
 */

import { describe, expect, it, vi } from "vitest";
import { AnthropicLLMProvider } from "./adapters/anthropicLLM";
import { BflFluxProvider } from "./adapters/bflFlux";
import { GeminiImageProvider } from "./adapters/geminiImage";
import { OpenaiImageProvider } from "./adapters/openaiImage";
import { PhotoroomCutoutProvider } from "./adapters/photoroomCutout";
import { isProbeable, probeProviders, probeRequest, type ProbeableProvider } from "./probe";
import type { Provider, ProviderRequest, ProviderResponse } from "./types";

type Call = { url: string; init: RequestInit };

function recordingFetch(status = 200): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ echoed: "secret-looking body" }), { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const KEY = "probe-test-key";
const price = { perImageMicros: 1 };

describe("adapter probes", () => {
  it.each([0, 9, 123])("reads the numeric BFL credit balance %s without creating a job", async (credits) => {
    const fetchFn = vi.fn(async () => Response.json({ credits, privateDetail: "never expose" }));
    const provider = new BflFluxProvider({ name: "b", tasks: [], apiKey: KEY, model: "m", priceTable: price, fetchFn });
    const result = await provider.probe();
    expect(result).toMatchObject({ balanceCredits: credits, ok: credits > 0, status: credits > 0 ? 200 : 402 });
    expect(JSON.stringify(result)).not.toContain("privateDetail");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed BFL credit response without echoing it", async () => {
    const provider = new BflFluxProvider({ name: "b", tasks: [], apiKey: KEY, model: "m", priceTable: price,
      fetchFn: async () => Response.json({ credits: "100", detail: KEY }) });
    const result = await provider.probe();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("Anthropic reads the model resource with the key and version headers", async () => {
    const { fetchFn, calls } = recordingFetch();
    const provider = new AnthropicLLMProvider({
      name: "anthropic:m",
      tasks: [],
      apiKey: KEY,
      model: "model-from-seed",
      priceTable: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 },
      fetchFn,
    });
    const result = await provider.probe();
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models/model-from-seed");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    expect(calls[0].init.body).toBeUndefined();
  });

  it("Gemini reads the model resource with x-goog-api-key", async () => {
    const { fetchFn, calls } = recordingFetch();
    const provider = new GeminiImageProvider({ name: "g", tasks: [], apiKey: KEY, model: "gem-model", priceTable: price, fetchFn });
    await provider.probe();
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gem-model");
    expect(calls[0].init).toMatchObject({ method: "GET", headers: { "x-goog-api-key": KEY } });
    expect(calls[0].url).not.toContain("generateContent");
  });

  it("OpenAI reads the model resource with a bearer key", async () => {
    const { fetchFn, calls } = recordingFetch();
    const provider = new OpenaiImageProvider({ name: "o", tasks: [], apiKey: KEY, model: "img-model", priceTable: price, fetchFn });
    await provider.probe();
    expect(calls[0].url).toBe("https://api.openai.com/v1/models/img-model");
    expect(calls[0].init).toMatchObject({ method: "GET", headers: { authorization: `Bearer ${KEY}` } });
  });

  it("BFL reads the credit balance with x-key and creates no job", async () => {
    const { fetchFn, calls } = recordingFetch();
    const provider = new BflFluxProvider({ name: "b", tasks: [], apiKey: KEY, model: "flux-model", priceTable: price, fetchFn });
    await provider.probe();
    expect(calls[0].url).toBe("https://api.bfl.ai/v1/credits");
    expect(calls[0].init).toMatchObject({ method: "GET", headers: { "x-key": KEY } });
  });

  it("Photoroom reads the account on the image api host, not the segment host", async () => {
    const { fetchFn, calls } = recordingFetch();
    const provider = new PhotoroomCutoutProvider({ name: "p", tasks: [], apiKey: KEY, priceTable: { perCallMicros: 1 }, fetchFn });
    await provider.probe();
    expect(calls[0].url).toBe("https://image-api.photoroom.com/v2/account");
    expect(calls[0].init).toMatchObject({ method: "GET", headers: { "x-api-key": KEY } });
  });

  it("reports a refused key as data with its status and a plain reason, never the body", async () => {
    const { fetchFn } = recordingFetch(401);
    const provider = new BflFluxProvider({ name: "b", tasks: [], apiKey: KEY, model: "m", priceTable: price, fetchFn });
    const result = await provider.probe();
    expect(result).toMatchObject({ ok: false, status: 401, error: "The provider refused the key." });
    expect(JSON.stringify(result)).not.toContain("secret-looking");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("probeRequest", () => {
  it("gives up after the timeout and reports no status", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const result = await probeRequest(hanging, "https://example.test", { method: "GET" }, { timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, status: null, error: "No answer within 20 milliseconds." });
  });

  it("reports a network error without throwing", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await probeRequest(failing, "https://example.test", { method: "GET" });
    expect(result).toMatchObject({ ok: false, status: null, error: "The call did not reach the provider (TypeError)." });
  });

  it("measures latency with the injected clock", async () => {
    const { fetchFn } = recordingFetch(200);
    let t = 1_000;
    const result = await probeRequest(fetchFn, "https://example.test", { method: "GET" }, {}, () => (t += 42));
    expect(result.latencyMs).toBe(42);
  });
});

describe("probeProviders", () => {
  const base: Omit<Provider, "name"> = {
    kind: "image",
    supports: () => true,
    invoke: async <TIn, TOut>(_req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> => {
      throw new Error("probes never invoke");
    },
  };

  it("returns one result per target: probed, skipped, thrown and hung", async () => {
    const good: ProbeableProvider = { ...base, name: "good", probe: async () => ({ ok: true, status: 200, latencyMs: 5 }) };
    const plain: Provider = { ...base, name: "plain" };
    const throws: ProbeableProvider = {
      ...base,
      name: "throws",
      probe: async () => {
        throw new Error("boom with detail");
      },
    };
    const hangs: ProbeableProvider = { ...base, name: "hangs", probe: () => new Promise(() => undefined) };
    expect(isProbeable(plain)).toBe(false);

    vi.useFakeTimers();
    try {
      const pending = probeProviders(
        [good, plain, throws, hangs].map((provider) => ({ name: provider.name, provider })),
        { timeoutMs: 1_000 },
      );
      await vi.advanceTimersByTimeAsync(2_500);
      const results = await pending;
      expect(results.map((r) => [r.name, r.ok])).toEqual([
        ["good", true],
        ["plain", true],
        ["throws", false],
        ["hangs", false],
      ]);
      expect(results[1].skipped).toBeDefined();
      expect(results[2].error).toBe("The probe failed (Error).");
      expect(results[3].error).toBe("No answer within 1 second.");
    } finally {
      vi.useRealTimers();
    }
  });
});
