import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCronSecret } from "./cron-secret";

const SECRET = "s3cret-value-for-tests";

describe("checkCronSecret", () => {
  it("is closed while CRON_SECRET is unset", () => {
    expect(checkCronSecret(new Headers({ authorization: `Bearer ${SECRET}` }), undefined)).toBe("not_configured");
  });

  it("accepts the secret as a bearer token or an x-cron-secret header", () => {
    expect(checkCronSecret(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET)).toBe("ok");
    expect(checkCronSecret(new Headers({ "x-cron-secret": SECRET }), SECRET)).toBe("ok");
  });

  it("refuses a missing, wrong or partial secret", () => {
    expect(checkCronSecret(new Headers(), SECRET)).toBe("forbidden");
    expect(checkCronSecret(new Headers({ "x-cron-secret": "nope" }), SECRET)).toBe("forbidden");
    expect(checkCronSecret(new Headers({ "x-cron-secret": SECRET.slice(0, 5) }), SECRET)).toBe("forbidden");
    expect(checkCronSecret(new Headers({ authorization: `Basic ${SECRET}` }), SECRET)).toBe("forbidden");
  });
});

describe("POST /api/cron/purge-source-media", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function post(headers: Record<string, string>) {
    const { POST } = await import("@/app/api/cron/purge-source-media/route");
    return POST(new Request("https://curvi.ai/api/cron/purge-source-media", { method: "POST", headers }));
  }

  it("answers 503 until CRON_SECRET is set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await post({ "x-cron-secret": "anything" })).status).toBe(503);
  });

  it("answers 403 for a wrong secret", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await post({ "x-cron-secret": "wrong" })).status).toBe(403);
  });

  it("skips cleanly without a database or storage", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "");
    const response = await post({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, skipped: expect.any(String) });
  });
});
