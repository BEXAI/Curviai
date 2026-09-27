/**
 * falGateway invoke path tests with an injectable fetch; nothing here
 * touches the network. Covers the SSRF and credential forwarding guard on
 * the queue response's status_url and response_url.
 */

import { describe, expect, it } from "vitest";
import { ProviderError } from "../types";
import { FalGatewayProvider } from "./falGateway";
import type { FetchLike } from "./shared";

const QUEUE_URL = "https://queue.fal.run/vendor/model";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gateway(fetchFn: FetchLike, baseUrl?: string): FalGatewayProvider {
  return new FalGatewayProvider({
    name: "fal-video",
    tasks: ["video_i2v"],
    apiKey: "test-key",
    modelId: "vendor/model",
    kind: "video",
    priceTable: { perCallMicros: 10_000 },
    baseUrl,
    fetchFn,
    pollIntervalMs: 1,
    maxPolls: 3,
  });
}

describe("FalGatewayProvider follow up URL guard", () => {
  it("rejects a poll URL pointing at attacker.example.com without ever fetching it", async () => {
    const fetched: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      fetched.push(String(input));
      return jsonResponse({
        request_id: "r1",
        status_url: "https://attacker.example.com/status",
        response_url: "https://attacker.example.com/result",
      });
    };
    const provider = gateway(fetchFn);

    const err = await provider.invoke({ task: "video_i2v", input: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).message).toContain("disallowed host");
    // Only the initial queue POST went out; the Authorization Key header was
    // never sent to the attacker controlled URL.
    expect(fetched).toEqual([QUEUE_URL]);
  });

  it("rejects lookalike hosts that only end with the fal suffix", async () => {
    const fetched: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      fetched.push(String(input));
      return jsonResponse({
        request_id: "r1",
        status_url: "https://evilfal.run/status",
        response_url: "https://evilfal.run/result",
      });
    };
    const provider = gateway(fetchFn);

    const err = await provider.invoke({ task: "video_i2v", input: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toContain("disallowed host");
    expect(fetched).toEqual([QUEUE_URL]);
  });

  it("accepts follow up URLs on the configured base origin and completes the call", async () => {
    const fetched: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === QUEUE_URL) {
        return jsonResponse({
          request_id: "r1",
          status_url: `${QUEUE_URL}/requests/r1/status`,
          response_url: `${QUEUE_URL}/requests/r1`,
        });
      }
      if (url.endsWith("/status")) {
        return jsonResponse({ status: "COMPLETED" });
      }
      return jsonResponse({ video: { url: "https://v3.fal.media/files/out.mp4" } });
    };
    const provider = gateway(fetchFn);

    const res = await provider.invoke<Record<string, unknown>, { result: unknown }>({
      task: "video_i2v",
      input: { image_url: "https://example.test/in.png" },
    });
    expect(res.costMicros).toBe(10_000);
    expect(res.output.result).toEqual({ video: { url: "https://v3.fal.media/files/out.mp4" } });
    expect(fetched).toEqual([QUEUE_URL, `${QUEUE_URL}/requests/r1/status`, `${QUEUE_URL}/requests/r1`]);
  });

  it("accepts follow up URLs on known fal hosts and their subdomains", async () => {
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      if (url === QUEUE_URL) {
        return jsonResponse({
          request_id: "r1",
          status_url: "https://rest.fal.ai/requests/r1/status",
          response_url: "https://rest.fal.ai/requests/r1",
        });
      }
      if (url.endsWith("/status")) {
        return jsonResponse({ status: "COMPLETED" });
      }
      return jsonResponse({ ok: true });
    };
    const provider = gateway(fetchFn);

    const res = await provider.invoke<Record<string, unknown>, { result: unknown }>({
      task: "video_i2v",
      input: {},
    });
    expect(res.output.result).toEqual({ ok: true });
  });

  it("rejects follow up URLs that are not valid URLs", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ request_id: "r1", status_url: "not a url", response_url: "also not a url" });
    const provider = gateway(fetchFn);

    const err = await provider.invoke({ task: "video_i2v", input: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).message).toContain("not a valid URL");
  });
});
