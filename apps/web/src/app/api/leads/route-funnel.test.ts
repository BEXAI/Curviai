import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryLeadStore, setLeadStoreForTests } from "@/lib/leads";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { jsonRequest } from "@/lib/testing/fake-services";

// P18-02: a stored lead is a funnel.lead_captured step with no workspace
// and only its source; a honeypot or a refused email writes nothing.

const recordFunnel = vi.hoisted(() => vi.fn(async () => ({ recorded: true, firstRecorded: false })));
vi.mock("@/lib/funnel", () => ({ recordFunnel }));
vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));

const { POST } = await import("./route");

const URL = "https://curvi.ai/api/leads";

beforeEach(() => {
  recordFunnel.mockClear();
  setLeadStoreForTests(new MemoryLeadStore());
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setLeadStoreForTests(null);
  setRateLimitStoreForTests(null);
});

describe("POST /api/leads funnel step", () => {
  it("records lead_captured with the source and never the email", async () => {
    expect((await POST(jsonRequest(URL, { email: "seller@example.com", source: "main-image-checker" }))).status).toBe(200);
    expect(recordFunnel).toHaveBeenCalledWith({
      workspaceId: null,
      name: "lead_captured",
      props: { source: "main-image-checker" },
    });
    expect(JSON.stringify(recordFunnel.mock.calls)).not.toContain("seller@example.com");
  });

  it("records nothing for a refused email or a filled honeypot", async () => {
    await POST(jsonRequest(URL, { email: "not an email", source: "gallery" }));
    await POST(jsonRequest(URL, { email: "bot@example.com", source: "gallery", website: "http://spam.example" }));
    expect(recordFunnel).not.toHaveBeenCalled();
  });
});
