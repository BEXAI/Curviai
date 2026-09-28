import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCronAuth } from "@/lib/cron-auth";

const SECRET = "s3cret-value-for-tests";

describe("checkCronAuth", () => {
  it("is closed while CRON_SECRET is unset", () => {
    expect(checkCronAuth(new Headers({ authorization: `Bearer ${SECRET}` }), undefined)).toBe("unconfigured");
  });

  it("accepts the secret as a bearer token or an x-cron-secret header", () => {
    expect(checkCronAuth(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET)).toBe("ok");
    expect(checkCronAuth(new Headers({ "x-cron-secret": SECRET }), SECRET)).toBe("ok");
  });

  it("refuses a missing, wrong or partial secret", () => {
    expect(checkCronAuth(new Headers(), SECRET)).toBe("denied");
    expect(checkCronAuth(new Headers({ "x-cron-secret": "nope" }), SECRET)).toBe("denied");
    expect(checkCronAuth(new Headers({ "x-cron-secret": SECRET.slice(0, 5) }), SECRET)).toBe("denied");
    expect(checkCronAuth(new Headers({ authorization: `Basic ${SECRET}` }), SECRET)).toBe("denied");
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

  it("answers 401 for a wrong secret", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await post({ "x-cron-secret": "wrong" })).status).toBe(401);
  });

  it("skips cleanly without a database or storage", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "");
    const response = await post({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, skipped: expect.any(String) });
  });
});
