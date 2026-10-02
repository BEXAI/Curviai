import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { JSONRPC, PROTOCOL_VERSION_META, handleMcpPost, type McpResourceProvider } from "@/lib/api-v1/mcp";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { GET_PROFILE_TOOL, MCP_TOOLS, toolList } from "@/lib/api-v1/mcp-tools";
import { buildOpenApiDocument } from "@/lib/api-v1/openapi";
import { CHAT_FILE_FIELDS, CreatePackRequest, MainImageCheckRequest, OpenAIFileObject } from "@/lib/api-v1/schemas";
import { demoApiFixture, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { POST as checkMainImageRoute } from "../v1/checks/main-image/route";
import { POST as createPackRoute } from "../v1/packs/route";
import { POST } from "./route";

// PHASE_19 P19-02 seams: each one is in place and changes nothing until the
// lane that owns it fills it (resources for the pack viewer, get_profile,
// chat attachment fields).

const VERSION = "2026-07-28";
let fixture: DemoApiFixture;
let nextId = 1;

function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  return new Request("https://curvi.ai/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": VERSION,
      "mcp-method": method,
      authorization: `Bearer ${fixture.key}`,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: { ...params, _meta: { [PROTOCOL_VERSION_META]: VERSION } },
    }),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
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

describe("resources seam (P19-19)", () => {
  it("advertises no resources and answers Method not found while none are served", async () => {
    // null is what PACK_VIEWER_LIVE false gives, the state until the first
    // publication (decision 6); mcp-viewer.test.ts serves the viewer.
    const discover = await json(await handleMcpPost(rpc("server/discover"), { resources: null }));
    expect(discover.result.capabilities).toEqual({ tools: {} });
    for (const method of ["resources/list", "resources/read", "resources/templates/list"]) {
      const response = await handleMcpPost(rpc(method, { uri: "ui://curvi/x" }, { "mcp-name": "ui://curvi/x" }), { resources: null });
      expect(response.status, method).toBe(404);
      expect((await json(response)).error.code).toBe(JSONRPC.methodNotFound);
    }
  });

  it("serves a provider's resources, checks Mcp-Name on resources/read and refuses an unknown uri", async () => {
    const viewer = { uri: "ui://curvi/test/v1.html", mimeType: "text/html;profile=mcp-app", text: "<p></p>" };
    const resources: McpResourceProvider = {
      list: () => [{ uri: viewer.uri, name: "Test", mimeType: viewer.mimeType }],
      read: (uri) => (uri === viewer.uri ? [viewer] : null),
    };
    const discover = await json(await handleMcpPost(rpc("server/discover"), { resources }));
    expect(discover.result.capabilities).toEqual({ tools: {}, resources: {} });

    const list = await json(await handleMcpPost(rpc("resources/list"), { resources }));
    expect(list.result).toMatchObject({ resultType: "complete", resources: [{ uri: viewer.uri }] });
    const templates = await json(await handleMcpPost(rpc("resources/templates/list"), { resources }));
    expect(templates.result.resourceTemplates).toEqual([]);

    const read = await json(await handleMcpPost(rpc("resources/read", { uri: viewer.uri }, { "mcp-name": viewer.uri }), { resources }));
    expect(read.result.contents).toEqual([viewer]);
    const missingName = await handleMcpPost(rpc("resources/read", { uri: viewer.uri }), { resources });
    expect(missingName.status).toBe(400);
    expect((await json(missingName)).error.code).toBe(JSONRPC.headerMismatch);
    const unknown = await json(
      await handleMcpPost(rpc("resources/read", { uri: "ui://curvi/nope" }, { "mcp-name": "ui://curvi/nope" }), { resources }),
    );
    expect(unknown.error.code).toBe(JSONRPC.invalidParams);
  });
});

describe("get_profile seam (P19-11)", () => {
  it("is defined with read only annotations and offered to OAuth callers only", async () => {
    expect(GET_PROFILE_TOOL.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // Listed since P19-11; an API key caller (and anyone while
    // MCP_OAUTH_ENABLED is off) still neither sees nor calls it.
    expect(MCP_TOOLS.map((tool) => tool.name)).toContain("get_profile");
    const listed = await json(await POST(rpc("tools/list")));
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("get_profile");
    const called = await json(await POST(rpc("tools/call", { name: "get_profile", arguments: {} }, { "mcp-name": "get_profile" })));
    expect(called.error.code).toBe(JSONRPC.invalidParams);
  });
});

describe("chat attachment fields (P19-15)", () => {
  const file = { download_url: "https://files.oaiusercontent.com/file-abc?sig=1", file_id: "file-abc" };

  it("parses the file object OpenAI documents: two required fields, two optional, unknown keys stripped", () => {
    expect(OpenAIFileObject.parse({ ...file, mime_type: "image/png", file_name: "a.png", extra: true })).toEqual({
      ...file,
      mime_type: "image/png",
      file_name: "a.png",
    });
    expect(OpenAIFileObject.safeParse({ download_url: file.download_url }).success).toBe(false);
    expect(OpenAIFileObject.safeParse({ ...file, download_url: "http://files.example/a" }).success).toBe(false);
    expect(CreatePackRequest.safeParse({ channels: ["amazon.main"], images: [file] }).success).toBe(true);
    expect(MainImageCheckRequest.safeParse({ image: file }).success).toBe(true);
    expect(MainImageCheckRequest.safeParse({ image: file, url: "https://shop.example/a.png" }).success).toBe(false);
  });

  it("lists the fields in tools/list now they are wired, and keeps them out of the REST document", () => {
    const schemas = (buildOpenApiDocument().components as { schemas: Record<string, { properties: object }> }).schemas;
    const restNames = [...Object.keys(schemas.CreatePackRequest!.properties), ...Object.keys(schemas.MainImageCheckRequest!.properties)];
    expect(restNames).toEqual(expect.arrayContaining(["channels", "photos", "url", "data"]));
    for (const field of CHAT_FILE_FIELDS) {
      expect(restNames).not.toContain(field);
    }
    const toolNames = toolList().flatMap((tool) => Object.keys((tool.inputSchema as { properties: object }).properties));
    expect(toolNames).toEqual(expect.arrayContaining([...CHAT_FILE_FIELDS]));
  });

  it("answers a placeholder in place of the attached file with the attach line, not a schema error", async () => {
    const calls = [
      { name: "create_pack", arguments: { channels: ["amazon.main"], images: "product.jpg" } },
      { name: "estimate_pack", arguments: { channels: ["amazon.main"], images: [] } },
      { name: "check_main_image", arguments: { image: { file_id: "file-abc" } } },
    ];
    for (const params of calls) {
      const answer = await json(await POST(rpc("tools/call", params, { "mcp-name": params.name })));
      expect(answer.result, params.name).toMatchObject({ isError: true, content: [{ type: "text", text: MCP_COPY.noAttachment }] });
    }
  });

  it("refuses them on the REST routes exactly as before they existed", async () => {
    const created = await createPackRoute(
      new Request("https://curvi.ai/api/v1/packs", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.key}`, "content-type": "application/json", "idempotency-key": "seam-1" },
        body: JSON.stringify({ channels: ["amazon.main"], images: [file] }),
      }),
    );
    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({ reason: "invalid_request", issues: ['Unrecognized key: "images"'] });

    const checked = await checkMainImageRoute(
      new Request("https://curvi.ai/api/v1/checks/main-image", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.key}`, "content-type": "application/json" },
        body: JSON.stringify({ image: file }),
      }),
    );
    expect(checked.status).toBe(400);
    expect(await checked.json()).toMatchObject({ reason: "invalid_request", issues: ['Unrecognized key: "image"'] });
  });
});
