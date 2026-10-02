import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restrictedProductMessage } from "@curvi/trigger/runner";
import { authenticateApiKey, type ApiCaller } from "@/lib/api-keys/auth";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { createPack } from "@/lib/api-v1/actions";
import { PROTOCOL_VERSION_META, handleMcpPost } from "@/lib/api-v1/mcp";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { demoApiFixture, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { publicJobError } from "@/lib/job-copy";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { CreateJobInput, JobView } from "@/lib/services/types";

// OpenAI's prohibited goods for assistant requests (docs/phases/PHASE_19.md
// P19-29, founder decision 16): every create_pack through /api/mcp is marked
// for the worker's intake screening, the REST API and the web are not, and a
// pack the screening stopped reads as the neutral line through get_pack.

const VERSION = "2026-07-28";
let fixture: DemoApiFixture;
let keyCaller: ApiCaller;
let nextId = 1;

function rpc(name: string, args: Record<string, unknown>): Request {
  return new Request("https://curvi.ai/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": VERSION,
      "mcp-method": "tools/call",
      "mcp-name": name,
      authorization: `Bearer ${fixture.key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args, _meta: { [PROTOCOL_VERSION_META]: VERSION } },
    }),
  });
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: Array<{ text: string }> }> {
  const body = (await (await handleMcpPost(rpc(name, args))).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
  return body.result;
}

beforeEach(async () => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  const auth = await authenticateApiKey(new Headers({ authorization: `Bearer ${fixture.key}` }), null);
  if (!auth.ok) {
    throw new Error("the fixture key did not authenticate");
  }
  keyCaller = auth.caller;
});

afterEach(() => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
  vi.restoreAllMocks();
});

describe("assistant screening (P19-29)", () => {
  it("marks every create_pack through /api/mcp for the worker's screening", async () => {
    const createJob = vi.spyOn(fixture.service, "createJob");
    const created = await call("create_pack", { channels: ["amazon.main"] });
    expect(created.isError, created.content[0]?.text).toBe(false);
    expect((createJob.mock.calls[0]?.[1] as CreateJobInput).audience).toBe("assistant");
  });

  it("leaves the REST API's packs unmarked", async () => {
    const createJob = vi.spyOn(fixture.service, "createJob");
    const result = await createPack({ caller: keyCaller, headers: new Headers() }, { channels: ["amazon.main"] }, "rest-1");
    expect(result.status).toBe(201);
    expect(createJob.mock.calls[0]?.[1] as CreateJobInput).not.toHaveProperty("audience");
  });

  it("tells the assistant, through get_pack, that the pack stopped with nothing charged", async () => {
    const packId = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
    const job: JobView = {
      id: packId,
      productId: "3f2e1d0c-9b8a-4765-8432-10fedcba9876",
      productTitle: "Pen",
      status: "failed",
      mode: "listing",
      channels: ["amazon.main"],
      creditsReserved: 4,
      creditsCharged: 0,
      createdAt: "2026-10-01T12:00:00.000Z",
      shots: [],
      // The services store the web line (publicJobError).
      error: publicJobError(restrictedProductMessage(["tobacco_nicotine"])),
    };
    vi.spyOn(fixture.service, "getJob").mockResolvedValue(job);
    vi.spyOn(fixture.service, "listJobFiles").mockResolvedValue({ jobId: packId, status: "failed", files: [] });
    const got = await call("get_pack", { pack_id: packId });
    expect(got.isError).toBe(false);
    const view = JSON.parse(got.content[0]!.text) as { error: string; message: string };
    expect(view.error).toBe(MCP_COPY.restrictedProduct);
    expect(view.message).toBe(MCP_COPY.restrictedProduct);
    expect(MCP_COPY.restrictedProduct).toBe("Curvi cannot make images of this product from ChatGPT. Nothing was charged.");
  });
});
