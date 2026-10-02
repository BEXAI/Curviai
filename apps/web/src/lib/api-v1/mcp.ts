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
 *
 * This file is the transport and the authentication branch; the tools are
 * in ./mcp-tools (PHASE_19 P19-02 split them so the sign in and tool work
 * edit different files).
 *
 * Sign in (PHASE_19 P19-06 and P19-08, docs/phases/PHASE_19.md "Sign in
 * design"): with MCP_OAUTH_ENABLED at "1", initialize, tools/list and
 * tools/call need a credential, either a cv_ API key (unchanged) or an
 * OAuth access token from Supabase's OAuth server (lib/mcp-auth). Without
 * one they answer HTTP 401 with `WWW-Authenticate: Bearer
 * resource_metadata="...", scope="openid email"` (founder decision 2); a
 * token that fails adds `error="invalid_token"`. A valid token with no live
 * connection gets the tool level challenge from tools/call. server/discover
 * and ping stay open. get_profile is offered to OAuth callers only. Any
 * other value of the flag keeps the endpoint exactly as it was, which is the
 * rollback. Failures are counted and logged through ./mcp-log, which keeps
 * no token, link, tool argument or result and no client _meta hint.
 */

import { API_AUTH_COPY, authenticateApiKey, type ApiAuthResult, type ApiCallerKind } from "@/lib/api-keys/auth";
import { bearerKeyOf, prefixOf, type ApiScope } from "@/lib/api-keys/format";
import { readBodyLimited } from "@/lib/http/read-body";
import { authenticateMcp, type AuthenticateMcpOptions, type McpAuthResult } from "@/lib/mcp-auth/authenticate";
import { challengeHeader, toolChallengeResult } from "@/lib/mcp-auth/challenge";
import { mcpOAuthConfig, mcpOAuthEnabled, type McpOAuthConfig } from "@/lib/mcp-auth/config";
import { PACK_VIEWER_RESOURCES } from "@/lib/mcp-ui/pack-viewer/resource";
import { errorResult, toolOverLimit } from "./actions";
import { API_PHOTO_BODY_MAX_BYTES } from "./http";
import { MCP_COPY } from "./mcp-copy";
import { requestHostAllowed } from "@/lib/http/client-ip";
import { isAllowedMcpOrigin } from "./mcp-cors";
import { logMcpEvent, type McpLogEvent, type McpLogFields } from "./mcp-log";
import {
  MCP_INSTRUCTIONS,
  MCP_LIST_CACHE,
  OAUTH_ONLY_TOOL_NAMES,
  findTool,
  toolList,
  toolResult,
  withoutInlinePhotoBytes,
  type ToolDefinition,
} from "./mcp-tools";
import { API_VERSION } from "./openapi";
import { NO_ATTACHMENT, missingAttachmentIn } from "./photos";
import { CHAT_FILES_WIRED } from "./schemas";

/** Modern revisions this server speaks, newest first. */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
/** Handshake revisions answered through initialize, newest first. */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];

export const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

export const SERVER_INFO = { name: "curvi", title: "Curvi", version: API_VERSION } as const;

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

// Resources

/**
 * The UI resources the server serves through resources/list, resources/read
 * and resources/templates/list: the pack viewer (PHASE_19 P19-19, shipped by
 * deploy after the first publication, decision 6). With no provider the
 * server advertises no resources capability and those methods answer Method
 * not found, as before.
 */
export interface McpResourceProvider {
  /** The resources/list entries (uri, name, mimeType, _meta). */
  list(): Array<Record<string, unknown>>;
  /** The resources/read contents for a uri, or null when there is none. */
  read(uri: string): Array<Record<string, unknown>> | null;
}

/** The provider production serves: the pack viewer (P19-19,
 * lib/mcp-ui/pack-viewer/resource.ts), or null while PACK_VIEWER_LIVE is off. */
const SERVED_RESOURCES: McpResourceProvider | null = PACK_VIEWER_RESOURCES;

const RESOURCE_METHODS = new Set(["resources/list", "resources/read", "resources/templates/list"]);

// Request handling

export interface McpDeps {
  /** The API key authenticator (tests swap it). */
  authenticate?: (headers: Headers, scope: ApiScope | null) => Promise<ApiAuthResult>;
  /** Replaces the served resources in tests; null serves none. */
  resources?: McpResourceProvider | null;
  /** Overrides MCP_OAUTH_ENABLED (tests). */
  oauthEnabled?: boolean;
  /** The OAuth sign in's backend, config, key set and clock (tests). */
  oauth?: Omit<AuthenticateMcpOptions, "preAuth" | "authenticateApiKey">;
}

function resourcesOf(deps: McpDeps): McpResourceProvider | null {
  return deps.resources === undefined ? SERVED_RESOURCES : deps.resources;
}

function oauthOn(deps: McpDeps): boolean {
  return deps.oauthEnabled ?? mcpOAuthEnabled();
}

/** Methods that need a credential while the OAuth path is on (decision 2). */
const SIGNED_IN_METHODS = new Set(["initialize", "tools/list", "tools/call"]);

/** Whether a caller of this kind is offered the tool: the OAuth only tools
 * (OAUTH_ONLY_TOOL_NAMES) are left out for everyone else, so an API key
 * client sees the list it saw before PHASE_19. */
function offeredTo(tool: Pick<ToolDefinition, "name">, kind: ApiCallerKind | "none"): boolean {
  return kind === "oauth" || !OAUTH_ONLY_TOOL_NAMES.has(tool.name);
}

/** tools/list for a caller of this kind. An OAuth caller is not offered
 * base64 photo bytes, which its small body cap would refuse. */
function toolsFor(kind: ApiCallerKind | "none"): Array<Record<string, unknown>> {
  const tools = toolList().filter((tool) => offeredTo({ name: String(tool.name) }, kind));
  return kind === "oauth" ? tools.map(withoutInlinePhotoBytes) : tools;
}

/**
 * Caching hints for tools/list (MCP 2026-07-28). "public" lets a shared cache
 * serve the list to any user, which holds only while the list is the same for
 * everyone: with the OAuth path off nobody is signed in at tools/list. With it
 * on, an OAuth caller also sees get_profile and an API key caller does not, so
 * the list belongs to one authorization context and is marked "private".
 */
function toolListCache(kind: ApiCallerKind | "none"): { ttlMs: number; cacheScope: "public" | "private" } {
  return kind === "none" ? MCP_LIST_CACHE : { ttlMs: MCP_LIST_CACHE.ttlMs, cacheScope: "private" };
}

function log(event: McpLogEvent, fields: McpLogFields, level: "info" | "warn" | "error" = "warn"): void {
  logMcpEvent(event, fields, { level });
}

function capabilitiesOf(deps: McpDeps): Record<string, unknown> {
  return resourcesOf(deps) ? { tools: {}, resources: {} } : { tools: {} };
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

/** Validates the mirrored headers of a modern request; null when they hold.
 * Mcp-Name mirrors params.name on tools/call and params.uri on
 * resources/read (checked only while resources are served). */
function modernHeaderProblem(
  request: Request,
  parsed: ParsedRequest,
  version: string,
  resourcesServed: boolean,
): Response | null {
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
  const nameField =
    parsed.method === "tools/call" ? "name" : parsed.method === "resources/read" && resourcesServed ? "uri" : null;
  if (nameField) {
    const rawName = request.headers.get("mcp-name");
    if (rawName === null) {
      return mismatch(parsed.id, "the Mcp-Name header is missing");
    }
    const name = decodeHeaderValue(rawName);
    if (name !== parsed.params[nameField]) {
      return mismatch(parsed.id, "Mcp-Name header value does not match body value");
    }
  }
  return null;
}

function discoverResult(deps: McpDeps): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: capabilitiesOf(deps),
    _meta: { [SERVER_INFO_META]: SERVER_INFO },
    instructions: MCP_INSTRUCTIONS,
    // MCP 2026-07-28 caching hints (CacheableResult, P19-13).
    ...MCP_LIST_CACHE,
  };
}

/** resources/list, resources/read and resources/templates/list from the
 * served provider, with the MCP 2026-07-28 caching hints (P19-13) on a
 * modern request; the viewer is the same for every caller. */
function resourcesMethod(parsed: ParsedRequest, provider: McpResourceProvider, complete: Record<string, unknown>): Response {
  const cacheable = "resultType" in complete ? MCP_LIST_CACHE : {};
  if (parsed.method === "resources/list") {
    return rpcResponse(parsed.id, { result: { ...complete, resources: provider.list(), ...cacheable } });
  }
  if (parsed.method === "resources/templates/list") {
    return rpcResponse(parsed.id, { result: { ...complete, resourceTemplates: [], ...cacheable } });
  }
  const uri = parsed.params.uri;
  const contents = typeof uri === "string" ? provider.read(uri) : null;
  if (!contents) {
    // MCP 2026-07-28 answers an unknown resource with Invalid Params.
    return rpcError(parsed.id, { code: JSONRPC.invalidParams, message: "Resource not found", data: { uri } }, 200);
  }
  return rpcResponse(parsed.id, { result: { ...complete, contents, ...cacheable } });
}

function unknownTool(parsed: ParsedRequest): Response {
  return rpcError(parsed.id, { code: JSONRPC.invalidParams, message: `Unknown tool: ${String(parsed.params.name)}` }, 200);
}

/** True when a chat attachment argument of the tool came through with
 * nothing usable in it, such as a placeholder string a model wrote in place
 * of the file (P19-15). Checked before the strict schema, which would
 * otherwise answer with a schema error instead of the attach line. */
function attachmentMissingFor(tool: ToolDefinition, rawArgs: Record<string, unknown>): boolean {
  return (
    CHAT_FILES_WIRED &&
    (tool.fileParams ?? []).some((field) => (field === "images" || field === "image") && missingAttachmentIn(rawArgs, field))
  );
}

/** Parses the arguments and runs the tool for an authenticated caller. */
async function runTool(
  request: Request,
  parsed: ParsedRequest,
  complete: Record<string, unknown>,
  tool: ToolDefinition,
  auth: Extract<ApiAuthResult, { ok: true }>,
): Promise<Response> {
  const rawArgs = (parsed.params.arguments ?? {}) as Record<string, unknown>;
  if (attachmentMissingFor(tool, rawArgs)) {
    log("tool_error", { reason: NO_ATTACHMENT.reason, tool: tool.name, status: NO_ATTACHMENT.status, auth: auth.caller.kind }, "info");
    return rpcResponse(parsed.id, {
      result: { ...complete, ...toolResult(errorResult(NO_ATTACHMENT.status, NO_ATTACHMENT.reason, NO_ATTACHMENT.message)) },
    });
  }
  const args = tool.args.safeParse(rawArgs);
  if (!args.success) {
    const issues = args.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
    log("tool_error", { reason: "invalid_request", tool: tool.name, status: 400, auth: auth.caller.kind }, "info");
    return rpcResponse(parsed.id, {
      result: { ...complete, ...toolResult({ status: 400, body: { error: "Invalid arguments.", reason: "invalid_request", issues } }) },
    });
  }
  const ctx = { caller: auth.caller, headers: request.headers };
  // PHASE_19 P19-21: the reads and estimate_pack meet their own limit here,
  // on either sign in path; the other tools' actions count their own.
  const result = (await toolOverLimit(tool.name, ctx)) ?? (await tool.run(ctx, args.data as never, rawArgs));
  if (result.status >= 400) {
    const reason = (result.body as { reason?: unknown } | null)?.reason;
    log(
      "tool_error",
      { reason: typeof reason === "string" ? reason : "error", tool: tool.name, status: result.status, auth: auth.caller.kind },
      result.status >= 500 ? "error" : "info",
    );
  }
  return rpcResponse(parsed.id, { result: { ...complete, ...toolResult(result) } });
}

/** tools/call while the OAuth path is off: API keys only, as before PHASE_19. */
async function callTool(
  request: Request,
  parsed: ParsedRequest,
  modern: boolean,
  deps: McpDeps,
  preAuth: ApiAuthResult | null,
): Promise<Response> {
  const name = parsed.params.name;
  const tool = findTool(name);
  if (!tool || !offeredTo(tool, "api_key")) {
    return unknownTool(parsed);
  }
  // The key was already looked up before the body was read; reuse that
  // answer and narrow it to this tool's scope instead of a second lookup.
  const auth = preAuth
    ? withScope(preAuth, tool.scope)
    : await (deps.authenticate ?? authenticateApiKey)(request.headers, tool.scope);
  const complete = modern ? { resultType: "complete" } : {};
  if (!auth.ok) {
    if (auth.error.status === 401) {
      const credential = auth.error.reason === "missing_key" ? "none" : "api_key";
      log("unauthorized", { reason: auth.error.reason, method: parsed.method, tool: tool.name, status: 401, auth: credential });
      return rpcError(
        parsed.id,
        { code: JSONRPC.unauthorized, message: auth.error.message, data: { reason: auth.error.reason } },
        401,
        { "WWW-Authenticate": 'Bearer realm="curvi"' },
      );
    }
    log("tool_error", { reason: auth.error.reason, tool: tool.name, status: auth.error.status, auth: "api_key" });
    return rpcResponse(parsed.id, {
      result: {
        ...complete,
        ...toolResult({ status: auth.error.status, body: { error: auth.error.message, reason: auth.error.reason } }),
      },
    });
  }
  return runTool(request, parsed, complete, tool, auth);
}

// Sign in (MCP_OAUTH_ENABLED on)

function credentialOf(auth: McpAuthResult): ApiCallerKind | "none" {
  return auth.ok ? auth.caller.kind : auth.credential;
}

function reasonOf(auth: Extract<McpAuthResult, { ok: false }>): string {
  const failure = auth.failure;
  switch (failure.kind) {
    case "api_key":
      return failure.error.reason;
    case "token":
      return failure.reason;
    default:
      return failure.kind;
  }
}

/**
 * The HTTP answer to a request whose credential is missing or fails, or null
 * when the credential itself holds (a valid token without a usable
 * connection, a plan refusal, a key refused for its plan or scope). Missing:
 * 401 with the challenge. A key or token that fails: 401 with
 * error="invalid_token"; a token short of the scopes: 403 with
 * error="insufficient_scope" (M1). The token is never echoed.
 */
function signInRefusal(parsed: ParsedRequest, auth: Extract<McpAuthResult, { ok: false }>, config: McpOAuthConfig): Response | null {
  const failure = auth.failure;
  const refuse = (status: 401 | 403, message: string, reason: string, header: string) =>
    rpcError(parsed.id, { code: JSONRPC.unauthorized, message, data: { reason } }, status, { "WWW-Authenticate": header });
  if (failure.kind === "no_credential") {
    return refuse(401, MCP_COPY.connectAccount, "no_credential", challengeHeader(config));
  }
  if (failure.kind === "api_key" && failure.error.status === 401) {
    // The neutral line, not the API copy (which points at Settings, API
    // keys): with sign in on, an assistant may read it.
    return refuse(
      401,
      MCP_COPY.keyRefused,
      failure.error.reason,
      challengeHeader(config, { error: "invalid_token", description: MCP_COPY.keyRefused }),
    );
  }
  if (failure.kind === "token") {
    if (failure.reason === "insufficient_scope") {
      return refuse(
        403,
        MCP_COPY.connectAccount,
        "insufficient_scope",
        challengeHeader(config, { error: "insufficient_scope", description: MCP_COPY.connectAccount }),
      );
    }
    return refuse(
      401,
      MCP_COPY.connectAccount,
      "invalid_token",
      challengeHeader(config, { error: "invalid_token", description: MCP_COPY.connectAccount }),
    );
  }
  return null;
}

function unavailableRefusal(parsed: ParsedRequest, message: string): Response {
  return rpcError(parsed.id, { code: JSONRPC.internalError, message }, 503, { "Retry-After": "30" });
}

/**
 * The credential check of initialize and tools/list: answers the refusal,
 * or null to go on. A credential that holds passes even when its workspace
 * cannot be used yet; tools/call says why.
 */
function discoveryRefusal(parsed: ParsedRequest, auth: McpAuthResult, config: McpOAuthConfig): Response | null {
  if (auth.ok) {
    return null;
  }
  const refusal = signInRefusal(parsed, auth, config);
  const event: McpLogEvent = parsed.method === "initialize" ? "initialize_failed" : "unauthorized";
  if (refusal) {
    log(event, { reason: reasonOf(auth), method: parsed.method, status: refusal.status, auth: auth.credential });
    return refusal;
  }
  if (auth.failure.kind === "unavailable") {
    log(event, { reason: "unavailable", method: parsed.method, status: 503, auth: auth.credential }, "error");
    return unavailableRefusal(parsed, auth.failure.message);
  }
  return null;
}

/** tools/call while the OAuth path is on. */
async function callToolSignedIn(
  request: Request,
  parsed: ParsedRequest,
  modern: boolean,
  auth: McpAuthResult,
  config: McpOAuthConfig,
): Promise<Response> {
  const complete = modern ? { resultType: "complete" } : {};
  const tool = findTool(parsed.params.name);
  // Only a name the server offers reaches the log.
  const toolName = tool?.name;
  if (!auth.ok) {
    const refusal = signInRefusal(parsed, auth, config);
    const fields: McpLogFields = { reason: reasonOf(auth), method: parsed.method, tool: toolName, auth: auth.credential };
    if (refusal) {
      log("unauthorized", { ...fields, status: refusal.status });
      return refusal;
    }
    const failure = auth.failure;
    if (failure.kind === "reconnect") {
      log("challenge", { ...fields, status: 200 });
      return rpcResponse(parsed.id, { result: { ...complete, ...toolChallengeResult(config, MCP_COPY.reconnect) } });
    }
    const body =
      failure.kind === "not_in_plan"
        ? { status: 403, error: failure.message, reason: "not_in_plan" }
        : failure.kind === "unavailable"
          ? { status: 503, error: failure.message, reason: "unavailable" }
          : failure.kind === "api_key" && failure.error.reason === "upgrade_required"
            ? { status: 403, error: MCP_COPY.apiKeysNotInPlan, reason: "not_in_plan" }
            : failure.kind === "api_key"
              ? { status: failure.error.status, error: failure.error.message, reason: failure.error.reason }
              : { status: 500, error: MCP_COPY.connectionUnavailable, reason: "unavailable" };
    log("tool_error", { ...fields, reason: body.reason, status: body.status }, body.status >= 500 ? "error" : "warn");
    return rpcResponse(parsed.id, {
      result: { ...complete, ...toolResult({ status: body.status, body: { error: body.error, reason: body.reason } }) },
    });
  }
  if (!tool || !offeredTo(tool, auth.caller.kind)) {
    return unknownTool(parsed);
  }
  const scoped = withScope({ ok: true, caller: auth.caller }, tool.scope);
  if (!scoped.ok) {
    log("tool_error", { reason: scoped.error.reason, tool: tool.name, status: scoped.error.status, auth: auth.caller.kind });
    return rpcResponse(parsed.id, {
      result: {
        ...complete,
        ...toolResult({ status: scoped.error.status, body: { error: scoped.error.message, reason: scoped.error.reason } }),
      },
    });
  }
  return runTool(request, parsed, complete, tool, scoped);
}

/** Body cap for a request without a valid API key. Discovery (initialize,
 * server/discover, tools/list, ping) needs no key and is small; only a
 * keyed tools/call may carry base64 photos, so a client without a real key,
 * including one that sends a forged but well formed key, cannot make the
 * server buffer and parse a photo sized body. */
export const MCP_UNKEYED_BODY_MAX_BYTES = 64_000;

/** The body cap for a request: the photo cap only when its API key was
 * looked up, before the body is read, and found valid. */
export function mcpBodyCap(auth: ApiAuthResult | null): number {
  return auth?.ok ? API_PHOTO_BODY_MAX_BYTES : MCP_UNKEYED_BODY_MAX_BYTES;
}

/** The request's key checked with no scope before its body is read (each
 * tool's scope is checked later by withScope), or null when the
 * Authorization header holds no well formed key, so such a request costs
 * no lookup. */
export async function preAuthenticate(headers: Headers, deps: McpDeps = {}): Promise<ApiAuthResult | null> {
  const key = bearerKeyOf(headers);
  if (key === null || prefixOf(key) === null) {
    return null;
  }
  return (deps.authenticate ?? authenticateApiKey)(headers, null);
}

/** A scope free authentication narrowed to a tool's scope: the same check
 * authenticateApiKey makes when it is given the scope. */
export function withScope(auth: ApiAuthResult, scope: ApiScope | null): ApiAuthResult {
  if (!auth.ok || !scope || auth.caller.scopes.includes(scope)) {
    return auth;
  }
  return { ok: false, error: { status: 403, reason: "insufficient_scope", message: API_AUTH_COPY.insufficient_scope } };
}

/** POST /api/mcp. */
export async function handleMcpPost(request: Request, deps: McpDeps = {}): Promise<Response> {
  // OAuth callers skip the shared egress IP bucket, but must still enter
  // through the configured production host before credentials or photos
  // are read. This closes direct-host access around the trusted proxy.
  if (!requestHostAllowed(request)) {
    log("transport_refused", { reason: "host", status: 403 });
    return rpcError(null, { code: JSONRPC.invalidRequest, message: "This host is not allowed." }, 403);
  }
  // PHASE_19 P19-20: no Origin, this site, or ChatGPT's and the OpenAI
  // platform's origins (./mcp-cors); anything else is 403 (M3).
  if (!isAllowedMcpOrigin(request)) {
    log("transport_refused", { reason: "origin", status: 403 });
    return rpcError(null, { code: JSONRPC.invalidRequest, message: "This request came from another site, so it was refused." }, 403);
  }
  // The key is checked before the body is read, so only a real key raises
  // the cap to photo size. An OAuth token keeps the small cap: ChatGPT's
  // photos arrive by link.
  const preAuth = await preAuthenticate(request.headers, deps);
  const body = await readBodyLimited(request, mcpBodyCap(preAuth));
  if (!body.ok) {
    const status = body.reason === "too_large" ? 413 : 400;
    log("transport_refused", { reason: body.reason === "too_large" ? "too_large" : "unreadable", status });
    return rpcError(
      null,
      { code: JSONRPC.invalidRequest, message: body.reason === "too_large" ? "This request is too large." : "The request could not be read." },
      status,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    log("transport_refused", { reason: "parse_error", status: 400 });
    return rpcError(null, { code: JSONRPC.parseError, message: "Parse error" }, 400);
  }
  const parsed = parseMessage(raw);
  if (!parsed) {
    log("transport_refused", { reason: "invalid_request", status: 400 });
    return rpcError(null, { code: JSONRPC.invalidRequest, message: "Invalid Request: send one JSON-RPC 2.0 request per POST." }, 400);
  }
  if (parsed.isNotification) {
    // No notification changes anything here (notifications/initialized,
    // notifications/cancelled): accepted, nothing to answer.
    return new Response(null, { status: 202 });
  }

  const metaVersion = metaVersionOf(parsed.params);
  const modern = parsed.method !== "initialize" && metaVersion !== undefined;
  const protocolProblem = (reason: string, response: Response): Response => {
    const event: McpLogEvent =
      parsed.method === "initialize" ? "initialize_failed" : parsed.method === "server/discover" ? "discover_failed" : "transport_refused";
    log(event, {
      reason,
      method: parsed.method,
      status: response.status,
      protocol: typeof metaVersion === "string" ? metaVersion : undefined,
    });
    return response;
  };
  if (modern) {
    if (typeof metaVersion !== "string" || !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(metaVersion)) {
      return protocolProblem("unsupported_version", unsupported(parsed.id, metaVersion));
    }
    const problem = modernHeaderProblem(request, parsed, metaVersion, resourcesOf(deps) !== null);
    if (problem) {
      return protocolProblem("header_mismatch", problem);
    }
  } else if (parsed.method !== "initialize") {
    // A handshake client after initialize: the header, when sent, names a
    // handshake revision (2025-06-18 and later send it; 2025-03-26 did not).
    const headerVersion = request.headers.get("mcp-protocol-version");
    if (headerVersion !== null && !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion)) {
      return protocolProblem("unsupported_version", unsupported(parsed.id, headerVersion));
    }
  }
  const complete = modern ? { resultType: "complete" } : {};
  const resources = resourcesOf(deps);
  if (resources && RESOURCE_METHODS.has(parsed.method)) {
    return resourcesMethod(parsed, resources, complete);
  }

  // Sign in (decision 2): with the OAuth path on, initialize, tools/list and
  // tools/call need a credential; the caller's kind decides the tool list.
  let signedIn: McpAuthResult | null = null;
  let config: McpOAuthConfig | null = null;
  if (oauthOn(deps) && SIGNED_IN_METHODS.has(parsed.method)) {
    config = deps.oauth?.config ?? mcpOAuthConfig();
    signedIn = await authenticateMcp(request.headers, null, {
      ...deps.oauth,
      config,
      preAuth,
      ...(deps.authenticate ? { authenticateApiKey: deps.authenticate } : {}),
    });
    if (parsed.method !== "tools/call") {
      const refusal = discoveryRefusal(parsed, signedIn, config);
      if (refusal) {
        return refusal;
      }
    }
  }
  const callerKind: ApiCallerKind | "none" = signedIn ? credentialOf(signedIn) : "none";

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
          capabilities: capabilitiesOf(deps),
          serverInfo: SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        },
      });
    }
    case "server/discover":
      return rpcResponse(parsed.id, { result: discoverResult(deps) });
    case "ping":
      return rpcResponse(parsed.id, { result: { ...complete } });
    case "tools/list":
      return rpcResponse(parsed.id, {
        result: { ...complete, tools: toolsFor(callerKind), ...(modern ? toolListCache(callerKind) : {}) },
      });
    case "tools/call":
      return signedIn && config
        ? callToolSignedIn(request, parsed, modern, signedIn, config)
        : callTool(request, parsed, modern, deps, preAuth);
    default:
      return rpcError(parsed.id, { code: JSONRPC.methodNotFound, message: "Method not found" }, modern ? 404 : 200);
  }
}

/** GET and DELETE on /api/mcp: no stream and no sessions to end. */
export function mcpMethodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
