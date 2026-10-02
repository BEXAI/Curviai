import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";

// P18-04: the takedown footer. Anyone holding the claim link takes the page
// down; anything else is a 404 with one plain message. Same origin, IP rate
// limited, and nothing to take down without the database.

const state = vi.hoisted(() => ({ dbMode: true }));
const takeDown = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/prospects/store", () => ({ takeDownByToken: takeDown }));

const { POST } = await import("./route");

const TOKEN = "0123456789abcdef0123456789abcdef01234567";
const post = (token: string, headers: Record<string, string> = {}) =>
  POST(
    new Request(`https://curvi.ai/api/claims/${token}/takedown`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.20", ...headers },
    }),
    { params: Promise.resolve({ token }) },
  );

beforeEach(() => {
  state.dbMode = true;
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  takeDown.mockResolvedValue("taken_down");
});

afterEach(() => {
  setRateLimitStoreForTests(null);
  vi.clearAllMocks();
});

describe("POST /api/claims/[token]/takedown", () => {
  it("takes the page down for the link's holder, once or again", async () => {
    const response = await post(TOKEN);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("taken_down");
    expect(takeDown.mock.calls[0][1]).toMatchObject({ token: TOKEN });
    takeDown.mockResolvedValueOnce("already");
    expect((await (await post(TOKEN)).json()).status).toBe("already");
  });

  it("answers 404 for a token that matches nothing, a malformed one, or without the database", async () => {
    takeDown.mockResolvedValueOnce("not_found");
    expect((await post(TOKEN)).status).toBe(404);
    expect((await post("not-a-token")).status).toBe(404);
    state.dbMode = false;
    expect((await post(TOKEN)).status).toBe(404);
    expect(takeDown).toHaveBeenCalledTimes(1);
  });

  it("refuses a cross site post and limits each IP", async () => {
    expect((await post(TOKEN, { origin: "https://evil.example" })).status).toBe(403);
    const { limit } = RATE_LIMIT_POLICIES["claims.takedown"].ip;
    let last: Response | null = null;
    for (let i = 0; i <= limit; i += 1) {
      last = await post(TOKEN, { "x-forwarded-for": "203.0.113.99" });
    }
    expect(last?.status).toBe(429);
  });
});
