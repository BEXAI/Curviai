/**
 * The hosted MCP server at /api/mcp (PHASE_16 workstream 5): Streamable HTTP,
 * POST only, no sessions, one JSON answer per request. Tools create_pack,
 * get_pack, check_main_image and list_channels run the same actions as the
 * public API v1 (./actions), authenticated by the same workspace API keys.
 *
 * Protocol (docs/verification.md, "Model Context Protocol, Streamable HTTP",
 * fetched 2026-09-29): the current revision 2026-07-28 carries the version
 * in params._meta["io.modelcontextprotocol/protocolVersion"] and in the
 * MCP-Protocol-Version header, which must match, as must Mcp-Method and, for
 * tools/call, Mcp-Name (HeaderMismatch -32020, HTTP 400). An unsupported
 * version answers -32022 with the supported list, an unknown method -32601
 * with HTTP 404, a notification 202, GET and DELETE 405. Clients of the
 * earlier handshake revisions (2025-11-25 and before) still work: they call
 * initialize and are served statelessly, with no session id minted.
 *
 * Written directly instead of with @modelcontextprotocol/sdk: the surface
 * is a handful of methods, and this adds no dependency.
 */

import { z } from "zod";
import { authenticateApiKey, type ApiAuthResult } from "@/lib/api-keys/auth";
import { bearerKeyOf, prefixOf, type ApiScope } from "@/lib/api-keys/format";
import { isSameOrigin } from "@/lib/http/same-origin";
import { readBodyLimited } from "@/lib/http/read-body";
import { checkMainImage, createPack, getPack, listChannels, listPackFiles, type ApiContext, type ApiResult } from "./actions";
import { API_PHOTO_BODY_MAX_BYTES } from "./http";
import { API_VERSION } from "./openapi";
import { CreatePackRequest, MainImageCheckRequest } from "./schemas";

/** Modern revisions this server speaks, newest first. */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
/** Handshake revisions answered through initialize, newest first. */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];

export const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

export const SERVER_INFO = { name: "curvi", title: "Curvi", version: API_VERSION } as const;

export const MCP_INSTRUCTIONS =
  "Curvi makes marketplace ready product image packs from real product photos and never redraws the product. " +
  "Call list_channels to see the channels and bundles. Call create_pack with photo links, channels and a fresh idempotency_key; it holds credits. " +
  "Then call get_pack until finished is true, with include_files to get download links that work for 15 minutes. " +
  "check_main_image checks an Amazon main image for free.";

export const JSONRPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  unauthorized: -32001,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const;

type JsonRpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResponse(id: JsonRpcId, body: { result: unknown } | { error: RpcError }, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function rpcError(id: JsonRpcId, error: RpcError, status: number, headers: Record<string, string> = {}): Response {
  return rpcResponse(id, { error }, status, headers);
}

/** "=?base64?...?=" header values decoded; plain values as sent. */
export function decodeHeaderValue(value: string): string | null {
  const match = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value);
  if (!match) {
    return value;
  }
  try {
    return Buffer.from(match[1] ?? "", "base64").toString("utf8");
  } catch {
    return null;
  }
}

// Tools

const CreatePackArgs = z
  .object({
    ...CreatePackRequest.shape,
    idempotency_key: z
      .string()
      .min(1)
      .max(200)
      .describe("A fresh value for each new pack; send the same value again only to retry the same request."),
  })
  .strict();

const GetPackArgs = z
  .object({
    pack_id: z.string().describe("The pack id create_pack returned."),
    include_files: z
      .boolean()
      .optional()
      .describe("Also list the delivered files with download links signed for 15 minutes."),
  })
  .strict();

const ListChannelsArgs = z.object({}).strict();

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  scope: ApiScope | null;
  args: z.ZodType;
  annotations: Record<string, boolean>;
  /** args is the parsed arguments; raw is what the client sent, for tools
   * whose action parses again and must not see the schema's defaults. */
  run: (ctx: ApiContext, args: never, raw: Record<string, unknown>) => Promise<ApiResult>;
}

function inputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  const { $schema: _dialect, ...rest } = json;
  return rest;
}

export const MCP_TOOLS: readonly ToolDefinition[] = [
  {
    name: "create_pack",
    title: "Create a pack",
    description:
      "Start a Curvi pack from real product photos for the chosen channels. Holds credits like the web form. Returns the pack; poll get_pack until finished.",
    scope: "packs:write",
    args: CreatePackArgs,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (ctx, args: z.infer<typeof CreatePackArgs>, raw) => {
      // createPack parses the body itself: pass it as sent, so the output
      // options' defaults do not clash with the bundle or look shortcuts.
      const { idempotency_key: _key, ...body } = raw;
      return createPack(ctx, body, args.idempotency_key);
    },
  },
  {
    name: "get_pack",
    title: "Get a pack",
    description: "Read a pack's status and per shot results, and optionally its files with short lived download links.",
    scope: "packs:read",
    args: GetPackArgs,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, args: z.infer<typeof GetPackArgs>) => {
      const pack = await getPack(ctx, args.pack_id);
      if (pack.status !== 200 || !args.include_files) {
        return pack;
      }
      const files = await listPackFiles(ctx, args.pack_id);
      if (files.status !== 200) {
        return files;
      }
      const filesBody = files.body as { files: unknown[]; notice?: string };
      return {
        status: 200,
        body: {
          ...(pack.body as Record<string, unknown>),
          files: filesBody.files,
          ...(filesBody.notice ? { filesNotice: filesBody.notice } : {}),
        },
      };
    },
  },
  {
    name: "check_main_image",
    title: "Check an Amazon main image",
    description:
      "Check an Amazon main image against the real rules: longest side, pure white edges and product fill. Free, uses no credits.",
    scope: "checks",
    args: MainImageCheckRequest,
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (ctx, args: z.infer<typeof MainImageCheckRequest>) => checkMainImage(ctx, args),
  },
  {
    name: "list_channels",
    title: "List channels",
    description: "List the channel specs and pack bundles create_pack accepts, with availability on this workspace's plan.",
    scope: null,
    args: ListChannelsArgs,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx) => listChannels(ctx),
  },
];

export function toolList(): Array<Record<string, unknown>> {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchemaOf(tool.args),
    annotations: tool.annotations,
  }));
}

function toolResult(result: ApiResult): Record<string, unknown> {
  const body = result.body as Record<string, unknown>;
  if (result.status < 400) {
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: false };
  }
  const message = typeof body?.error === "string" ? body.error : "The call failed.";
  const issues = Array.isArray(body?.issues) ? ` ${(body.issues as string[]).join(" ")}` : "";
  return { content: [{ type: "text", text: `${message}${issues}` }], structuredContent: body, isError: true };
}

// Request handling

export interface McpDeps {
  authenticate?: (headers: Headers, scope: ApiScope | null) => Promise<ApiAuthResult>;
}

interface ParsedRequest {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
  isNotification: boolean;
}

function parseMessage(raw: unknown): ParsedRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const message = raw as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return null;
  }
  const hasId = "id" in message;
  const id = message.id;
  if (hasId && typeof id !== "string" && typeof id !== "number") {
    return null;
  }
  const params = message.params;
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    return null;
  }
  return {
    id: hasId ? (id as string | number) : null,
    method: message.method,
    params: (params as Record<string, unknown> | undefined) ?? {},
    isNotification: !hasId,
  };
}

function metaVersionOf(params: Record<string, unknown>): unknown {
  const meta = params._meta;
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>)[PROTOCOL_VERSION_META] : undefined;
}

function unsupported(id: JsonRpcId, requested: unknown): Response {
  return rpcError(
    id,
    {
      code: JSONRPC.unsupportedVersion,
      message: "Unsupported protocol version",
      data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested },
    },
    400,
  );
}

function mismatch(id: JsonRpcId, message: string): Response {
  return rpcError(id, { code: JSONRPC.headerMismatch, message: `Header mismatch: ${message}` }, 400);
}

/** Validates the mirrored headers of a modern request; null when they hold. */
function modernHeaderProblem(request: Request, parsed: ParsedRequest, version: string): Response | null {
  const headerVersion = request.headers.get("mcp-protocol-version");
  if (headerVersion === null) {
    return mismatch(parsed.id, "the MCP-Protocol-Version header is missing");
  }
  if (headerVersion !== version) {
    return mismatch(parsed.id, `MCP-Protocol-Version header value '${headerVersion}' does not match body value '${version}'`);
  }
  const headerMethod = request.headers.get("mcp-method");
  if (headerMethod === null) {
    return mismatch(parsed.id, "the Mcp-Method header is missing");
  }
  if (headerMethod !== parsed.method) {
    return mismatch(parsed.id, `Mcp-Method header value '${headerMethod}' does not match body value '${parsed.method}'`);
  }
  if (parsed.method === "tools/call") {
    const rawName = request.headers.get("mcp-name");
    if (rawName === null) {
      return mismatch(parsed.id, "the Mcp-Name header is missing");
    }
    const name = decodeHeaderValue(rawName);
    if (name !== parsed.params.name) {
      return mismatch(parsed.id, "Mcp-Name header value does not match body value");
    }
  }
  return null;
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: { tools: {} },
    _meta: { [SERVER_INFO_META]: SERVER_INFO },
    instructions: MCP_INSTRUCTIONS,
  };
}

async function callTool(
  request: Request,
  parsed: ParsedRequest,
  modern: boolean,
  deps: McpDeps,
): Promise<Response> {
  const name = parsed.params.name;
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return rpcError(parsed.id, { code: JSONRPC.invalidParams, message: `Unknown tool: ${String(name)}` }, 200);
  }
  const auth = await (deps.authenticate ?? authenticateApiKey)(request.headers, tool.scope);
  const complete = modern ? { resultType: "complete" } : {};
  if (!auth.ok) {
    if (auth.error.status === 401) {
      return rpcError(
        parsed.id,
        { code: JSONRPC.unauthorized, message: auth.error.message, data: { reason: auth.error.reason } },
        401,
        { "WWW-Authenticate": 'Bearer realm="curvi"' },
      );
    }
    return rpcResponse(parsed.id, {
      result: {
        ...complete,
        ...toolResult({ status: auth.error.status, body: { error: auth.error.message, reason: auth.error.reason } }),
      },
    });
  }
  const rawArgs = (parsed.params.arguments ?? {}) as Record<string, unknown>;
  const args = tool.args.safeParse(rawArgs);
  if (!args.success) {
    const issues = args.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
    return rpcResponse(parsed.id, {
      result: { ...complete, ...toolResult({ status: 400, body: { error: "Invalid arguments.", reason: "invalid_request", issues } }) },
    });
  }
  const result = await tool.run({ caller: auth.caller, headers: request.headers }, args.data as never, rawArgs);
  return rpcResponse(parsed.id, { result: { ...complete, ...toolResult(result) } });
}

/** Body cap for a request without a well formed API key. Discovery
 * (initialize, server/discover, tools/list, ping) needs no key and is
 * small; only a keyed tools/call may carry base64 photos, so an anonymous
 * client cannot make the server buffer and parse a photo sized body before
 * any key is checked. */
export const MCP_UNKEYED_BODY_MAX_BYTES = 64_000;

/** The body cap for a request: the photo cap only when the Authorization
 * header holds a well formed key. The key itself is checked later, per
 * tool, with that tool's scope. */
export function mcpBodyCap(headers: Headers): number {
  const key = bearerKeyOf(headers);
  return key !== null && prefixOf(key) !== null ? API_PHOTO_BODY_MAX_BYTES : MCP_UNKEYED_BODY_MAX_BYTES;
}

/** POST /api/mcp. */
export async function handleMcpPost(request: Request, deps: McpDeps = {}): Promise<Response> {
  if (!isSameOrigin(request)) {
    return rpcError(null, { code: JSONRPC.invalidRequest, message: "This request came from another site, so it was refused." }, 403);
  }
  const body = await readBodyLimited(request, mcpBodyCap(request.headers));
  if (!body.ok) {
    return rpcError(
      null,
      { code: JSONRPC.invalidRequest, message: body.reason === "too_large" ? "This request is too large." : "The request could not be read." },
      body.reason === "too_large" ? 413 : 400,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return rpcError(null, { code: JSONRPC.parseError, message: "Parse error" }, 400);
  }
  const parsed = parseMessage(raw);
  if (!parsed) {
    return rpcError(null, { code: JSONRPC.invalidRequest, message: "Invalid Request: send one JSON-RPC 2.0 request per POST." }, 400);
  }
  if (parsed.isNotification) {
    // No notification changes anything here (notifications/initialized,
    // notifications/cancelled): accepted, nothing to answer.
    return new Response(null, { status: 202 });
  }

  const metaVersion = metaVersionOf(parsed.params);
  const modern = parsed.method !== "initialize" && metaVersion !== undefined;
  if (modern) {
    if (typeof metaVersion !== "string" || !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(metaVersion)) {
      return unsupported(parsed.id, metaVersion);
    }
    const problem = modernHeaderProblem(request, parsed, metaVersion);
    if (problem) {
      return problem;
    }
  } else if (parsed.method !== "initialize") {
    // A handshake client after initialize: the header, when sent, names a
    // handshake revision (2025-06-18 and later send it; 2025-03-26 did not).
    const headerVersion = request.headers.get("mcp-protocol-version");
    if (headerVersion !== null && !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion)) {
      return unsupported(parsed.id, headerVersion);
    }
  }
  const complete = modern ? { resultType: "complete" } : {};

  switch (parsed.method) {
    case "initialize": {
      const requested = parsed.params.protocolVersion;
      const version =
        typeof requested === "string" && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LEGACY_PROTOCOL_VERSIONS[0];
      return rpcResponse(parsed.id, {
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        },
      });
    }
    case "server/discover":
      return rpcResponse(parsed.id, { result: discoverResult() });
    case "ping":
      return rpcResponse(parsed.id, { result: { ...complete } });
    case "tools/list":
      return rpcResponse(parsed.id, { result: { ...complete, tools: toolList() } });
    case "tools/call":
      return callTool(request, parsed, modern, deps);
    default:
      return rpcError(parsed.id, { code: JSONRPC.methodNotFound, message: "Method not found" }, modern ? 404 : 200);
  }
}

/** GET and DELETE on /api/mcp: no stream and no sessions to end. */
export function mcpMethodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
