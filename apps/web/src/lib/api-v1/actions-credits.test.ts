import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api-keys/auth";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { overMaxCreditsRejection } from "@/lib/services/errors";
import { TEST_WORKSPACE_ID, createFakeServices } from "@/lib/testing/fake-services";
import type { ImportedPhoto } from "@/lib/url-import/image";
import { createPack, estimatePack, type ApiContext } from "./actions";
import { MCP_COPY } from "./mcp-copy";
import { mainImagePng } from "./test-fixtures";

// create_pack holds nothing and keeps no photo when an assistant's quote or
// cap refuses the pack (PHASE_19 P19-16), and estimate_pack never stores a
// photo, with db mode services and storage in place.

let png: Buffer;
let services: ReturnType<typeof createFakeServices>;
const put = vi.fn(async (_ws: string, _photo: ImportedPhoto, _key: string) => true);
const remove = vi.fn(async (_keys: string[]) => [] as string[]);

function ctx(kind: ApiCaller["kind"] = "oauth"): ApiContext {
  const caller: ApiCaller = {
    kind,
    keyId: kind === "api_key" ? "key-1" : null,
    prefix: null,
    connectionId: kind === "oauth" ? "conn-1" : null,
    ipExempt: kind === "oauth",
    scopes: ["packs:read", "packs:write", "checks"],
    principal: { workspaceId: TEST_WORKSPACE_ID, workspaceName: "Test", plan: "pro", role: "owner", userId: "user-1" },
    services,
    rateSubject: "user:user-1",
  };
  return { caller, headers: new Headers(), photos: { put, remove } };
}

const BODY = () => ({ channels: ["amazon.main"], photos: [{ data: png.toString("base64") }] });

beforeEach(async () => {
  png ??= await mainImagePng(1200, 0.8);
  services = createFakeServices("owner");
  put.mockClear();
  remove.mockClear();
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  vi.stubEnv("R2_ACCOUNT_ID", "acct");
  vi.stubEnv("R2_ACCESS_KEY_ID", "id");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
});

afterEach(() => {
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
});

describe("assistant packs that are refused keep no photo", () => {
  it("estimate_pack measures the photos and stores none", async () => {
    vi.mocked(services.estimateJob).mockResolvedValue({
      outcome: "estimated",
      creditsNeeded: 7,
      creditsAvailable: 50,
      channels: ["amazon.main"],
      leftOut: [],
    });
    const result = await estimatePack(ctx(), BODY());
    expect(result.status).toBe(200);
    expect(put).not.toHaveBeenCalled();
    const input = vi.mocked(services.estimateJob).mock.calls[0]?.[1];
    expect(input?.uploads).toEqual([
      expect.objectContaining({ kind: "image", width: 1200, height: 1200, key: expect.stringContaining(`ws/${TEST_WORKSPACE_ID}/src/`) }),
    ]);
  });

  it("a mismatched quote takes back the photo it wrote and never reaches createJob", async () => {
    const result = await createPack(ctx(), BODY(), null, { quote: "q1.7.9999999999.dev.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", maxCredits: 7, quoteRequired: true });
    expect(result).toMatchObject({ status: 409, assistantMessage: MCP_COPY.quoteNeeded });
    expect(put).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([put.mock.calls[0]?.[2]]);
    expect(services.createJob).not.toHaveBeenCalled();
  });

  it("a hold above max_credits takes back the photo, with the neutral line", async () => {
    vi.mocked(services.createJob).mockResolvedValue(overMaxCreditsRejection(9, 5));
    const result = await createPack(ctx("api_key"), BODY(), null, { maxCredits: 5, quoteRequired: false });
    expect(result).toMatchObject({ status: 409, assistantMessage: MCP_COPY.overMaxCredits(9, 5) });
    expect(vi.mocked(services.createJob).mock.calls[0]?.[1]).toMatchObject({ maxCredits: 5, mode: "listing" });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("an OAuth pack without a quote is refused before any photo is fetched or stored", async () => {
    const result = await createPack(ctx(), BODY(), null, { quoteRequired: true });
    expect(result).toMatchObject({ status: 400, assistantMessage: MCP_COPY.quoteNeeded });
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ["maintenance", 503, MCP_COPY.packsPaused],
    ["workspace_day_cap", 429, MCP_COPY.workspaceDayCap],
    ["empty_plan", 422, MCP_COPY.noImagesPlanned],
  ] as const)("a %s refusal keeps no uploaded photo and returns neutral assistant copy", async (reason, status, line) => {
    vi.mocked(services.createJob).mockResolvedValue({ outcome: "rejected", reason, message: "Service detail" });
    const result = await createPack(ctx("api_key"), BODY(), null, { maxCredits: 5, quoteRequired: false });
    expect(result).toMatchObject({ status, body: { reason }, assistantMessage: line });
    expect(put).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([put.mock.calls[0]?.[2]]);
  });

  it("the REST API still needs its Idempotency-Key header", async () => {
    const result = await createPack(ctx("api_key"), BODY(), null);
    expect(result).toMatchObject({ status: 400, body: { reason: "idempotency_key_required" } });
    expect(result.assistantMessage).toBeUndefined();
  });
});
