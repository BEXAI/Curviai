import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { ProfileChat } from "@/lib/api-v1/chat-views";
import { JSONRPC, PROTOCOL_VERSION_META, handleMcpPost, type McpDeps } from "@/lib/api-v1/mcp";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { setMcpLogSinkForTests, type McpLogEntry } from "@/lib/api-v1/mcp-log";
import { MCP_TOOLS } from "@/lib/api-v1/mcp-tools";
import { demoApiFixture, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { memoryMcpAuthBackend, type MemoryMembership } from "@/lib/mcp-auth/backend";
import { MemoryMcpConnectionStore } from "@/lib/mcp-auth/connections";
import { checkAssistantAccess } from "@/lib/entitlements";
import { TEST_CLIENT_ID, TEST_CONFIG, TEST_USER_ID, oauthClaims, testKeys, type TestKeys } from "@/lib/mcp-auth/test-tokens";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { DEMO_WORKSPACE_ID } from "@/lib/services/demo";
import { POST } from "./route";

// /api/mcp with MCP_OAUTH_ENABLED on (docs/phases/PHASE_19.md, P19-06,
// P19-08 and P19-11): the 401 challenge on initialize, tools/list and
// tools/call without a credential (decision 2), OAuth callers next to API
// keys, the tool level challenge, get_profile, and a logger that keeps no
// token, link or client hint.

const VERSION = "2026-07-28";
const METADATA = "https://curvi.ai/.well-known/oauth-protected-resource/api/mcp";
const WS_OTHER = "00000000-0000-4000-8000-00000000bbbb";

let keys: TestKeys;
let fixture: DemoApiFixture;
let seats: MemoryMembership[];
let store: MemoryMcpConnectionStore;
let deps: McpDeps;
let logged: McpLogEntry[];
let nextId = 1;

function seat(workspaceId = DEMO_WORKSPACE_ID, role: MemoryMembership["role"] = "owner"): MemoryMembership {
  return { userId: TEST_USER_ID, workspaceId, workspaceName: workspaceId === DEMO_WORKSPACE_ID ? "Demo Workspace" : "Other shop", plan: "free", role };
}

interface RpcOptions {
  bearer?: string | null;
  modern?: boolean;
  meta?: Record<string, unknown>;
}

function rpc(method: string, params: Record<string, unknown> = {}, options: RpcOptions = {}): Request {
  const modern = options.modern ?? true;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(modern ? { "mcp-protocol-version": VERSION, "mcp-method": method } : {}),
    ...(modern && method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
  };
  if (options.bearer) {
    headers.authorization = `Bearer ${options.bearer}`;
  }
  return new Request("https://curvi.ai/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: modern ? { ...params, _meta: { [PROTOCOL_VERSION_META]: VERSION, ...options.meta } } : params,
    }),
  });
}

async function send(request: Request, overrides: McpDeps = {}) {
  const response = await handleMcpPost(request, { ...deps, ...overrides });
  const body = (await response.json()) as {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type: string; text: string }>;
      tools?: Array<{ name: string }>;
      _meta?: Record<string, unknown>;
      protocolVersion?: string;
    };
    error?: { code: number; message: string; data?: { reason?: string } };
  };
  return { response, body };
}

async function token(claims = oauthClaims()): Promise<string> {
  return keys.sign(claims);
}

beforeAll(async () => {
  keys = await testKeys();
});

beforeEach(() => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  seats = [seat()];
  store = new MemoryMcpConnectionStore();
  deps = {
    oauthEnabled: true,
    oauth: {
      backend: memoryMcpAuthBackend({ memberships: seats, connections: store, services: () => fixture.service }),
      config: TEST_CONFIG,
      jwks: keys.jwks,
    },
  };
  logged = [];
  setMcpLogSinkForTests((entry) => logged.push(entry));
});

afterEach(() => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
  setMcpLogSinkForTests(null);
  vi.unstubAllEnvs();
});

describe("without a credential (decision 2)", () => {
  it("answers initialize, tools/list and tools/call with 401 and the challenge", async () => {
    const requests = [
      rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "chatgpt", version: "1" } }, { modern: false }),
      rpc("tools/list"),
      rpc("tools/call", { name: "list_channels", arguments: {} }),
      rpc("tools/call", { name: "no_such_tool", arguments: {} }),
    ];
    for (const request of requests) {
      const { response, body } = await send(request);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA}", scope="openid email"`);
      expect(body.error).toMatchObject({ code: JSONRPC.unauthorized, message: MCP_COPY.connectAccount, data: { reason: "no_credential" } });
      expect(body.error?.message).not.toMatch(/api key/i);
    }
    expect(logged.map((entry) => entry.event)).toEqual(["initialize_failed", "unauthorized", "unauthorized", "unauthorized"]);
  });

  it("keeps server/discover and ping open", async () => {
    expect((await send(rpc("server/discover"))).response.status).toBe(200);
    expect((await send(rpc("ping"))).response.status).toBe(200);
  });
});

describe("a token that fails", () => {
  it("answers 401 with invalid_token, never echoing the token", async () => {
    for (const bad of [await token(oauthClaims({ aud: "authenticated" })), await token(oauthClaims({ client_id: "someone-else" })), "eyJ.garbage.x"]) {
      const { response, body } = await send(rpc("tools/list", {}, { bearer: bad }));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${METADATA}", scope="openid email", error="invalid_token", error_description="${MCP_COPY.connectAccount}"`,
      );
      expect(JSON.stringify(body)).not.toContain(bad);
    }
  });

  it("answers 403 with insufficient_scope when the scopes fall short", async () => {
    const { response } = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer: await token(oauthClaims({ scope: "openid" })) }));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("answers 503 when the token cannot be checked right now", async () => {
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    const { response, body } = await send(rpc("tools/list", {}, { bearer: await token() }), { oauth: { ...deps.oauth, jwks: down } });
    expect(response.status).toBe(503);
    expect(body.error?.message).toBe(MCP_COPY.connectionUnavailable);
  });
});

describe("an OAuth caller", () => {
  it("lists every tool, get_profile included, and runs them in the connection's workspace", async () => {
    const bearer = await token();
    const init = await send(rpc("initialize", { protocolVersion: "2025-11-25" }, { modern: false, bearer }));
    expect(init.body.result?.protocolVersion).toBe("2025-11-25");
    const list = await send(rpc("tools/list", {}, { bearer }));
    expect(list.body.result?.tools?.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    expect(list.body.result?.tools?.map((tool) => tool.name)).toContain("get_profile");
    // The list depends on the caller's kind once the OAuth path is on, so a
    // shared cache must not serve it to another user (M2 cacheScope).
    expect(list.body.result).toMatchObject({ ttlMs: 300_000, cacheScope: "private" });
    const keyList = await send(rpc("tools/list", {}, { bearer: fixture.key }));
    expect(keyList.body.result).toMatchObject({ ttlMs: 300_000, cacheScope: "private" });
    // An OAuth caller keeps the small body cap, so it is not offered base64
    // photo bytes, only attachments and links; a key caller still is.
    const schemaOf = (tools: unknown, name: string) =>
      JSON.stringify((tools as Array<{ name: string; inputSchema: unknown }>).find((tool) => tool.name === name)?.inputSchema);
    for (const name of ["create_pack", "estimate_pack", "check_main_image"]) {
      expect(schemaOf(list.body.result?.tools, name), name).not.toContain('"data"');
      expect(schemaOf(list.body.result?.tools, name), name).toContain('"url"');
      expect(schemaOf(keyList.body.result?.tools, name), name).toContain('"data"');
    }

    const channels = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer }));
    expect(channels.body.result?.isError).toBe(false);
    // An OAuth create_pack needs the quote and max_credits from estimate_pack (P19-16).
    const choices = { channels: ["amazon.main"], title: "Desk lamp" };
    const estimate = await send(rpc("tools/call", { name: "estimate_pack", arguments: choices }, { bearer }));
    expect(estimate.body.result?.isError, JSON.stringify(estimate.body.result?.content)).toBe(false);
    const quoted = estimate.body.result?.structuredContent as { quote: string; credits_needed: number };
    const created = await send(
      rpc("tools/call", { name: "create_pack", arguments: { ...choices, quote: quoted.quote, max_credits: quoted.credits_needed } }, { bearer }),
    );
    expect(created.body.result?.isError, JSON.stringify(created.body.result?.content)).toBe(false);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ workspaceId: DEMO_WORKSPACE_ID, oauthClientId: TEST_CLIENT_ID, revokedAt: null });
  });

  it("stops a client seat from starting a pack", async () => {
    seats[0] = seat(DEMO_WORKSPACE_ID, "client");
    const { body } = await send(rpc("tools/call", { name: "create_pack", arguments: { channels: ["amazon.main"], idempotency_key: "seat" } }, { bearer: await token() }));
    // Refusals are text only (P19-13), in the neutral copy.
    expect(body.result).toMatchObject({ isError: true, content: [{ type: "text", text: MCP_COPY.clientSeat }] });
    expect(body.result?.structuredContent).toBeUndefined();
  });

  it("gets the tool level challenge without a usable connection, in O1's shape, and no row comes back", async () => {
    seats.push(seat(WS_OTHER));
    const bearer = await token();
    // Two workspaces and no row: tools/list still answers, tools/call asks
    // to connect again so the consent page can ask which workspace.
    expect((await send(rpc("tools/list", {}, { bearer }))).response.status).toBe(200);
    const { response, body } = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer }));
    expect(response.status).toBe(200);
    expect(body.result).toEqual({
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: MCP_COPY.reconnect }],
      _meta: {
        "mcp/www_authenticate": [`Bearer resource_metadata="${METADATA}", error="invalid_token", error_description="${MCP_COPY.reconnect}"`],
      },
    });
    expect(store.rows).toHaveLength(0);
    expect(logged.some((entry) => entry.event === "challenge")).toBe(true);
  });

  it("is refused at once when the member leaves, and stays refused when they come back", async () => {
    const bearer = await token();
    expect((await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer }))).body.result?.isError).toBe(false);
    seats.length = 0;
    const gone = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer }));
    expect(gone.body.result?.content?.[0]?.text).toBe(MCP_COPY.reconnect);
    seats.push(seat());
    const back = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer }));
    expect(back.body.result?.content?.[0]?.text).toBe(MCP_COPY.reconnect);
    expect(store.rows.filter((row) => !row.revokedAt)).toHaveLength(0);
  });

  it("hears the neutral copy when the plan leaves assistant access out", async () => {
    const off = { ...deps.oauth, assistantAccess: (plan: string) => checkAssistantAccess(plan, () => false) };
    const { body } = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer: await token() }), { oauth: off });
    expect(body.result).toMatchObject({ isError: true, content: [{ type: "text", text: MCP_COPY.assistantAccessOff }] });
    expect(JSON.stringify(body)).not.toMatch(/upgrade/i);
  });
});

describe("get_profile (P19-11)", () => {
  async function profile(bearer: string) {
    const { body } = await send(rpc("tools/call", { name: "get_profile", arguments: {} }, { bearer }));
    expect(body.result?.isError).toBe(false);
    const structured = ProfileChat.parse(body.result?.structuredContent);
    expect(body.result?.content?.[0]?.text).toBe(JSON.stringify(body.result?.structuredContent));
    return structured;
  }

  it("returns a stable opaque id, the workspace name and the email", async () => {
    const first = await profile(await token());
    expect(first).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), name: "Demo Workspace", email: "seller@example.com" });
    const text = JSON.stringify(first);
    for (const raw of [TEST_USER_ID, DEMO_WORKSPACE_ID, store.rows[0]!.id, TEST_CLIENT_ID]) {
      expect(text).not.toContain(raw);
    }

    // A refreshed token (a new session on the same connection).
    const refreshed = await profile(await token(oauthClaims({ session_id: "33333333-3333-4444-8555-666666666666" })));
    expect(refreshed.id).toBe(first.id);

    // A disconnect, then a reconnect through the consent page into another
    // workspace: the id stays.
    seats.push(seat(WS_OTHER));
    await store.revoke(store.rows[0]!.id, new Date());
    await store.connect({ userId: TEST_USER_ID, oauthClientId: TEST_CLIENT_ID, clientName: "ChatGPT", workspaceId: WS_OTHER }, new Date());
    const moved = await profile(await token());
    expect(moved).toEqual({ id: first.id, name: "Other shop", email: "seller@example.com" });
  });

  it("leaves the email out when the token has none", async () => {
    expect(await profile(await token(oauthClaims({ email: "" })))).toEqual({ id: expect.any(String), name: "Demo Workspace" });
  });

  it("is neither listed nor callable for an API key, with the OAuth path on or off", async () => {
    for (const oauthEnabled of [true, false]) {
      const list = await send(rpc("tools/list", {}, { bearer: fixture.key }), { oauthEnabled });
      expect(list.body.result?.tools?.map((tool) => tool.name)).toEqual(["list_channels", "estimate_pack", "create_pack", "get_pack", "check_main_image"]);
      const called = await send(rpc("tools/call", { name: "get_profile", arguments: {} }, { bearer: fixture.key }), { oauthEnabled });
      expect(called.body.error?.code).toBe(JSONRPC.invalidParams);
    }
  });
});

describe("API keys with the OAuth path on", () => {
  it("keep working as before", async () => {
    const { response, body } = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer: fixture.key }));
    expect(response.status).toBe(200);
    expect(body.result?.isError).toBe(false);
    const created = await send(rpc("tools/call", { name: "create_pack", arguments: { channels: ["amazon.main"], idempotency_key: "key-1" } }, { bearer: fixture.key }));
    expect(created.body.result?.isError).toBe(false);
  });

  it("answer a bad key with 401 and the challenge, and never ask for a key in chat on a plan refusal", async () => {
    const { response } = await send(rpc("tools/list", {}, { bearer: `cv_live_000000000000_${"A".repeat(43)}` }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${METADATA}"`);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const planless = vi.fn(async () => ({ ok: false as const, error: { status: 403 as const, reason: "upgrade_required" as const, message: "API keys are part of Growth and up. Upgrade to use them." } }));
    const refused = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer: fixture.key }), { authenticate: planless });
    expect(refused.body.result).toMatchObject({ isError: true, content: [{ type: "text", text: MCP_COPY.apiKeysNotInPlan }] });
    expect(JSON.stringify(refused.body)).not.toMatch(/upgrade/i);
    // tools/list still answers for that key, as it did before PHASE_19.
    expect((await send(rpc("tools/list", {}, { bearer: fixture.key }), { authenticate: planless })).response.status).toBe(200);
  });
});

describe("with MCP_OAUTH_ENABLED off", () => {
  it("behaves as before: discovery open, keys only, the old challenge for a JWT", async () => {
    vi.stubEnv("MCP_OAUTH_ENABLED", "0");
    // The env decides: no oauthEnabled override.
    const off: McpDeps = { oauthEnabled: undefined, oauth: deps.oauth };
    expect((await send(rpc("tools/list"), off)).response.status).toBe(200);
    const init = await send(rpc("initialize", { protocolVersion: "2025-11-25" }, { modern: false }), off);
    expect(init.response.status).toBe(200);
    const jwt = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer: await token() }), off);
    expect(jwt.response.status).toBe(401);
    expect(jwt.response.headers.get("www-authenticate")).toBe('Bearer realm="curvi"');
    const route = await POST(rpc("tools/list"));
    expect(route.status).toBe(200);
    expect(((await route.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)).not.toContain("get_profile");
  });
});

describe("logging (O7)", () => {
  it("counts failures by reason and keeps no token, link, argument or client hint", async () => {
    const bearer = await token();
    const hints = {
      "openai/subject": "subject-secret-123",
      "openai/userLocation": { city: "Lisbon", latitude: 38.72 },
      "openai/locale": "pt-PT",
    };
    const link = "https://curvi.ai/api/mcp/files/signed-token-abc";
    seats.push(seat(WS_OTHER));
    await send(rpc("tools/call", { name: "get_pack", arguments: { pack_id: link } }, { bearer, meta: hints }));
    seats.length = 1;
    await send(rpc("tools/call", { name: "get_pack", arguments: { pack_id: link } }, { bearer, meta: hints }));
    await send(rpc("tools/call", { name: "get_pack", arguments: { pack_id: link } }, { bearer: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln", meta: hints }));
    await send(rpc("tools/list", {}, { meta: hints }));
    expect(logged.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(logged);
    for (const secret of [bearer, "eyJhbGciOiJFUzI1NiJ9", "subject-secret-123", "Lisbon", "pt-PT", "signed-token-abc", link]) {
      expect(text).not.toContain(secret);
    }
    expect(logged.map((entry) => entry.event)).toEqual(expect.arrayContaining(["challenge", "tool_error", "unauthorized"]));
    for (const entry of logged) {
      expect(Object.keys(entry.fields).every((field) => ["reason", "method", "tool", "status", "auth", "protocol"].includes(field))).toBe(true);
    }
  });
});
