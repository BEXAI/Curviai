import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCapStore } from "@curvi/ai/testing";
import { freePreview } from "@curvi/pipeline/seed";
import { FREE_PREVIEW_COPY } from "@/lib/free-preview/copy";
import { setFreePreviewDepsForTests, type FreePreviewDeps } from "@/lib/free-preview/deps";
import type { CreatePreviewResult } from "@/lib/free-preview/service";
import { MemoryLeadStore } from "@/lib/leads";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";

// POST /api/preview (docs/phases/PHASE_18.md P18-12): every gate in the
// plan's order before any work, the per IP day cap, the honeypot and the
// size cap, then the service's answer.

const create = vi.hoisted(() => ({
  fn: vi.fn<(deps: unknown, input: { bytes: Buffer; ip: string }) => Promise<CreatePreviewResult>>(),
}));
const challenge = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/lib/turnstile", async (original) => ({
  ...(await original<typeof import("@/lib/turnstile")>()),
  verifyTurnstile: challenge.verify,
}));

vi.mock("@/lib/free-preview/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/free-preview/service")>();
  return { ...actual, createFreePreview: create.fn };
});

const { GET, POST } = await import("./route");

const PREVIEW_ID = "3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5";

let deps: FreePreviewDeps;

function gateDeps(overrides: Partial<FreePreviewDeps> = {}): FreePreviewDeps {
  return {
    db: {} as FreePreviewDeps["db"],
    counters: new InMemoryCapStore(),
    storage: { put: vi.fn(), get: vi.fn(), signDownload: vi.fn() },
    run: vi.fn(),
    leads: new MemoryLeadStore(),
    setupGaps: () => [],
    switchOn: async () => true,
    acquisitionOpen: async () => true,
    now: () => new Date("2026-10-01T15:00:00Z"),
    ...overrides,
  };
}

function upload(opts: { ip?: string; honeypot?: string; bytes?: number; origin?: string; token?: string } = {}): Request {
  const form = new FormData();
  form.set("photo", new Blob([new Uint8Array(opts.bytes ?? 32)], { type: "image/png" }), "photo.png");
  if (opts.honeypot !== undefined) {
    form.set("website", opts.honeypot);
  }
  if (opts.token) form.set("captchaToken", opts.token);
  const headers: Record<string, string> = {};
  if (opts.ip !== "") {
    headers["x-forwarded-for"] = opts.ip ?? "203.0.113.10";
  }
  if (opts.origin) {
    headers.origin = opts.origin;
  }
  return new Request("https://curvi.ai/api/preview", { method: "POST", body: form, headers });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  challenge.verify.mockReset().mockResolvedValue(false);
  deps = gateDeps();
  setFreePreviewDepsForTests(deps);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  create.fn.mockReset();
  create.fn.mockResolvedValue({
    kind: "done",
    previewId: PREVIEW_ID,
    preview: "data:image/jpeg;base64,AAAA",
    checks: [{ name: "fillRatio", pass: true }],
    checksPass: true,
    fillPct: 86,
    fidelity: { meanDeltaE: 0.42, maxDeltaE: 3.1, exactByteShare: 0.61 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  setFreePreviewDepsForTests(null);
  setRateLimitStoreForTests(null);
});

describe("POST /api/preview", () => {
  it("verifies the preview action before invoking the image service", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    expect((await POST(upload())).status).toBe(403);
    expect(create.fn).not.toHaveBeenCalled();
    challenge.verify.mockResolvedValue(true);
    expect((await POST(upload({ token: "signed-token" }))).status).toBe(200);
    expect(challenge.verify).toHaveBeenLastCalledWith("signed-token", {
      action: "preview", hostname: "curvi.ai", ip: "203.0.113.10",
    });
    expect(create.fn).toHaveBeenCalledTimes(1);
  });

  it("hides and refuses a preview when only half of the challenge configuration exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    expect(await (await GET()).json()).toEqual({ available: false });
    expect((await POST(upload())).status).toBe(503);
    expect(create.fn).not.toHaveBeenCalled();
    expect(challenge.verify).not.toHaveBeenCalled();
  });

  it("uses the stricter production fallback allowance on the existing IP counter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST(upload())).status).toBe(200);
    expect((await POST(upload())).status).toBe(429);
    expect(create.fn).toHaveBeenCalledTimes(1);
    // Enabling verification keeps the usage already recorded for this IP.
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    challenge.verify.mockResolvedValue(true);
    expect((await POST(upload({ token: "signed-token" }))).status).toBe(200);
    expect((await POST(upload({ token: "signed-token" }))).status).toBe(429);
  });

  it("answers a made preview with the image, the labeled checks and the fidelity numbers", async () => {
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "done",
      previewId: PREVIEW_ID,
      preview: "data:image/jpeg;base64,AAAA",
      checks: [{ name: "fillRatio", pass: true, label: "Product fills the frame" }],
      checksPass: true,
      fillPct: 86,
      fidelity: { meanDeltaE: 0.42, maxDeltaE: 3.1, exactByteShare: 0.61 },
    });
    expect(create.fn).toHaveBeenCalledWith(deps, expect.objectContaining({ ip: "203.0.113.10" }));
  });

  it("is closed until set up, while switched off and while packs are paused, before any work", async () => {
    setFreePreviewDepsForTests(null);
    const unset = await POST(upload());
    expect(unset.status).toBe(503);
    expect(await unset.json()).toMatchObject({ status: "closed", reason: "not_set_up", error: FREE_PREVIEW_COPY.closed });

    setFreePreviewDepsForTests(gateDeps({ switchOn: async () => false }));
    expect(await (await POST(upload())).json()).toMatchObject({ reason: "switched_off" });

    setFreePreviewDepsForTests(gateDeps({ acquisitionOpen: async () => false }));
    const paused = await POST(upload());
    expect(paused.status).toBe(503);
    expect(await paused.json()).toMatchObject({ reason: "packs_paused" });
    expect(create.fn).not.toHaveBeenCalled();
  });

  it("caps each connection at the seeded previews per UTC day", async () => {
    for (let i = 0; i < freePreview.perIpPerDay; i += 1) {
      expect((await POST(upload())).status).toBe(200);
    }
    const limited = await POST(upload());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ status: "limited", error: FREE_PREVIEW_COPY.limitReached });
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(create.fn).toHaveBeenCalledTimes(freePreview.perIpPerDay);
    // Another connection still has its own.
    expect((await POST(upload({ ip: "198.51.100.7" }))).status).toBe(200);
  });

  it("runs nothing for a request with no client address", async () => {
    const response = await POST(upload({ ip: "" }));
    expect(response.status).toBe(429);
    expect(create.fn).not.toHaveBeenCalled();
  });

  it("gives a filled honeypot an ordinary refusal and does no work", async () => {
    const response = await POST(upload({ honeypot: "https://spam.example" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ status: "blocked", error: FREE_PREVIEW_COPY.blocked });
    expect(create.fn).not.toHaveBeenCalled();
  });

  it("refuses a photo over the seeded size, and a request with no photo", async () => {
    const big = await POST(upload({ bytes: freePreview.maxBytes + 1 }));
    expect(big.status).toBe(413);
    const empty = new Request("https://curvi.ai/api/preview", {
      method: "POST",
      body: new FormData(),
      headers: { "x-forwarded-for": "203.0.113.20" },
    });
    expect((await POST(empty)).status).toBe(400);
    expect(create.fn).not.toHaveBeenCalled();
  });

  it("answers busy past the seeded previews per instance, without using the visitor's day", async () => {
    const release: Array<() => void> = [];
    create.fn.mockImplementation(
      () =>
        new Promise<CreatePreviewResult>((resolve) => {
          release.push(() => resolve({ kind: "failed", previewId: PREVIEW_ID, message: FREE_PREVIEW_COPY.failed }));
        }),
    );
    const running = Array.from({ length: freePreview.maxConcurrentPerInstance }, (_, i) =>
      POST(upload({ ip: `198.51.100.${10 + i}` })),
    );
    await vi.waitFor(() => expect(create.fn).toHaveBeenCalledTimes(freePreview.maxConcurrentPerInstance));
    const busy = await POST(upload({ ip: "198.51.100.50" }));
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ status: "unavailable", error: FREE_PREVIEW_COPY.unavailable });
    for (const done of release) done();
    await Promise.all(running);
    // The busy answer did not count against that connection's day.
    create.fn.mockResolvedValue({ kind: "failed", previewId: PREVIEW_ID, message: FREE_PREVIEW_COPY.failed });
    for (let i = 0; i < freePreview.perIpPerDay; i += 1) {
      expect((await POST(upload({ ip: "198.51.100.50" }))).status).toBe(422);
    }
  });

  it("holds a place while the body is read, and gives it back on every early answer", async () => {
    // Uploads whose bodies never finish arriving: each holds one place, so
    // no more bodies than places are ever buffered at once.
    const stalled: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    const slow = (i: number) =>
      POST(
        new Request("https://curvi.ai/api/preview", {
          method: "POST",
          body: new ReadableStream<Uint8Array>({ start: (controller) => void stalled.push(controller) }),
          headers: { "x-forwarded-for": `198.51.100.${120 + i}`, "content-type": "multipart/form-data; boundary=x" },
          duplex: "half",
        } as RequestInit),
      );
    const reading = Array.from({ length: freePreview.maxConcurrentPerInstance }, (_, i) => slow(i));
    await vi.waitFor(() => expect(stalled).toHaveLength(freePreview.maxConcurrentPerInstance));
    const busy = await POST(upload({ ip: "198.51.100.140" }));
    expect(busy.status).toBe(503);
    for (const controller of stalled) {
      controller.enqueue(new TextEncoder().encode("not a form"));
      controller.close();
    }
    for (const answer of await Promise.all(reading)) {
      expect(answer.status).toBe(400);
    }
    // Every place came back: refusals before any work leave none taken.
    for (let i = 0; i < freePreview.maxConcurrentPerInstance + 1; i += 1) {
      expect((await POST(upload({ ip: `198.51.100.${150 + i}`, honeypot: "bot" }))).status).toBe(422);
    }
    expect((await POST(upload({ ip: "198.51.100.160" }))).status).toBe(200);
    expect(create.fn).toHaveBeenCalledTimes(1);
  });

  it("refuses a post from another site", async () => {
    expect((await POST(upload({ origin: "https://evil.example" }))).status).toBe(403);
    expect(create.fn).not.toHaveBeenCalled();
  });

  it("passes on the service's refusals: the day cap, a block, a failed cutout and an outage", async () => {
    create.fn.mockResolvedValueOnce({ kind: "daily_limit" });
    const day = await POST(upload());
    expect(day.status).toBe(503);
    expect(await day.json()).toMatchObject({ reason: "daily_limit", error: FREE_PREVIEW_COPY.dailyLimit });

    create.fn.mockResolvedValueOnce({ kind: "blocked", previewId: PREVIEW_ID, message: FREE_PREVIEW_COPY.blocked });
    expect((await POST(upload({ ip: "198.51.100.1" }))).status).toBe(422);
    create.fn.mockResolvedValueOnce({ kind: "failed", previewId: PREVIEW_ID, message: FREE_PREVIEW_COPY.failed });
    expect((await POST(upload({ ip: "198.51.100.2" }))).status).toBe(422);
    create.fn.mockResolvedValueOnce({ kind: "unavailable", previewId: PREVIEW_ID, message: FREE_PREVIEW_COPY.unavailable });
    expect((await POST(upload({ ip: "198.51.100.3" }))).status).toBe(503);
    create.fn.mockRejectedValueOnce(new Error("storage down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await POST(upload({ ip: "198.51.100.4" }))).status).toBe(503);
  });
});

describe("GET /api/preview", () => {
  it("says whether previews are open, cached briefly", async () => {
    const open = await GET();
    expect(await open.json()).toEqual({ available: true });
    expect(open.headers.get("cache-control")).toBe("public, max-age=30");
    setFreePreviewDepsForTests(gateDeps({ acquisitionOpen: async () => false }));
    expect(await (await GET()).json()).toEqual({ available: false });
    setFreePreviewDepsForTests(null);
    expect(await (await GET()).json()).toEqual({ available: false });
  });
});
