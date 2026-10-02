import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { packChatOf, packImagesOf } from "@/lib/api-v1/chat-views";
import { JSONRPC, PROTOCOL_VERSION_META, handleMcpPost } from "@/lib/api-v1/mcp";
import { MCP_LIST_CACHE, toolList, toolResult } from "@/lib/api-v1/mcp-tools";
import type { Pack } from "@/lib/api-v1/schemas";
import { demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { mcpLinkUrl } from "@/lib/mcp-links";
import { packViewerHtml } from "@/lib/mcp-ui/pack-viewer/html";
import {
  MCP_APP_MIME_TYPE,
  PACK_VIEWER_LIVE,
  PACK_VIEWER_RESOURCES,
  PACK_VIEWER_TEMPLATE,
  PACK_VIEWER_URI,
  packViewerOrigin,
  packViewerResources,
} from "@/lib/mcp-ui/pack-viewer/resource";
import { initialViewerState, reduceViewer } from "@/lib/mcp-ui/pack-viewer/state";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { JobFileView } from "@/lib/services/types";
import { POST } from "./route";

// The pack viewer on /api/mcp (PHASE_19 P19-19; docs/verification.md,
// "p19/ui: pack viewer"): the resources capability and methods, the resource
// metadata ChatGPT reads, and results that still carry every link as text,
// so the plugin works without the viewer. The viewer ships by deploy after
// the first publication (decision 6), so PACK_VIEWER_LIVE is false and the
// route serves nothing yet; these tests serve it through deps.resources,
// which is what turning the switch on does.

const VERSION = "2026-07-28";
let fixture: DemoApiFixture;
let nextId = 1;

function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  return new Request("https://curvi.ai/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": VERSION,
      "mcp-method": method,
      ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
      ...(method === "resources/read" ? { "mcp-name": String(params.uri) } : {}),
      authorization: `Bearer ${fixture.key}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: { ...params, _meta: { [PROTOCOL_VERSION_META]: VERSION } } }),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

/** /api/mcp with the viewer served, as PACK_VIEWER_LIVE true serves it. */
function served(request: Request): Promise<Response> {
  return handleMcpPost(request, { resources: packViewerResources() });
}

beforeEach(() => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai/");
});

afterEach(() => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
});

const META = {
  ui: { csp: { resourceDomains: ["https://curvi.ai"] }, domain: "https://curvi.ai", prefersBorder: true },
  "openai/widgetCSP": { connect_domains: [], resource_domains: ["https://curvi.ai"], redirect_domains: ["https://curvi.ai"] },
};

describe("the pack viewer resource", () => {
  it("waits for the first publication (decision 6): versioned, an MCP App, and not served yet", async () => {
    expect(PACK_VIEWER_LIVE).toBe(false);
    expect(PACK_VIEWER_RESOURCES).toBeNull();
    expect(PACK_VIEWER_TEMPLATE).toBeNull();
    expect(PACK_VIEWER_URI).toBe("ui://curvi/pack-viewer/v1.html");
    expect(MCP_APP_MIME_TYPE).toBe("text/html;profile=mcp-app");
    // The route advertises no resources and answers no resources method, so
    // OpenAI's tool scan reports no UI template for the first submission.
    expect((await json(await POST(rpc("server/discover")))).result.capabilities).toEqual({ tools: {} });
    const listed = await POST(rpc("resources/list"));
    expect(listed.status).toBe(404);
    expect((await json(listed)).error.code).toBe(JSONRPC.methodNotFound);
  });

  it("advertises resources beside tools on server/discover and initialize once served", async () => {
    expect((await json(await served(rpc("server/discover")))).result.capabilities).toEqual({ tools: {}, resources: {} });
    const init = new Request("https://curvi.ai/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }),
    });
    expect((await json(await served(init))).result.capabilities).toEqual({ tools: {}, resources: {} });
  });

  it("lists the viewer with its CSP, domain and legacy redirect domains", async () => {
    const listed = await json(await served(rpc("resources/list")));
    expect(listed.result).toEqual({
      resultType: "complete",
      resources: [
        {
          uri: PACK_VIEWER_URI,
          name: "pack-viewer",
          title: "Pack viewer",
          description: "Shows a pack's progress and its finished images with a download button for each.",
          mimeType: "text/html;profile=mcp-app",
          _meta: META,
        },
      ],
      ...MCP_LIST_CACHE,
    });
    const templates = await json(await served(rpc("resources/templates/list")));
    expect(templates.result).toEqual({ resultType: "complete", resourceTemplates: [], ...MCP_LIST_CACHE });
  });

  it("reads the viewer's HTML with the same metadata, and refuses any other uri", async () => {
    const read = await json(await served(rpc("resources/read", { uri: PACK_VIEWER_URI })));
    expect(read.result).toEqual({
      resultType: "complete",
      contents: [{ uri: PACK_VIEWER_URI, mimeType: "text/html;profile=mcp-app", text: packViewerHtml("https://curvi.ai"), _meta: META }],
      ...MCP_LIST_CACHE,
    });
    const other = await json(await served(rpc("resources/read", { uri: "ui://curvi/pack-viewer/v0.html" })));
    expect(other.error.code).toBe(JSONRPC.invalidParams);
    const unnamed = await served(rpc("resources/read", { uri: PACK_VIEWER_URI }, { "mcp-name": "ui://curvi/other" }));
    expect(unnamed.status).toBe(400);
  });

  it("follows the site URL setting for its origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    const listed = await json(await served(rpc("resources/list")));
    expect(listed.result.resources[0]._meta.ui).toEqual({
      csp: { resourceDomains: ["http://localhost:3000"] },
      domain: "http://localhost:3000",
      prefersBorder: true,
    });
    expect(packViewerOrigin("not a url")).toBe("https://curvi.ai");
  });
});

describe("tools and the viewer", () => {
  it("names no UI template before publication; create_pack stays model only and get_pack is the one tool the viewer can call", () => {
    const byName: Record<string, Record<string, any>> = Object.fromEntries(
      toolList().map((tool) => [String(tool.name), tool._meta as Record<string, any>]),
    );
    // With PACK_VIEWER_LIVE true, create_pack (and only create_pack) gets
    // resourceUri PACK_VIEWER_URI through PACK_VIEWER_TEMPLATE.
    expect(byName.create_pack!.ui).toEqual({ visibility: ["model"] });
    for (const [name, meta] of Object.entries(byName)) {
      expect(meta.ui.resourceUri, name).toBeUndefined();
      expect(meta, name).not.toHaveProperty(["openai/outputTemplate"]);
    }
    const appTools = Object.entries(byName).filter(([, meta]) => meta.ui.visibility.includes("app"));
    expect(appTools.map(([name]) => name)).toEqual(["get_pack"]);
  });

  it("still answers create_pack and get_pack with every field as JSON text, links included", async () => {
    const png = (await mainImagePng(1600, 0.8)).toString("base64");
    const created = await json(await POST(rpc("tools/call", { name: "create_pack", arguments: { channels: ["amazon.main"], photos: [{ data: png }] } })));
    expect(created.result.isError).toBe(false);
    expect(created.result.content[0].text).toBe(JSON.stringify(created.result.structuredContent));
    expect(created.result).not.toHaveProperty("_meta");

    // A finished pack with signed links: each link is in the text block the
    // model reads, so a host without the viewer still hands them over.
    const files: JobFileView[] = [
      { id: "v_1", name: "amazon-main.jpg", kind: "image", channel: "amazon", specId: "amazon.main", shotId: null, downloadUrl: "x" } as JobFileView,
      { id: "p_2", name: "pack.zip", kind: "zip", channel: null, specId: null, shotId: null, downloadUrl: "x" } as JobFileView,
    ];
    const links = new Map([
      ["v_1", { preview_url: mcpLinkUrl("preview", "kid.claims.sig"), download_url: mcpLinkUrl("file", "kid.claims.sig1") }],
      ["p_2", { preview_url: null, download_url: mcpLinkUrl("file", "kid.claims.sig2") }],
    ]);
    const pack = {
      id: created.result.structuredContent.pack_id,
      status: "done",
      finished: true,
      productId: "p",
      productTitle: "Mug",
      channels: ["amazon.main"],
      creditsReserved: 4,
      creditsCharged: 4,
      shots: [],
      error: null,
    } as unknown as Pack;
    const view = packChatOf(pack, { images: packImagesOf(files, [], links), linksValidMinutes: 1440 });
    const text = (toolResult({ status: 200, body: view }).content as Array<{ text: string }>)[0]!.text;
    for (const url of [...links.values()].flatMap((entry) => [entry.preview_url, entry.download_url]).filter(Boolean)) {
      expect(text).toContain(JSON.stringify(url));
    }
    // And the viewer accepts the links the server signs.
    const state = reduceViewer(
      initialViewerState(),
      { type: "result", result: { structuredContent: view } },
      { origin: packViewerOrigin(), now: 0, pollCapMs: 1, maxPollErrors: 3 },
    );
    expect(state.pack!.files!.map((file) => [file.previewUrl, file.downloadUrl])).toEqual([
      [links.get("v_1")!.preview_url, links.get("v_1")!.download_url],
      [null, links.get("p_2")!.download_url],
    ]);
  });
});
