import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCapStore } from "@curvi/ai/testing";
import { FREE_PREVIEW_COPY } from "@/lib/free-preview/copy";
import { setFreePreviewDepsForTests, type FreePreviewDeps } from "@/lib/free-preview/deps";
import type { UnlockResult } from "@/lib/free-preview/service";
import { MemoryLeadStore } from "@/lib/leads";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";

// POST /api/preview/[id]/full (docs/phases/PHASE_18.md P18-12, decision 6):
// the full size file needs a valid email; a honeypot gets nothing; the
// answer is a signed link, and the email is counted as a lead.

const mocks = vi.hoisted(() => ({
  unlock: vi.fn<(deps: unknown, input: { previewId: string; email: string; marketingConsent: boolean }) => Promise<UnlockResult>>(),
  funnel: vi.fn(async () => ({ recorded: true, firstRecorded: false })),
}));

vi.mock("@/lib/free-preview/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/free-preview/service")>();
  return { ...actual, unlockFullSize: mocks.unlock };
});
vi.mock("@curvi/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@curvi/db")>();
  return { ...actual, recordFunnelEvent: mocks.funnel };
});

const { POST } = await import("./route");

const PREVIEW_ID = "3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5";

function deps(): FreePreviewDeps {
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
  };
}

function post(id: string, body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(`https://curvi.ai/api/preview/${id}/full`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  setFreePreviewDepsForTests(deps());
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  mocks.unlock.mockReset();
  mocks.unlock.mockResolvedValue({ kind: "ready", url: "https://r2.example/main.jpg?sig=1" });
  mocks.funnel.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  setFreePreviewDepsForTests(null);
  setRateLimitStoreForTests(null);
});

describe("POST /api/preview/[id]/full", () => {
  it("records only explicit boolean consent and keeps downloads independent of consent", async () => {
    expect((await post(PREVIEW_ID, { email: "seller@example.com", marketingConsent: true })).status).toBe(200);
    expect(mocks.unlock).toHaveBeenLastCalledWith(expect.anything(), { previewId: PREVIEW_ID, email: "seller@example.com", marketingConsent: true });
    expect((await post(PREVIEW_ID, { email: "seller@example.com", marketingConsent: false })).status).toBe(200);
    expect(mocks.unlock).toHaveBeenLastCalledWith(expect.anything(), { previewId: PREVIEW_ID, email: "seller@example.com", marketingConsent: false });
    mocks.unlock.mockClear();
    expect((await post(PREVIEW_ID, { email: "seller@example.com", marketingConsent: "true" })).status).toBe(400);
    expect(mocks.unlock).not.toHaveBeenCalled();
  });
  it("answers a signed link for a valid email, lower cased, and counts a free-preview lead", async () => {
    const response = await post(PREVIEW_ID, { email: "  Seller@Example.com " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: "https://r2.example/main.jpg?sig=1" });
    expect(mocks.unlock).toHaveBeenCalledWith(expect.anything(), { previewId: PREVIEW_ID, email: "seller@example.com", marketingConsent: false });
    expect(mocks.funnel).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: null,
      name: "lead_captured",
      props: { source: "free-preview" },
    });
  });

  it("refuses an invalid email and a bad id, and gives a honeypot nothing", async () => {
    const bad = await post(PREVIEW_ID, { email: "not an email" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: FREE_PREVIEW_COPY.emailInvalid });
    expect((await post("not-a-uuid", { email: "a@example.com" })).status).toBe(404);
    const bot = await post(PREVIEW_ID, { email: "a@example.com", website: "spam" });
    expect(await bot.json()).toEqual({ ok: true });
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("answers 404 for a preview that is gone, 503 when not set up, 403 from another site", async () => {
    mocks.unlock.mockResolvedValueOnce({ kind: "not_found" });
    const gone = await post(PREVIEW_ID, { email: "a@example.com" });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: FREE_PREVIEW_COPY.expired });
    expect(mocks.funnel).not.toHaveBeenCalled();
    setFreePreviewDepsForTests(null);
    expect((await post(PREVIEW_ID, { email: "a@example.com" })).status).toBe(503);
    setFreePreviewDepsForTests(deps());
    expect((await post(PREVIEW_ID, { email: "a@example.com" }, { origin: "https://evil.example" })).status).toBe(403);
  });
});
