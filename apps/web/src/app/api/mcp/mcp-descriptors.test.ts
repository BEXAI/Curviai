import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { rule9Problems } from "@curvi/pipeline";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { CHAT_VIEWS } from "@/lib/api-v1/chat-views";
import { PROTOCOL_VERSION_META, handleMcpPost, type McpResourceProvider } from "@/lib/api-v1/mcp";
import { mcpCopyProblems } from "@/lib/api-v1/mcp-copy";
import {
  GET_PROFILE_TOOL,
  MCP_INSTRUCTIONS,
  MCP_LIST_CACHE,
  MCP_TOOLS,
  SECURITY_SCHEMES,
  toolDescriptor,
  toolList,
} from "@/lib/api-v1/mcp-tools";
import { demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { PACK_VIEWER_TEMPLATE } from "@/lib/mcp-ui/pack-viewer/resource";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { DEMO_WORKSPACE_ID } from "@/lib/services/demo";
import { checkToolSnapshot } from "../../../../../../packages/openai-plugin/src/submission";

// The tool descriptors and results OpenAI's plugin review reads (PHASE_19
// P19-13; docs/verification.md, "PHASE_19: ChatGPT and Codex plugin", O1,
// O2, O4, O6, O7, M2, M4, M5).

const VERSION = "2026-07-28";
let fixture: DemoApiFixture;
let nextId = 1;

function rpc(method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}): Request {
  return new Request("https://curvi.ai/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": VERSION,
      "mcp-method": method,
      ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
      authorization: `Bearer ${fixture.key}`,
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: { ...params, _meta: { [PROTOCOL_VERSION_META]: VERSION } } }),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

/** The plan's table (PHASE_19 "Tools"). */
const EXPECTED: Record<string, { hints: [boolean, boolean, boolean, boolean]; status: [string, string] | null; visibility: string[] }> = {
  list_channels: { hints: [true, false, false, true], status: ["Reading channels", "Channels ready"], visibility: ["model"] },
  estimate_pack: { hints: [true, false, true, true], status: ["Counting credits", "Credits counted"], visibility: ["model"] },
  create_pack: { hints: [false, true, true, false], status: ["Starting your pack", "Pack started"], visibility: ["model"] },
  get_pack: { hints: [true, false, false, true], status: ["Checking your pack", "Pack checked"], visibility: ["model", "app"] },
  show_pack: { hints: [true, false, false, true], status: ["Opening your pack", "Pack opened"], visibility: ["model"] },
  check_main_image: { hints: [true, false, true, true], status: ["Checking the main image", "Main image checked"], visibility: ["model"] },
  get_profile: { hints: [true, false, false, true], status: null, visibility: ["model"] },
};

/** Every string a JSON Schema carries: descriptions, titles and enum values. */
function schemaStrings(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(schemaStrings);
  }
  if (!node || typeof node !== "object") {
    return [];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    (key === "description" || key === "title") && typeof value === "string" ? [value] : schemaStrings(value),
  );
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

describe("tool descriptors", () => {
  // P19-11 lists get_profile (mcp.ts still offers it to OAuth callers only).
  const descriptors = toolList() as Array<Record<string, any>>;

  it("passes the submission checker with the actual OAuth tool descriptors", () => {
    expect(checkToolSnapshot({ tools: toolList() })).toEqual({ errors: [], uiTools: ["create_pack", "show_pack"] });
  });

  it("lists the tools in a fixed order, get_profile once P19-11 lists it", () => {
    expect(toolList().map((tool) => tool.name)).toEqual([
      "list_channels",
      "estimate_pack",
      "create_pack",
      "get_pack",
      "show_pack",
      "check_main_image",
      "get_profile",
    ]);
    expect(toolList()).toEqual(toolList());
  });

  it("sets all three required hints (and idempotentHint) on every tool, as the plan's table says", () => {
    for (const descriptor of descriptors) {
      const expected = EXPECTED[descriptor.name];
      expect(expected, descriptor.name).toBeDefined();
      const { readOnlyHint, destructiveHint, openWorldHint, idempotentHint } = descriptor.annotations;
      for (const hint of [readOnlyHint, destructiveHint, openWorldHint, idempotentHint]) {
        expect(typeof hint, descriptor.name).toBe("boolean");
      }
      expect([readOnlyHint, destructiveHint, openWorldHint, idempotentHint], descriptor.name).toEqual(expected!.hints);
    }
  });

  it("declares the OAuth scheme and its _meta mirror on every tool", () => {
    for (const descriptor of descriptors) {
      expect(descriptor.securitySchemes, descriptor.name).toEqual([{ type: "oauth2", scopes: ["openid", "email"] }]);
      expect(descriptor._meta.securitySchemes, descriptor.name).toEqual(descriptor.securitySchemes);
    }
    expect(SECURITY_SCHEMES).toHaveLength(1);
  });

  it("generates an outputSchema from each tool's chat view, with no extra properties", () => {
    for (const descriptor of descriptors) {
      const tool = [...MCP_TOOLS, GET_PROFILE_TOOL].find((candidate) => candidate.name === descriptor.name)!;
      expect(Object.values(CHAT_VIEWS)).toContain(tool.output);
      expect(descriptor.outputSchema.type, descriptor.name).toBe("object");
      expect(descriptor.outputSchema.additionalProperties, descriptor.name).toBe(false);
      expect(descriptor.outputSchema.$schema).toBeUndefined();
    }
  });

  it("carries status text of at most 64 characters, and none on get_profile", () => {
    for (const descriptor of descriptors) {
      const expected = EXPECTED[descriptor.name]!.status;
      const invoking = descriptor._meta["openai/toolInvocation/invoking"];
      const invoked = descriptor._meta["openai/toolInvocation/invoked"];
      expect(expected ? [invoking, invoked] : [invoking, invoked], descriptor.name).toEqual(expected ?? [undefined, undefined]);
      for (const text of [invoking, invoked].filter(Boolean)) {
        expect(text.length, text).toBeLessThanOrEqual(64);
      }
    }
  });

  it("allows the pack viewer to call only get_pack", () => {
    for (const descriptor of descriptors) {
      expect(descriptor._meta.ui.visibility, descriptor.name).toEqual(EXPECTED[descriptor.name]!.visibility);
    }
    expect(toolDescriptor(GET_PROFILE_TOOL)._meta).toMatchObject({ "openai/profile": true });
    expect(descriptors.filter((descriptor) => descriptor._meta["openai/profile"]).map((d) => d.name)).toEqual(["get_profile"]);
  });

  it("opens existing packs through show_pack while get_pack stays a data-only read", () => {
    const show = descriptors.find((descriptor) => descriptor.name === "show_pack")!;
    const get = descriptors.find((descriptor) => descriptor.name === "get_pack")!;
    expect(show.inputSchema.required).toEqual(["pack_id"]);
    expect(Object.keys(show.inputSchema.properties)).toEqual(["pack_id"]);
    expect(show._meta.ui.resourceUri).toBe(PACK_VIEWER_TEMPLATE ?? undefined);
    expect(show._meta.ui.visibility).toEqual(["model"]);
    expect(get._meta.ui.resourceUri).toBeUndefined();
    expect(show.outputSchema).toEqual(get.outputSchema);
  });

  it("uses the plan's descriptions, and every text passes the copy lint and never says free", () => {
    const byName = Object.fromEntries(descriptors.map((descriptor) => [descriptor.name, descriptor.description]));
    expect(byName.check_main_image).toContain("Uses no credits and stores nothing.");
    expect(byName.create_pack).toContain("call estimate_pack first with the same photos and choices");
    expect(byName.create_pack).toContain("it never redraws the product");
    expect(byName.get_pack).toContain("work for 24 hours");
    for (const descriptor of [...descriptors, ...toolList({ chatFiles: true })]) {
      const texts = [
        descriptor.title,
        descriptor.description,
        ...schemaStrings(descriptor.inputSchema),
        ...schemaStrings(descriptor.outputSchema),
        descriptor._meta["openai/toolInvocation/invoking"],
        descriptor._meta["openai/toolInvocation/invoked"],
      ].filter((text): text is string => typeof text === "string");
      for (const text of texts) {
        expect(rule9Problems(text), `${descriptor.name}: ${text}`).toEqual([]);
        expect(mcpCopyProblems(text), `${descriptor.name}: ${text}`).toEqual([]);
      }
    }
  });

  it("tells the model to leave idempotency_key out and does not require it", () => {
    const create = toolList().find((tool) => tool.name === "create_pack") as Record<string, any>;
    expect(create.inputSchema.properties.idempotency_key.description).toMatch(/^Leave this out\./);
    expect(create.inputSchema.required).toEqual(["channels"]);
    expect(Object.keys(create.inputSchema.properties)).toEqual(expect.arrayContaining(["quote", "max_credits"]));
  });

  it("names the chat attachment fields in openai/fileParams now they are wired, with the file object O2 documents", () => {
    // P19-15 is wired (CHAT_FILES_WIRED), so tools/list carries the fields.
    expect(toolList()).toEqual(toolList({ chatFiles: true }));
    for (const descriptor of toolList({ chatFiles: false })) {
      expect(descriptor._meta, String(descriptor.name)).not.toHaveProperty(["openai/fileParams"]);
    }
    const wired = Object.fromEntries(toolList({ chatFiles: true }).map((descriptor) => [descriptor.name, descriptor])) as Record<
      string,
      Record<string, any>
    >;
    expect(wired.create_pack!._meta["openai/fileParams"]).toEqual(["images"]);
    expect(wired.estimate_pack!._meta["openai/fileParams"]).toEqual(["images"]);
    expect(wired.check_main_image!._meta["openai/fileParams"]).toEqual(["image"]);
    expect(wired.get_pack!._meta).not.toHaveProperty(["openai/fileParams"]);
    const file = wired.create_pack!.inputSchema.properties.images.items;
    expect(Object.keys(file.properties).sort()).toEqual(["download_url", "file_id", "file_name", "mime_type"]);
    expect([...file.required].sort()).toEqual(["download_url", "file_id"]);
    expect(wired.check_main_image!.inputSchema.properties.image.required.sort()).toEqual(["download_url", "file_id"]);
  });
});

describe("server instructions", () => {
  it("hold the whole flow in the first 512 characters and never ask for a get_pack loop", () => {
    expect(MCP_INSTRUCTIONS).toBe(
      "Curvi turns real product photos into marketplace and ad images without redrawing the product. It changes the background, size and surroundings. It does not draw new images or write listing text. Pick channels with list_channels, call estimate_pack and tell the user the credits, then create_pack with its quote and max_credits. Packs take a few minutes. Use get_pack for status when asked, or show_pack to open existing previews and files. check_main_image checks main images without credits.",
    );
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    for (const tool of ["list_channels", "estimate_pack", "create_pack", "get_pack", "show_pack", "check_main_image"]) {
      expect(MCP_INSTRUCTIONS).toContain(tool);
    }
    expect(MCP_INSTRUCTIONS).not.toMatch(/until|poll|repeatedly|keep calling|finished is true/i);
    expect(rule9Problems(MCP_INSTRUCTIONS)).toEqual([]);
    expect(mcpCopyProblems(MCP_INSTRUCTIONS)).toEqual([]);
  });
});

describe("cacheable results (MCP 2026-07-28)", () => {
  it("puts ttlMs and cacheScope on tools/list, server/discover and the three resources methods", async () => {
    expect(MCP_LIST_CACHE.ttlMs).toBeGreaterThanOrEqual(0);
    expect(["public", "private"]).toContain(MCP_LIST_CACHE.cacheScope);
    const list = await json(await handleMcpPost(rpc("tools/list")));
    expect(list.result).toMatchObject(MCP_LIST_CACHE);
    const discover = await json(await handleMcpPost(rpc("server/discover")));
    expect(discover.result).toMatchObject(MCP_LIST_CACHE);

    const viewer = { uri: "ui://curvi/test/v1.html", mimeType: "text/html;profile=mcp-app", text: "<p></p>" };
    const resources: McpResourceProvider = {
      list: () => [{ uri: viewer.uri, name: "Test", mimeType: viewer.mimeType }],
      read: (uri) => (uri === viewer.uri ? [viewer] : null),
    };
    for (const [method, params, headers] of [
      ["resources/list", {}, {}],
      ["resources/templates/list", {}, {}],
      ["resources/read", { uri: viewer.uri }, { "mcp-name": viewer.uri }],
    ] as const) {
      const answer = await json(await handleMcpPost(rpc(method, params, headers), { resources }));
      expect(answer.result, method).toMatchObject({ resultType: "complete", ...MCP_LIST_CACHE });
    }
  });

  it("leaves them off the earlier handshake revisions' tools/list", async () => {
    const legacy = new Request("https://curvi.ai/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${fixture.key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const answer = await json(await handleMcpPost(legacy));
    expect(answer.result.tools.length).toBeGreaterThan(0);
    expect(answer.result).not.toHaveProperty("ttlMs");
  });
});

describe("tool results", () => {
  it("send structured content that validates against the outputSchema, its JSON as the first text block and the sentence after", async () => {
    const png = (await mainImagePng(1600, 0.8)).toString("base64");
    const created = await json(
      await handleMcpPost(rpc("tools/call", { name: "create_pack", arguments: { channels: ["amazon.main"], photos: [{ data: png }] } })),
    );
    const packId = created.result.structuredContent.pack_id as string;
    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_channels", {}],
      ["estimate_pack", { channels: ["amazon.main", "shopify"], photos: [{ data: png }] }],
      ["create_pack", { channels: ["etsy"], photos: [{ data: png }] }],
      ["get_pack", { pack_id: packId }],
      ["get_pack", { pack_id: packId, include_files: true }],
      ["show_pack", { pack_id: packId }],
      ["check_main_image", { data: png }],
    ];
    // Walk the pack to its files, so a finished pack's view is checked too.
    for (let i = 0; i < 20; i += 1) {
      calls.push(["get_pack", { pack_id: packId }]);
    }
    const descriptors = Object.fromEntries(toolList().map((descriptor) => [descriptor.name, descriptor])) as Record<string, Record<string, any>>;
    let sawImages = false;
    for (const [name, args] of calls) {
      if (name === "get_pack") {
        // The simulated worker advances outside the read-only tool.
        await fixture.service.getJob(DEMO_WORKSPACE_ID, packId);
      }
      const answer = await json(await handleMcpPost(rpc("tools/call", { name, arguments: args })));
      const result = answer.result as { isError: boolean; structuredContent: unknown; content: Array<{ type: string; text: string }> };
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBe(false);
      expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
      const schema = z.fromJSONSchema(descriptors[name]!.outputSchema);
      expect(schema.safeParse(result.structuredContent).success, `${name} against its outputSchema`).toBe(true);
      expect(schema.safeParse({ ...(result.structuredContent as object), extra: 1 }).success, `${name} is closed`).toBe(false);
      if (result.content[1]) {
        expect(rule9Problems(result.content[1].text)).toEqual([]);
        expect(mcpCopyProblems(result.content[1].text)).toEqual([]);
      }
      sawImages ||= Array.isArray((result.structuredContent as { images?: unknown[] }).images);
    }
    expect(sawImages).toBe(true);
  });

  it("send refusals as isError with text only, never structured content", async () => {
    const answer = await json(await handleMcpPost(rpc("tools/call", { name: "get_pack", arguments: { pack_id: "nope" } })));
    expect(answer.result).toEqual({
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: "This pack does not exist in your workspace." }],
    });
  });
});
