import { existsSync, readFileSync } from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The interoperability replay (docs/phases/PHASE_19.md, P19-26): /api/mcp
// and the metadata documents answered against the shapes OpenAI and the MCP
// specification document, as a client written from those pages would send
// and read them. The documented examples are copied below as fixtures, with
// their source (docs/verification.md, "PHASE_19", rows dated 2026-10-01):
//
//   O1 https://developers.openai.com/plugins/build/auth
//   O2 https://developers.openai.com/plugins/reference
//   M1 https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
//   M4 https://modelcontextprotocol.io/specification/2026-07-28/server/tools
//   RFC 9728 (protected resource metadata), RFC 6750 and RFC 7235 (challenges)
//
// Photo links are not fetched: the SSRF safe import is replaced by one that
// hands back a test PNG and records the link it was given.

const photo = vi.hoisted(() => ({ body: null as Buffer | null, fetched: [] as string[] }));

vi.mock("@/lib/url-import/image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/url-import/image")>();
  const { createHash } = await import("node:crypto");
  return {
    ...actual,
    importPhoto: vi.fn(async (url: string) => {
      photo.fetched.push(url);
      const body = photo.body!;
      return {
        ok: true as const,
        photo: { body, contentType: "image/png" as const, sha256: createHash("sha256").update(body).digest("hex"), width: 1200, height: 1200 },
      };
    }),
  };
});

import { GET as getRootMetadata, OPTIONS as preflightMetadata } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as getPathMetadata } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { JSONRPC, PROTOCOL_VERSION_META, handleMcpPost, type McpDeps } from "@/lib/api-v1/mcp";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { setMcpLogSinkForTests } from "@/lib/api-v1/mcp-log";
import { demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { memoryMcpAuthBackend, type MemoryMembership } from "@/lib/mcp-auth/backend";
import { mcpOAuthConfig, mcpResourceUrl } from "@/lib/mcp-auth/config";
import { MemoryMcpConnectionStore } from "@/lib/mcp-auth/connections";
import type { SessionChecker } from "@/lib/mcp-auth/sessions";
import { TEST_CONFIG, TEST_ISSUER, TEST_RESOURCE, TEST_USER_ID, hs256Token, oauthClaims, testKeys, type TestKeys } from "@/lib/mcp-auth/test-tokens";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { DEMO_WORKSPACE_ID } from "@/lib/services/demo";
import { POST, OPTIONS as preflightMcp } from "./route";

// Documented shapes (fixtures)

/** O1: "Required fields: resource, authorization_servers, and scopes_supported." */
const O1_METADATA_REQUIRED = ["resource", "authorization_servers", "scopes_supported"] as const;

/** O1's tool level auth error example, as published (with its extra single
 * quotes around the challenge; see verification row "Tool level auth error"). */
const O1_TOOL_CHALLENGE_EXAMPLE = {
  jsonrpc: "2.0",
  id: 4,
  result: {
    content: [{ type: "text", text: "Authentication required: no access token provided." }],
    _meta: {
      "mcp/www_authenticate": [
        "'Bearer resource_metadata=\"https://your-mcp.example.com/.well-known/oauth-protected-resource\", error=\"insufficient_scope\", error_description=\"You need to login to continue\"'",
      ],
    },
    isError: true,
  },
};

/** O1's profile tool descriptor (the parts a profile tool must match). */
const O1_PROFILE_TOOL = {
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, pattern: "\\S" },
      name: { type: "string" },
      email: { type: "string" },
      nickname: { type: "string" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { "openai/profile": true },
};

/** O2's file parameter schema ($defs.OpenAIFile) and runtime object. The
 * runtime example's "https://..." is filled with a real looking link. */
const O2_FILE_SCHEMA = {
  type: "object",
  properties: {
    download_url: { type: "string" },
    file_id: { type: "string" },
    mime_type: { type: "string" },
    file_name: { type: "string" },
  },
  required: ["download_url", "file_id"],
};
const O2_FILE_OBJECT = {
  download_url: "https://files.oaiusercontent.com/file-AbC123?se=2026-10-01T12%3A00%3A00Z&sp=r&sig=abc",
  file_id: "file_AbC123",
  mime_type: "image/png",
  file_name: "input.png",
};

/** O2: tool descriptor _meta keys and their limits. */
const O2_STATUS_TEXT_MAX = 64;
/** M4: tool names SHOULD be 1 to 128 of A-Z, a-z, 0-9, _, - and . */
const M4_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const MODERN = "2026-07-28";
const SITE = "https://curvi.ai";
const RESOURCE = `${SITE}/api/mcp`;
const METADATA_URL = `${SITE}/.well-known/oauth-protected-resource/api/mcp`;
const SUPABASE = "https://project.supabase.co";
const ENDED_SESSION = "44444444-3333-4444-8555-666666666666";
const WS_OTHER = "00000000-0000-4000-8000-00000000bbbb";

// RFC 7235 challenges

interface Challenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parses one challenge as RFC 7235 writes it: a scheme, then auth-params
 * `token = ( token / quoted-string )` separated by commas. Throws on anything
 * else, so a malformed header fails the test instead of passing loosely.
 */
function parseChallenge(header: string): Challenge {
  const scheme = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?:\s+|$)/.exec(header);
  if (!scheme) {
    throw new Error(`No auth scheme in ${header}`);
  }
  const params: Record<string, string> = {};
  let rest = header.slice(scheme[0].length);
  while (rest.length > 0) {
    const param = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9!#$%&'*+.^_`|~-]+))\s*(?:,\s*|$)/.exec(rest);
    if (!param) {
      throw new Error(`Malformed auth-param at: ${rest}`);
    }
    const name = param[1]!.toLowerCase();
    if (name in params) {
      throw new Error(`Repeated auth-param ${name}`);
    }
    params[name] = param[2] !== undefined ? param[2].replace(/\\(.)/g, "$1") : param[3]!;
    rest = rest.slice(param[0].length);
  }
  return { scheme: scheme[1]!, params };
}

// A small JSON Schema check, for the keywords the output schemas use (a
// client validating structuredContent against outputSchema, M4 "Clients
// SHOULD validate"). An unknown keyword throws, so nothing passes unchecked.

const ANNOTATION_KEYWORDS = new Set(["description", "title", "format", "$schema"]);
const CHECKED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function schemaProblems(schema: Record<string, any>, value: unknown, path = "$"): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!CHECKED_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)) {
      throw new Error(`The schema check does not know the keyword ${keyword} (at ${path})`);
    }
  }
  const problems: string[] = [];
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
      return [`${path}: ${actual} is not ${types.join(" or ")}`];
    }
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: ${String(value)} is not in the enum`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path}: under the minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path}: over the maximum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) problems.push(`${path}: too short`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) problems.push(`${path}: too long`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) problems.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path}: too many items`);
    if (schema.items) value.forEach((item, i) => problems.push(...schemaProblems(schema.items, item, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) problems.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) {
        problems.push(...schemaProblems(property, child, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}.${key}: not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        problems.push(...schemaProblems(schema.additionalProperties, child, `${path}.${key}`));
      }
    }
  }
  return problems;
}

// Requests

let keys: TestKeys;
let rsaKeys: { jwks: ReturnType<typeof createLocalJWKSet>; sign: (claims: JWTPayload) => Promise<string> };
let fixture: DemoApiFixture;
let seats: MemoryMembership[];
let store: MemoryMcpConnectionStore;
let deps: McpDeps;
let nextId = 1;

interface RpcOptions {
  bearer?: string | null;
  /** "modern" is a 2026-07-28 client; a revision string is a handshake client. */
  protocol?: "modern" | "2025-11-25" | "2025-06-18" | "2025-03-26";
  origin?: string;
  notification?: boolean;
}

function rpc(method: string, params: Record<string, unknown> = {}, options: RpcOptions = {}): Request {
  const protocol = options.protocol ?? "modern";
  const modern = protocol === "modern";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (modern) {
    headers["mcp-protocol-version"] = MODERN;
    headers["mcp-method"] = method;
    if (method === "tools/call") {
      headers["mcp-name"] = String(params.name);
    }
  } else if (method !== "initialize" && protocol !== "2025-03-26") {
    headers["mcp-protocol-version"] = protocol;
  }
  if (options.bearer) {
    headers.authorization = `Bearer ${options.bearer}`;
  }
  if (options.origin) {
    headers.origin = options.origin;
  }
  const body = {
    jsonrpc: "2.0",
    ...(options.notification ? {} : { id: nextId++ }),
    method,
    params: modern
      ? {
          ...params,
          // M4: every 2026-07-28 request carries these three in _meta.
          _meta: {
            [PROTOCOL_VERSION_META]: MODERN,
            "io.modelcontextprotocol/clientInfo": { name: "interop-client", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        }
      : params,
  };
  return new Request(RESOURCE, { method: "POST", headers, body: JSON.stringify(body) });
}

type RpcBody = {
  jsonrpc: string;
  id: unknown;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

async function send(request: Request, overrides: McpDeps = {}): Promise<{ response: Response; body: RpcBody }> {
  const response = await handleMcpPost(request, { ...deps, ...overrides });
  const text = await response.text();
  return { response, body: (text ? JSON.parse(text) : {}) as RpcBody };
}

async function token(overrides: JWTPayload = {}): Promise<string> {
  return keys.sign(oauthClaims(overrides));
}

function sessionsChecker(): SessionChecker {
  return { check: async (sessionId: string) => (sessionId === ENDED_SESSION ? "ended" : "alive") };
}

function stubSiteEnv(): void {
  vi.stubEnv("MCP_OAUTH_ENABLED", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE);
  vi.stubEnv("MCP_RESOURCE_URL", "");
  vi.stubEnv("SUPABASE_AUTH_ISSUER", "");
}

beforeAll(async () => {
  keys = await testKeys();
  // An RS256 key beside the ES256 one: Supabase may sign with either (SB3).
  const rsa = await generateKeyPair("RS256", { extractable: true });
  const rsaPublic = { ...(await exportJWK(rsa.publicKey)), kid: "rsa-current", alg: "RS256", use: "sig" };
  rsaKeys = {
    jwks: createLocalJWKSet({ keys: [rsaPublic] }),
    sign: (claims) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "rsa-current", typ: "JWT" }).setIssuedAt().setExpirationTime("1h").sign(rsa.privateKey),
  };
  photo.body = await mainImagePng(1200, 0.8);
});

beforeEach(() => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  seats = [{ userId: TEST_USER_ID, workspaceId: DEMO_WORKSPACE_ID, workspaceName: "Demo Workspace", plan: "free", role: "owner" }];
  store = new MemoryMcpConnectionStore();
  deps = {
    oauthEnabled: true,
    oauth: {
      backend: memoryMcpAuthBackend({ memberships: seats, connections: store, sessions: sessionsChecker(), services: () => fixture.service }),
      config: TEST_CONFIG,
      jwks: keys.jwks,
    },
  };
  photo.fetched = [];
  // The refusals below are logged by design (mcp-log.test.ts covers that).
  setMcpLogSinkForTests(() => {});
});

afterEach(() => {
  setApiKeyBackendForTests(null);
  setRateLimitStoreForTests(null);
  setMcpLogSinkForTests(null);
  vi.unstubAllEnvs();
});

describe("the schema check this file uses", () => {
  it("refuses what it should and knows every keyword it meets", () => {
    const schema = { type: "object", properties: { a: { type: "string", minLength: 2 } }, required: ["a"], additionalProperties: false };
    expect(schemaProblems(schema, { a: "ok" })).toEqual([]);
    expect(schemaProblems(schema, { b: 1 })).toEqual(["$.a: required", "$.b: not allowed"]);
    expect(schemaProblems(schema, { a: "x" })).toEqual(["$.a: too short"]);
    expect(schemaProblems({ type: ["string", "null"] }, 3)).toEqual(["$: integer is not string or null"]);
    expect(() => schemaProblems({ anyOf: [] }, 1)).toThrow(/does not know the keyword anyOf/);
    expect(parseChallenge('Bearer realm="curvi"')).toEqual({ scheme: "Bearer", params: { realm: "curvi" } });
    expect(() => parseChallenge('Bearer realm="curvi" scope')).toThrow(/Malformed/);
  });
});

// Protected resource metadata

describe("protected resource metadata (RFC 9728, O1, M1)", () => {
  it("serves the same document at the root and the path form, with every required field", async () => {
    stubSiteEnv();
    const [root, path] = [await getRootMetadata(), await getPathMetadata()];
    for (const response of [root, path]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
    const document = (await root.json()) as Record<string, any>;
    expect(await path.json()).toEqual(document);
    for (const field of O1_METADATA_REQUIRED) {
      expect(document[field], field).toBeDefined();
    }
    // resource is the URL users paste, byte for byte; the issuer is Supabase
    // Auth's, as its own metadata names it.
    expect(document.resource).toBe(RESOURCE);
    expect(document.resource).toBe(mcpResourceUrl());
    expect(document.authorization_servers).toEqual([`${SUPABASE}/auth/v1`]);
    expect(document.scopes_supported).toEqual(["openid", "email"]);
    // M1: servers SHOULD NOT list offline_access.
    expect(document.scopes_supported).not.toContain("offline_access");
    expect(document.bearer_methods_supported).toEqual(["header"]);
    for (const field of ["resource", "resource_documentation", "resource_policy_uri", "resource_tos_uri"]) {
      expect(new URL(document[field]).protocol, field).toBe("https:");
    }
    for (const server of document.authorization_servers as string[]) {
      expect(new URL(server).protocol).toBe("https:");
    }
  });

  it("puts the path form where RFC 9728 says: the well known prefix before the resource's path", () => {
    stubSiteEnv();
    const resource = new URL(mcpResourceUrl());
    const expected = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
    expect(mcpOAuthConfig().resourceMetadataUrl).toBe(expected);
    // The route that answers it is the file at that path.
    const routeFile = new URL(`../../.well-known/oauth-protected-resource${resource.pathname}/route.ts`, import.meta.url);
    expect(existsSync(routeFile)).toBe(true);
  });

  it("answers a browser preflight, and 404 while the sign in is off", async () => {
    stubSiteEnv();
    const preflight = await preflightMetadata();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    vi.stubEnv("MCP_OAUTH_ENABLED", "0");
    expect((await getRootMetadata()).status).toBe(404);
    expect((await getPathMetadata()).status).toBe(404);
  });
});

// The 401 challenge

describe("the 401 challenge (M1, O1, RFC 6750)", () => {
  it("answers initialize without a token with 401 and a challenge that leads to the metadata", async () => {
    stubSiteEnv();
    const response = await POST(
      rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ChatGPT", version: "1" } }, { protocol: "2025-11-25", origin: "https://chatgpt.com" }),
    );
    expect(response.status).toBe(401);
    const header = response.headers.get("www-authenticate");
    expect(header).not.toBeNull();
    const challenge = parseChallenge(header!);
    expect(challenge.scheme).toBe("Bearer");
    expect(challenge.params).toEqual({ resource_metadata: METADATA_URL, scope: "openid email" });
    // A browser client can read the challenge (CORS exposes it, P19-20).
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(response.headers.get("access-control-expose-headers")).toMatch(/WWW-Authenticate/i);
    const body = (await response.json()) as RpcBody;
    expect(body).toMatchObject({ jsonrpc: "2.0", error: { code: JSONRPC.unauthorized, message: MCP_COPY.connectAccount } });

    // The metadata it names is served, and its scopes cover the challenge's.
    const document = (await (await getPathMetadata()).json()) as { resource: string; scopes_supported: string[] };
    expect(document.resource).toBe(RESOURCE);
    for (const scope of challenge.params.scope!.split(" ")) {
      expect(document.scopes_supported).toContain(scope);
    }
  });

  it("answers a 2026-07-28 tools/list and tools/call the same way, and keeps discovery open", async () => {
    stubSiteEnv();
    for (const request of [rpc("tools/list"), rpc("tools/call", { name: "list_channels", arguments: {} })]) {
      const response = await POST(request);
      expect(response.status).toBe(401);
      expect(parseChallenge(response.headers.get("www-authenticate")!).params.resource_metadata).toBe(METADATA_URL);
    }
    // Decision 2: server/discover and ping need no token.
    expect((await POST(rpc("server/discover"))).status).toBe(200);
    expect((await POST(rpc("ping", {}, { protocol: "2025-11-25" }))).status).toBe(200);
  });

  it("names the error when a token was sent and failed, and answers a short scope with 403", async () => {
    const bad = await send(rpc("tools/list", {}, { bearer: await token({ aud: "authenticated" }) }));
    expect(bad.response.status).toBe(401);
    expect(parseChallenge(bad.response.headers.get("www-authenticate")!).params).toEqual({
      resource_metadata: TEST_CONFIG.resourceMetadataUrl,
      scope: "openid email",
      error: "invalid_token",
      error_description: MCP_COPY.connectAccount,
    });
    const short = await send(rpc("tools/list", {}, { bearer: await token({ scope: "openid" }) }));
    expect(short.response.status).toBe(403);
    expect(parseChallenge(short.response.headers.get("www-authenticate")!).params).toMatchObject({
      error: "insufficient_scope",
      scope: "openid email",
      resource_metadata: TEST_CONFIG.resourceMetadataUrl,
    });
  });
});

// Token verification

describe("token verification (O1 checklist, M1, P19-07)", () => {
  it("accepts a token shaped like Supabase's after the audience hook, bound to the metadata's resource and issuer", async () => {
    const claims = oauthClaims();
    expect(claims.aud).toBe(TEST_RESOURCE);
    expect(claims.iss).toBe(TEST_ISSUER);
    const { response } = await send(rpc("tools/list", {}, { bearer: await keys.sign(claims) }));
    expect(response.status).toBe(200);
  });

  const now = () => Math.floor(Date.now() / 1000);
  const table: Array<{ name: string; make: () => Promise<string>; status: 200 | 401 | 403; error?: "invalid_token" | "insufficient_scope" }> = [
    { name: "a valid ES256 token", make: () => token(), status: 200 },
    { name: "a valid RS256 token", make: () => rsaKeys.sign(oauthClaims()), status: 200 },
    { name: "an issuer that is not Supabase's", make: () => token({ iss: "https://evil.example/auth/v1" }), status: 401, error: "invalid_token" },
    { name: "a web session's audience (authenticated)", make: () => token({ aud: "authenticated" }), status: 401, error: "invalid_token" },
    { name: "another resource's audience", make: () => token({ aud: "https://other.example/mcp" }), status: 401, error: "invalid_token" },
    { name: "expired a minute ago", make: () => token({ exp: now() - 60 }), status: 401, error: "invalid_token" },
    { name: "expired 10 seconds ago, inside the 30 second tolerance", make: () => token({ exp: now() - 10 }), status: 200 },
    { name: "not valid for 5 more minutes", make: () => token({ nbf: now() + 300 }), status: 401, error: "invalid_token" },
    { name: "not valid for 10 more seconds, inside the tolerance", make: () => token({ nbf: now() + 10 }), status: 200 },
    { name: "HS256 with a shared secret", make: () => hs256Token(oauthClaims()), status: 401, error: "invalid_token" },
    {
      name: "alg none",
      make: async () => {
        const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
        return `${part({ alg: "none", typ: "JWT" })}.${part({ ...oauthClaims(), exp: now() + 3600 })}.${Buffer.from("sig").toString("base64url")}`;
      },
      status: 401,
      error: "invalid_token",
    },
    { name: "a key that is not in the JWKS", make: () => keys.signUnknown(oauthClaims()), status: 401, error: "invalid_token" },
    {
      name: "a payload changed after signing",
      make: async () => {
        const [header, , signature] = (await token()).split(".");
        const forged = Buffer.from(JSON.stringify({ ...oauthClaims(), sub: "00000000-0000-4000-8000-000000000999", exp: now() + 3600 })).toString("base64url");
        return `${header}.${forged}.${signature}`;
      },
      status: 401,
      error: "invalid_token",
    },
    { name: "no sub", make: () => token({ sub: undefined }), status: 401, error: "invalid_token" },
    { name: "no client_id (a web session token)", make: () => token({ client_id: undefined }), status: 401, error: "invalid_token" },
    { name: "a client that is not allowlisted", make: () => token({ client_id: "99999999-0000-4000-8000-000000000000" }), status: 401, error: "invalid_token" },
    { name: "no session_id", make: () => token({ session_id: undefined }), status: 401, error: "invalid_token" },
    { name: "a session that ended (a revoked grant)", make: () => token({ session_id: ENDED_SESSION }), status: 401, error: "invalid_token" },
    { name: "scopes without email", make: () => token({ scope: "openid profile" }), status: 403, error: "insufficient_scope" },
    { name: "no scope claim", make: () => token({ scope: undefined }), status: 403, error: "insufficient_scope" },
    { name: "only the scopes Curvi needs", make: () => token({ scope: "openid email" }), status: 200 },
    { name: "a bearer over 8 KB", make: async () => `${await token()}${"A".repeat(8_200)}`, status: 401, error: "invalid_token" },
  ];

  it.each(table)("$name: $status", async ({ make, status, error }) => {
    const bearer = await make();
    const { response, body } = await send(rpc("tools/list", {}, { bearer }), {
      oauth: { ...deps.oauth, jwks: async (header, input) => (header.alg === "RS256" ? rsaKeys.jwks(header, input) : keys.jwks(header, input)) },
    });
    expect(response.status).toBe(status);
    const header = response.headers.get("www-authenticate");
    if (error) {
      expect(parseChallenge(header!).params.error).toBe(error);
      expect(body.error?.code).toBe(JSONRPC.unauthorized);
    } else {
      expect(header).toBeNull();
      expect(body.result?.tools?.length).toBeGreaterThan(0);
    }
    // No passthrough and no echo (M1): the token appears nowhere in the answer.
    expect(JSON.stringify(body)).not.toContain(bearer);
    expect(header ?? "").not.toContain(bearer.slice(0, 40));
  });
});

// tools/list

function toolsByName(body: RpcBody): Map<string, Record<string, any>> {
  return new Map((body.result?.tools as Array<Record<string, any>>).map((tool) => [tool.name as string, tool]));
}

/** The schema a file parameter's value takes: the object itself, or the
 * items of an array of them. */
function fileObjectSchema(property: Record<string, any>): Record<string, any> {
  return property.type === "array" ? property.items : property;
}

describe("tools/list carries every documented field (O1, O2, O4, M4)", () => {
  it.each(["modern", "2025-11-25", "2025-06-18"] as const)("for a %s client", async (protocol) => {
    const bearer = await token();
    const { body } = await send(rpc("tools/list", {}, { bearer, protocol }));
    const tools = toolsByName(body);
    expect([...tools.keys()]).toEqual(["list_channels", "estimate_pack", "create_pack", "get_pack", "check_main_image", "get_profile"]);
    if (protocol === "modern") {
      // M2: tools/list is cacheable; it depends on the caller once sign in is on.
      expect(body.result).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number), cacheScope: "private" });
    }
    for (const [name, tool] of tools) {
      expect(name, name).toMatch(M4_TOOL_NAME);
      expect(typeof tool.title, name).toBe("string");
      expect(typeof tool.description, name).toBe("string");
      expect(tool.inputSchema?.type, name).toBe("object");
      // O2: an outputSchema for every tool that returns structuredContent.
      expect(tool.outputSchema?.type, name).toBe("object");
      // O4 annotations_required: the three hints, set on every tool.
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
        expect(typeof tool.annotations?.[hint], `${name} ${hint}`).toBe("boolean");
      }
      // O1: per tool securitySchemes, mirrored in _meta for older clients.
      expect(tool.securitySchemes, name).toEqual([{ type: "oauth2", scopes: ["openid", "email"] }]);
      expect(tool._meta?.securitySchemes, name).toEqual(tool.securitySchemes);
      // O2: status text at most 64 characters; visibility model and app only.
      for (const key of ["openai/toolInvocation/invoking", "openai/toolInvocation/invoked"]) {
        if (tool._meta?.[key] !== undefined) {
          expect(String(tool._meta[key]).length, `${name} ${key}`).toBeLessThanOrEqual(O2_STATUS_TEXT_MAX);
        }
      }
      for (const who of tool._meta?.ui?.visibility ?? []) {
        expect(["model", "app"]).toContain(who);
      }
      // O2 openai/fileParams: top level fields holding the documented file object.
      for (const field of (tool._meta?.["openai/fileParams"] ?? []) as string[]) {
        const property = tool.inputSchema.properties?.[field];
        expect(property, `${name} ${field}`).toBeDefined();
        const file = fileObjectSchema(property);
        expect(file.type).toBe("object");
        expect(Object.keys(file.properties).sort()).toEqual(Object.keys(O2_FILE_SCHEMA.properties).sort());
        for (const key of Object.keys(O2_FILE_SCHEMA.properties)) {
          expect(file.properties[key].type, `${name} ${field}.${key}`).toBe("string");
        }
        expect([...file.required].sort()).toEqual([...O2_FILE_SCHEMA.required].sort());
      }
    }
    expect(tools.get("create_pack")!._meta["openai/fileParams"]).toEqual(["images"]);
    expect(tools.get("estimate_pack")!._meta["openai/fileParams"]).toEqual(["images"]);
    expect(tools.get("check_main_image")!._meta["openai/fileParams"]).toEqual(["image"]);
    // Only the tool that spends credits asks ChatGPT for a confirmation (O9).
    expect([...tools.values()].filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(["create_pack"]);
    expect(tools.get("create_pack")!._meta.ui.visibility).toEqual(["model"]);
  });

  it("describes the profile tool as O1 does", async () => {
    const { body } = await send(rpc("tools/list", {}, { bearer: await token() }));
    const profile = toolsByName(body).get("get_profile")!;
    expect(profile._meta).toMatchObject(O1_PROFILE_TOOL._meta);
    expect(profile.annotations).toMatchObject(O1_PROFILE_TOOL.annotations);
    expect(profile.inputSchema).toMatchObject(O1_PROFILE_TOOL.inputSchema);
    expect(profile.inputSchema.required ?? []).toEqual([]);
    const output = profile.outputSchema;
    expect(output.type).toBe("object");
    expect(output.required).toEqual(O1_PROFILE_TOOL.outputSchema.required);
    expect(output.additionalProperties).toBe(false);
    expect(output.properties.id).toMatchObject(O1_PROFILE_TOOL.outputSchema.properties.id);
    for (const [key, schema] of Object.entries(output.properties as Record<string, Record<string, unknown>>)) {
      expect(Object.keys(O1_PROFILE_TOOL.outputSchema.properties)).toContain(key);
      expect(schema.type).toBe("string");
    }
    // Only get_profile is the profile tool.
    expect([...toolsByName(body).values()].filter((tool) => tool._meta?.["openai/profile"] === true).map((tool) => tool.name)).toEqual(["get_profile"]);
  });
});

// tools/call

function textOf(result: Record<string, any> | undefined): string {
  return (result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "";
}

describe("tools/call (O1, O2, M4)", () => {
  async function call(name: string, args: Record<string, unknown>, bearer: string) {
    return send(rpc("tools/call", { name, arguments: args }, { bearer }));
  }

  async function outputSchemas(bearer: string): Promise<Map<string, Record<string, any>>> {
    const { body } = await send(rpc("tools/list", {}, { bearer }));
    return new Map([...toolsByName(body)].map(([name, tool]) => [name, tool.outputSchema]));
  }

  /** M4: structured content matches the outputSchema and comes back as JSON
   * text too; O1 asks the same of the profile tool. */
  function expectStructured(result: Record<string, any> | undefined, schema: Record<string, any>): Record<string, any> {
    expect(result?.isError, textOf(result)).toBe(false);
    expect(schemaProblems(schema, result?.structuredContent)).toEqual([]);
    expect(textOf(result)).toBe(JSON.stringify(result?.structuredContent));
    return result!.structuredContent as Record<string, any>;
  }

  it("reads the file object from O2 and fetches only its download_url", async () => {
    const bearer = await token();
    const schemas = await outputSchemas(bearer);
    const { body } = await call("check_main_image", { image: O2_FILE_OBJECT }, bearer);
    expectStructured(body.result, schemas.get("check_main_image")!);
    expect(photo.fetched).toEqual([O2_FILE_OBJECT.download_url]);
  });

  it("takes attachments with only the two fields ChatGPT always sends, and tolerates fields it adds later", async () => {
    const bearer = await token();
    const schemas = await outputSchemas(bearer);
    const minimal = { download_url: O2_FILE_OBJECT.download_url, file_id: O2_FILE_OBJECT.file_id };
    const choices = { channels: ["amazon.main", "shopify.product"], images: [minimal] };
    const estimate = await call("estimate_pack", choices, bearer);
    const quote = expectStructured(estimate.body.result, schemas.get("estimate_pack")!);
    expect(quote).toMatchObject({ credits_needed: expect.any(Number), credits_available: expect.any(Number), quote: expect.any(String) });

    const created = await call(
      "create_pack",
      { ...choices, images: [{ ...minimal, size_bytes: 1234 }], quote: quote.quote, max_credits: quote.credits_needed },
      bearer,
    );
    const pack = expectStructured(created.body.result, schemas.get("create_pack")!);
    expect(pack).toMatchObject({ pack_id: expect.any(String), finished: false });
    // No internal ids or timestamps in the chat view (O5, O6).
    expect(JSON.stringify(pack)).not.toMatch(/createdAt|productId|\/api\/v1/);

    const got = await call("get_pack", { pack_id: pack.pack_id, include_files: true }, bearer);
    expectStructured(got.body.result, schemas.get("get_pack")!);
    expect(photo.fetched.every((url) => url === O2_FILE_OBJECT.download_url)).toBe(true);
  });

  it("answers a placeholder in place of the file with the attach line, as a tool error", async () => {
    const { body } = await call("check_main_image", { image: "photo.jpg" }, await token());
    expect(body.result).toMatchObject({ isError: true, content: [{ type: "text", text: MCP_COPY.noAttachment }] });
    expect(body.result?.structuredContent).toBeUndefined();
    expect(photo.fetched).toEqual([]);
  });

  it("returns the profile with its JSON text block (O1)", async () => {
    const bearer = await token();
    const schemas = await outputSchemas(bearer);
    const { body } = await call("get_profile", {}, bearer);
    const profile = expectStructured(body.result, schemas.get("get_profile")!);
    expect(schemaProblems(O1_PROFILE_TOOL.outputSchema, profile)).toEqual([]);
    expect(profile.id).not.toContain(TEST_USER_ID);
  });

  it("answers an unknown tool with a JSON-RPC Invalid Params error (M4)", async () => {
    const { body } = await call("delete_everything", {}, await token());
    expect(body.error?.code).toBe(-32602);
  });

  it("sends the tool level challenge in O1's shape when the connection needs the consent page again", async () => {
    seats.push({ userId: TEST_USER_ID, workspaceId: WS_OTHER, workspaceName: "Other", plan: "free", role: "owner" });
    const { response, body } = await call("list_channels", {}, await token());
    expect(response.status).toBe(200);
    const result = body.result!;
    const documented = O1_TOOL_CHALLENGE_EXAMPLE.result;
    // The same members as the documented result (plus 2026-07-28's resultType).
    expect(Object.keys(result).filter((key) => key !== "resultType").sort()).toEqual(Object.keys(documented).sort());
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: MCP_COPY.reconnect }]);
    const challenges = result._meta["mcp/www_authenticate"] as string[];
    expect(Array.isArray(challenges)).toBe(true);
    expect(challenges).toHaveLength(documented._meta["mcp/www_authenticate"].length);
    // O1's example wraps the challenge in single quotes; the server sends the
    // plain RFC 7235 form (verification row "Tool level auth error").
    const challenge = parseChallenge(challenges[0]!);
    const example = parseChallenge(documented._meta["mcp/www_authenticate"][0]!.slice(1, -1));
    expect(challenge.scheme).toBe(example.scheme);
    expect(Object.keys(challenge.params).sort()).toEqual(Object.keys(example.params).sort());
    expect(challenge.params).toEqual({
      resource_metadata: TEST_CONFIG.resourceMetadataUrl,
      error: "invalid_token",
      error_description: MCP_COPY.reconnect,
    });
  });
});

// Protocol generations and API keys

describe("clients of both protocol generations, and API keys", () => {
  it("serves a 2026-07-28 client: discover, list, call", async () => {
    const discover = await send(rpc("server/discover"));
    expect(discover.response.status).toBe(200);
    expect(discover.body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: expect.arrayContaining([MODERN]),
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "curvi" } },
      instructions: expect.any(String),
    });
    const bearer = await token();
    const listed = await send(rpc("tools/list", {}, { bearer }));
    expect(listed.body.result?.resultType).toBe("complete");
    const called = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer }));
    expect(called.response.status).toBe(200);
    expect(called.body.result).toMatchObject({ resultType: "complete", isError: false });
    // A mismatched mirror header is refused (M3), so the headers are read.
    const mismatched = rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer });
    mismatched.headers.set("mcp-name", "get_pack");
    expect((await send(mismatched)).response.status).toBe(400);
  });

  it.each(["2025-11-25", "2025-06-18", "2025-03-26"] as const)("serves a %s client through initialize, statelessly", async (protocol) => {
    const bearer = await token();
    const init = await send(
      rpc("initialize", { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "interop-client", version: "1.0.0" } }, { bearer, protocol }),
    );
    expect(init.response.status).toBe(200);
    expect(init.response.headers.get("mcp-session-id")).toBeNull();
    expect(init.body.result).toMatchObject({
      protocolVersion: protocol,
      capabilities: { tools: {} },
      serverInfo: { name: "curvi", version: expect.any(String) },
      instructions: expect.any(String),
    });
    const initialized = await send(rpc("notifications/initialized", {}, { bearer, protocol, notification: true }));
    expect(initialized.response.status).toBe(202);
    const listed = await send(rpc("tools/list", {}, { bearer, protocol }));
    expect(listed.body.result?.tools).toHaveLength(6);
    expect(listed.body.result?.resultType).toBeUndefined();
    const called = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer, protocol }));
    expect(called.body.result).toMatchObject({ isError: false, structuredContent: expect.any(Object) });
  });

  it.each([
    ["on", true],
    ["off", false],
  ] as const)("still serves an API key client with the sign in %s", async (_label, oauthEnabled) => {
    for (const protocol of ["modern", "2025-06-18"] as const) {
      const listed = await send(rpc("tools/list", {}, { bearer: fixture.key, protocol }), { oauthEnabled });
      expect(listed.response.status).toBe(200);
      expect((listed.body.result?.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        "list_channels",
        "estimate_pack",
        "create_pack",
        "get_pack",
        "check_main_image",
      ]);
      const called = await send(rpc("tools/call", { name: "list_channels", arguments: {} }, { bearer: fixture.key, protocol }), { oauthEnabled });
      expect(called.body.result).toMatchObject({ isError: false });
    }
  });

  it("answers ChatGPT's browser preflight and refuses another site (M3, P19-20)", async () => {
    const preflight = await preflightMcp(new Request(RESOURCE, { method: "OPTIONS", headers: { origin: "https://chatgpt.com", "access-control-request-method": "POST" } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
    const refused = await POST(rpc("server/discover", {}, { origin: "https://evil.example" }));
    expect(refused.status).toBe(403);
  });
});

// The plugin package agrees with the server

const PLUGIN_DIR = new URL("../../../../../../packages/openai-plugin/package/", import.meta.url);

describe("the plugin ZIP's contents agree with the server (P19-25)", () => {
  const plugin = JSON.parse(readFileSync(new URL("plugin.json", PLUGIN_DIR), "utf8")) as Record<string, any>;
  const mcp = JSON.parse(readFileSync(new URL("mcp.json", PLUGIN_DIR), "utf8")) as Record<string, any>;
  const listing = plugin.extensions["com.openai"].interface as Record<string, string>;

  it("points at this server's resource, the URL the metadata names", () => {
    stubSiteEnv();
    expect(Object.values(mcp.mcpServers as Record<string, { url: string }>).map((server) => server.url)).toEqual([mcpResourceUrl()]);
  });

  it("names only tools the server offers in its review test cases", async () => {
    const { body } = await send(rpc("tools/list", {}, { bearer: await token() }));
    const offered = [...toolsByName(body).keys()];
    for (const testCase of plugin.extensions["com.openai"].review.test_cases.positive as Array<{ tools_triggered: string }>) {
      for (const name of testCase.tools_triggered.split(",").map((tool) => tool.trim())) {
        expect(offered, name).toContain(name);
      }
    }
  });

  it("lists the same policy and terms pages as the resource metadata, on pages the site has", async () => {
    stubSiteEnv();
    const document = (await (await getPathMetadata()).json()) as Record<string, string>;
    expect(document.resource_policy_uri).toBe(listing.privacyPolicyURL);
    expect(document.resource_tos_uri).toBe(listing.termsOfServiceURL);
    const pages: Record<string, string> = { "/": "page.tsx", "/support": "support/page.tsx", "/privacy": "privacy/page.tsx", "/terms": "terms/page.tsx" };
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      const path = new URL(listing[key]!).pathname;
      expect(pages[path], key).toBeDefined();
      expect(existsSync(new URL(`../../(marketing)/${pages[path]}`, import.meta.url)), key).toBe(true);
    }
  });
});
