import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { API_PHOTO_BODY_MAX_BYTES } from "@/lib/api-v1/http";
import {
  JSONRPC,
  MCP_UNKEYED_BODY_MAX_BYTES,
  PROTOCOL_VERSION_META,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleMcpPost,
  mcpBodyCap,
  preAuthenticate,
  withScope,
} from "@/lib/api-v1/mcp";
import { MCP_TOOLS } from "@/lib/api-v1/mcp-tools";
import { MainImageCheckResponse, PackResponse } from "@/lib/api-v1/schemas";
import { DEMO_KEY_ID, demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { DEMO_WORKSPACE_ID } from "@/lib/services/demo";
import { DELETE, GET, POST } from "./route";

// The hosted MCP server (docs/phases/PHASE_16.md workstream 5) over the
// demo services: Streamable HTTP 2026-07-28 request metadata and header
// validation, the initialize handshake for earlier clients, and the four
// tools, authenticated by the same API keys as the public API.

const VERSION = "2026-07-28";
/** Matches the key format but names no key. */
const FORGED_KEY = `cv_live_000000000000_${"A".repeat(43)}`;
let fixture: DemoApiFixture;
let nextId = 1;

interface RpcOptions {
  key?: string | null;
  headers?: Record<string, string>;
  modern?: boolean;
  version?: string;
}

function rpc(method: string, params: Record<string, unknown> = {}, options: RpcOptions = {}): Request {
  const modern = options.modern ?? true;
  const version = options.version ?? VERSION;
  const body = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: modern
      ? { ...params, _meta: { [PROTOCOL_VERSION_META]: version, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } } }
      : params,
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(modern ? { "mcp-protocol-version": version, "mcp-method": method } : {}),
    ...(modern && method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
    ...options.headers,
  };
  const key = options.key === undefined ? fixture.key : options.key;
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  return new Request("https://curvi.ai/api/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

async function call(name: string, args: Record<string, unknown>, options: RpcOptions = {}) {
  const response = await POST(rpc("tools/call", { name, arguments: args }, options));
  const body = (await response.json()) as {
    result?: { isError: boolean; structuredContent: Record<string, unknown>; content: Array<{ type: string; text: string }>; resultType?: string };
    error?: { code: number; message: string };
  };
  return { response, body };
}

beforeEach(() => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
});

describe("transport", () => {
  it("answers GET and DELETE with 405 and a notification with 202", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
    const note = await POST(
      new Request("https://curvi.ai/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(note.status).toBe(202);
  });

  it("refuses a cross site Origin, bad JSON and a batch", async () => {
    expect((await POST(rpc("tools/list", {}, { headers: { origin: "https://evil.example", host: "curvi.ai" } }))).status).toBe(403);
    const bad = await POST(new Request("https://curvi.ai/api/mcp", { method: "POST", body: "{nope" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(JSONRPC.parseError);
    const batch = await POST(new Request("https://curvi.ai/api/mcp", { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]) }));
    expect(batch.status).toBe(400);
  });

  it("caps the body of a request without a well formed key before reading it as a photo body", async () => {
    const big = { name: "check_main_image", arguments: { data: "A".repeat(MCP_UNKEYED_BODY_MAX_BYTES + 1) } };
    expect((await POST(rpc("tools/call", big, { key: null }))).status).toBe(413);
    expect((await POST(rpc("tools/call", big, { key: "not-a-key" }))).status).toBe(413);
    // A forged but well formed key is looked up before the body is read, so
    // it does not unlock the photo cap.
    expect((await POST(rpc("tools/call", big, { key: FORGED_KEY }))).status).toBe(413);
    // A real key gets the photo cap; its scope is then checked per tool.
    expect((await POST(rpc("tools/call", big))).status).not.toBe(413);
    const real = await preAuthenticate(new Headers({ authorization: `Bearer ${fixture.key}` }));
    expect(mcpBodyCap(real)).toBe(API_PHOTO_BODY_MAX_BYTES);
    const forged = await preAuthenticate(new Headers({ authorization: `Bearer ${FORGED_KEY}` }));
    expect(forged?.ok).toBe(false);
    expect(mcpBodyCap(forged)).toBe(MCP_UNKEYED_BODY_MAX_BYTES);
    expect(await preAuthenticate(new Headers())).toBeNull();
    expect(mcpBodyCap(null)).toBe(MCP_UNKEYED_BODY_MAX_BYTES);
  });

  it("stops reading a forged key's body at the unkeyed cap instead of buffering a photo sized body", async () => {
    const chunk = new Uint8Array(16_000).fill(0x41);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 40_000_000) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("https://curvi.ai/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${FORGED_KEY}` },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(MCP_UNKEYED_BODY_MAX_BYTES + 4 * chunk.byteLength);

    // A declared length over the cap is refused without reading at all.
    let touched = false;
    const declared = new Request("https://curvi.ai/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${FORGED_KEY}`,
        "content-length": String(MCP_UNKEYED_BODY_MAX_BYTES + 1),
      },
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            touched = true;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      duplex: "half",
    } as RequestInit);
    expect((await POST(declared)).status).toBe(413);
    expect(touched).toBe(false);
  });

  it("looks the key up once per call and still checks the tool's scope", async () => {
    const real = await preAuthenticate(new Headers({ authorization: `Bearer ${fixture.key}` }));
    if (!real?.ok) {
      throw new Error("the fixture key should authenticate");
    }
    const checksOnly = { ok: true as const, caller: { ...real.caller, scopes: ["checks"] } };
    const authenticate = vi.fn(async () => checksOnly);
    const response = await handleMcpPost(rpc("tools/call", { name: "list_channels", arguments: {} }), { authenticate });
    expect(response.status).toBe(200);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith(expect.any(Headers), null);

    const denied = await handleMcpPost(rpc("tools/call", { name: "get_pack", arguments: { pack_id: "x" } }), { authenticate });
    const body = (await denied.json()) as { result: { isError: boolean; structuredContent: { reason: string } } };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.reason).toBe("insufficient_scope");
    expect(withScope(checksOnly, "packs:write")).toMatchObject({ ok: false, error: { status: 403 } });
    expect(withScope(checksOnly, "checks")).toBe(checksOnly);
  });

  it("checks the mirrored headers against the body (HeaderMismatch)", async () => {
    const cases: Array<Record<string, string>> = [
      { "mcp-protocol-version": "2025-11-25" },
      { "mcp-method": "tools/list" },
      { "mcp-name": "get_pack" },
    ];
    for (const headers of cases) {
      const response = await POST(rpc("tools/call", { name: "list_channels", arguments: {} }, { headers }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: number } }).error.code).toBe(JSONRPC.headerMismatch);
    }
    const encoded = await POST(
      rpc("tools/call", { name: "list_channels", arguments: {} }, { headers: { "mcp-name": `=?base64?${Buffer.from("list_channels").toString("base64")}?=` } }),
    );
    expect(encoded.status).toBe(200);
    const missing = new Request("https://curvi.ai/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: { [PROTOCOL_VERSION_META]: VERSION } } }),
    });
    expect((await POST(missing)).status).toBe(400);
  });

  it("answers an unsupported version with the supported list and an unknown method with 404", async () => {
    const response = await POST(rpc("tools/list", {}, { version: "1900-01-01" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: JSONRPC.unsupportedVersion, data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: "1900-01-01" } },
    });
    const unknown = await POST(rpc("resources/list"));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(JSONRPC.methodNotFound);
  });
});

describe("discovery", () => {
  it("serves server/discover, tools/list and ping to modern clients without a key", async () => {
    const discover = await POST(rpc("server/discover", {}, { key: null }));
    expect(discover.status).toBe(200);
    expect(await discover.json()).toMatchObject({
      result: {
        resultType: "complete",
        supportedVersions: expect.arrayContaining([VERSION, "2025-11-25"]),
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "curvi" } },
      },
    });
    const list = (await (await POST(rpc("tools/list", {}, { key: null }))).json()) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string; required?: string[] } }> };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(["create_pack", "get_pack", "check_main_image", "list_channels"]);
    const create = list.result.tools.find((t) => t.name === "create_pack");
    expect(create?.inputSchema.type).toBe("object");
    expect(create?.inputSchema.required).toEqual(expect.arrayContaining(["channels", "idempotency_key"]));
    expect(await (await POST(rpc("ping", {}, { key: null }))).json()).toMatchObject({ result: { resultType: "complete" } });
  });

  it("answers the initialize handshake of 2025-11-25 clients and serves them without sessions", async () => {
    const init = await POST(
      rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" } }, { modern: false }),
    );
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(await init.json()).toMatchObject({ result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "curvi" } } });
    const older = await POST(rpc("initialize", { protocolVersion: "2024-11-05" }, { modern: false }));
    expect(((await older.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");

    const legacyCall = await call("list_channels", {}, { modern: false, headers: { "mcp-protocol-version": "2025-11-25" } });
    expect(legacyCall.response.status).toBe(200);
    expect(legacyCall.body.result?.isError).toBe(false);
    expect(legacyCall.body.result?.resultType).toBeUndefined();
  });
});

describe("tools against the demo services", () => {
  it("refuses tools/call without a valid key with 401", async () => {
    const { response, body } = await call("list_channels", {}, { key: null });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(body.error?.code).toBe(JSONRPC.unauthorized);
    await fixture.store.revoke(DEMO_WORKSPACE_ID, DEMO_KEY_ID, new Date());
    expect((await call("list_channels", {})).response.status).toBe(401);
  });

  it("create_pack starts a pack, replays a retry and get_pack follows it to its files", async () => {
    const args = { channels: ["amazon.main", "shopify"], idempotency_key: "mcp-1", title: "Desk lamp" };
    const created = await call("create_pack", args);
    expect(created.response.status).toBe(200);
    expect(created.body.result?.isError).toBe(false);
    const pack = PackResponse.parse(created.body.result?.structuredContent).pack;
    expect(pack.productTitle).toBe("Desk lamp");
    expect(JSON.parse(created.body.result?.content[0]?.text ?? "{}")).toEqual(created.body.result?.structuredContent);

    const retry = await call("create_pack", args);
    expect(retry.body.result?.structuredContent).toMatchObject({ replayed: true, pack: { id: pack.id } });

    let finished = false;
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 20 && !finished; i += 1) {
      const got = await call("get_pack", { pack_id: pack.id, include_files: true });
      expect(got.body.result?.isError).toBe(false);
      last = got.body.result?.structuredContent ?? {};
      finished = (last.pack as { finished: boolean }).finished;
    }
    expect(finished).toBe(true);
    expect(Array.isArray(last.files) && last.files.length > 0).toBe(true);
  });

  it("create_pack takes the bundle and look shortcuts next to partial output options", async () => {
    vi.stubEnv("NEXT_PUBLIC_OUTPUT_OPTIONS", "1");
    // The tool passes the arguments as sent to the action, so the output
    // options' schema defaults (bundle everything) cannot clash with the
    // bundle shortcut.
    const created = await call("create_pack", {
      channels: ["amazon.main"],
      idempotency_key: "mcp-look",
      bundle: "main",
      look: "marketplace",
      outputOptions: { logo: false },
    });
    expect(created.body.result?.isError, JSON.stringify(created.body.result?.structuredContent)).toBe(false);
    vi.unstubAllEnvs();
  });

  it("returns refusals as tool errors the model can read", async () => {
    const missing = await call("get_pack", { pack_id: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" });
    expect(missing.body.result).toMatchObject({ isError: true, structuredContent: { reason: "not_found" } });
    const invalid = await call("create_pack", { channels: ["amazon.main"] });
    expect(invalid.body.result).toMatchObject({ isError: true, structuredContent: { reason: "invalid_request" } });
    expect(invalid.body.result?.content[0]?.text).toContain("idempotency_key");
    const unknownTool = await call("delete_everything", {});
    expect(unknownTool.body.error?.code).toBe(JSONRPC.invalidParams);
  });

  it("check_main_image measures an image and list_channels lists the plan's channels", async () => {
    const png = await mainImagePng(2000, 0.87);
    const checked = await call("check_main_image", { data: png.toString("base64") });
    expect(checked.body.result?.isError).toBe(false);
    expect(MainImageCheckResponse.parse(checked.body.result?.structuredContent).pass).toBe(true);

    const channels = await call("list_channels", {});
    const content = channels.body.result?.structuredContent as { channels: Array<{ id: string }> };
    expect(content.channels.some((c) => c.id === "amazon.main")).toBe(true);
  });

  it("names a tool for every public action with a scope that matches the API", () => {
    expect(Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t.scope]))).toEqual({
      create_pack: "packs:write",
      get_pack: "packs:read",
      check_main_image: "checks",
      list_channels: null,
    });
  });
});
