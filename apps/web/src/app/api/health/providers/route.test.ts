import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const SECRET = "probe-secret-value-for-tests";
const KEY_ENVS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "BFL_API_KEY", "OPENAI_API_KEY", "PHOTOROOM_API_KEY"];

function probeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/health/providers", { headers });
}

type FetchCall = { url: string; method: string };
let calls: FetchCall[];

/** Answers each metadata endpoint by URL; anything else fails the test. */
function stubFetch(statusFor: (url: string) => number | "hang" | "throw"): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      const status = statusFor(url);
      if (status === "throw") throw new TypeError("fetch failed");
      if (status === "hang") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return new Response(JSON.stringify({ note: "body that must not be echoed" }), { status });
    }),
  );
}

beforeEach(() => {
  for (const name of ["CRON_SECRET", "DATABASE_URL", ...KEY_ENVS]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GET /api/health/providers auth", () => {
  it("is not found while CRON_SECRET is unset", async () => {
    stubFetch(() => 200);
    const res = await GET(probeRequest({ authorization: "Bearer anything" }));
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("answers 401 to a missing or wrong secret without calling any provider", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-anthropic-value");
    stubFetch(() => 200);
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer nope" },
      { authorization: `Bearer ${SECRET}x` },
      { authorization: SECRET },
    ];
    for (const headers of attempts) {
      expect((await GET(probeRequest(headers))).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });
});

describe("GET /api/health/providers probes", () => {
  it("probes every configured provider with a metadata GET and reports status and latency", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const name of KEY_ENVS) vi.stubEnv(name, `value-of-${name}`);
    stubFetch((url) => (url.includes("api.bfl.ai") ? 401 : 200));

    const res = await GET(probeRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);

    // Only free metadata endpoints, only GETs: nothing generates or spends.
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    // Anthropic (one per priced model) and OpenAI read /v1/models/{id};
    // BFL, Photoroom and Gemini have their own paths.
    const hosts = calls.map((call) => new URL(call.url).pathname);
    expect(hosts.filter((p) => p.startsWith("/v1/models/"))).toHaveLength(calls.length - 3);
    expect(hosts).toContain("/v1/credits");
    expect(hosts).toContain("/v2/account");
    expect(hosts.some((p) => p.startsWith("/v1beta/models/") && !p.includes(":"))).toBe(true);
    expect(hosts.some((p) => /generateContent|segment|messages|images\/generations/.test(p))).toBe(false);

    expect(body.ok).toBe(false);
    const bfl = body.providers.find((p: { name: string }) => p.name === "bfl-flux");
    expect(bfl).toMatchObject({
      kind: "image",
      envVar: "BFL_API_KEY",
      configured: true,
      probe: { ok: false, status: 401, error: "The provider refused the key." },
    });
    const photoroom = body.providers.find((p: { name: string }) => p.name === "photoroom");
    expect(photoroom).toMatchObject({ kind: "cutout", stages: ["cutout"], probe: { ok: true, status: 200 } });
    expect(typeof photoroom.probe.latencyMs).toBe("number");
    for (const name of KEY_ENVS) expect(text).not.toContain(`value-of-${name}`);
    expect(text).not.toContain("must not be echoed");
    expect(text).not.toContain(SECRET);
  });

  it("lists unconfigured providers without calling them", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("PHOTOROOM_API_KEY", "pr-key");
    stubFetch(() => 200);

    const body = await (await GET(probeRequest({ "x-cron-secret": SECRET }))).json();
    expect(calls.map((call) => call.url)).toEqual(["https://image-api.photoroom.com/v2/account"]);
    expect(body.ok).toBe(true);
    const unconfigured = body.providers.filter((p: { configured: boolean }) => !p.configured);
    expect(unconfigured.length).toBe(body.providers.length - 1);
    expect(unconfigured.every((p: { probe: unknown }) => p.probe === null)).toBe(true);
  });

  it("reports a hung or unreachable provider as data within the timeout and never throws", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("GEMINI_API_KEY", "g-key");
    vi.stubEnv("PHOTOROOM_API_KEY", "pr-key");
    stubFetch((url) => (url.includes("googleapis") ? "hang" : "throw"));
    vi.useFakeTimers();

    const pending = GET(probeRequest({ authorization: `Bearer ${SECRET}` }));
    await vi.advanceTimersByTimeAsync(10_500);
    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    const byName = Object.fromEntries(body.providers.map((p: { name: string; probe: unknown }) => [p.name, p.probe]));
    expect(byName["gemini-image"]).toMatchObject({ ok: false, status: null, error: "No answer within 10 seconds." });
    expect(byName.photoroom).toMatchObject({ ok: false, status: null, error: "The call did not reach the provider (TypeError)." });
  });
});
