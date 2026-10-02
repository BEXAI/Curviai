import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizedEmailKey } from "@curvi/email";
import { MemorySuppressionStore, setSuppressionStoreForTests } from "@/lib/email/preferences";

// POST /api/webhooks/resend (P18-06): the Svix signature, and the bounces
// and complaints that stop all email to an address.

vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));

const { POST } = await import("./route");

const SECRET_BYTES = Buffer.from("resend-route-test-secret");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const URL = "https://curvi.ai/api/webhooks/resend";

let store: MemorySuppressionStore;

beforeEach(() => {
  store = new MemorySuppressionStore();
  setSuppressionStoreForTests(store);
  vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  setSuppressionStoreForTests(null);
  vi.unstubAllEnvs();
});

function signedRequest(payload: unknown, secret: Buffer = SECRET_BYTES): Request {
  const body = JSON.stringify(payload);
  const id = "msg_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` },
    body,
  });
}

describe("POST /api/webhooks/resend", () => {
  it("answers 503 until the secret is set", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const response = await POST(signedRequest({ type: "email.bounced", data: { to: ["a@example.com"] } }));
    expect(response.status).toBe(503);
  });

  it("refuses a bad signature and stores nothing", async () => {
    const response = await POST(signedRequest({ type: "email.bounced", data: { to: ["a@example.com"] } }, Buffer.from("wrong")));
    expect(response.status).toBe(401);
    expect(store.rows.size).toBe(0);
  });

  it("stops all email after a permanent bounce or a complaint, by key", async () => {
    const bounce = await POST(
      signedRequest({ type: "email.bounced", data: { to: ["Gone@Example.com"], bounce: { type: "Permanent", subType: "General" } } }),
    );
    expect(bounce.status).toBe(200);
    expect(store.rows.get(normalizedEmailKey("gone@example.com") as string)).toEqual({ scope: "all", reason: "bounced" });
    const complaint = await POST(signedRequest({ type: "email.complained", data: { to: ["angry@example.com"] } }));
    expect(complaint.status).toBe(200);
    expect(store.rows.get(normalizedEmailKey("angry@example.com") as string)).toEqual({ scope: "all", reason: "complained" });
    expect(JSON.stringify([...store.rows.keys()])).not.toContain("@");
  });

  it("acknowledges and ignores a delivery or a transient bounce", async () => {
    expect((await POST(signedRequest({ type: "email.delivered", data: { to: ["a@example.com"] } }))).status).toBe(200);
    expect(
      (await POST(signedRequest({ type: "email.bounced", data: { to: ["a@example.com"], bounce: { type: "Transient" } } }))).status,
    ).toBe(200);
    expect(store.rows.size).toBe(0);
  });

  it("answers 500 when the list cannot be written, so Resend retries", async () => {
    setSuppressionStoreForTests({
      add: async () => Promise.reject(new Error("db down")),
      scopeOf: async () => null,
      liftMarketing: async () => "none",
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(signedRequest({ type: "email.complained", data: { to: ["a@example.com"] } }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("a@example.com");
    spy.mockRestore();
  });
});
