import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateApiKey, type ApiAuthResult, type ApiCaller } from "@/lib/api-keys/auth";
import { setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { PackChat } from "@/lib/api-v1/chat-views";
import { PROTOCOL_VERSION_META, handleMcpPost } from "@/lib/api-v1/mcp";
import { LASTING_PACK_LINKS, SHORT_LIVED_PACK_LINKS, packLinksFor } from "@/lib/api-v1/mcp-tools";
import { demoApiFixture, mainImagePng, type DemoApiFixture } from "@/lib/api-v1/test-fixtures";
import { clearMcpLinkCacheForTests } from "@/lib/mcp-links";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { JobFileView } from "@/lib/services/types";

// Which links get_pack hands out (PHASE_19 P19-17, decision 7, "API keys
// keep working"): the lasting curvi.ai links need MCP_LINK_KEYS, and with
// MCP_OAUTH_ENABLED off an API key caller gets exactly the links it got
// before PHASE_19. A missing key must never take the download links away.

const VERSION = "2026-07-28";
const KEYS = "k1:0123456789abcdef0123456789abcdef0123456789";
const R2_LINK = "https://acct.r2.cloudflarestorage.com/signed?X-Amz-Expires=900";
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

interface ToolAnswer {
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
}

async function call(name: string, args: Record<string, unknown>, caller: ApiCaller | null = null): Promise<ToolAnswer> {
  const deps = caller ? { authenticate: async (): Promise<ApiAuthResult> => ({ ok: true, caller }) } : {};
  const body = (await (await handleMcpPost(rpc(name, args), deps)).json()) as { result?: ToolAnswer; error?: unknown };
  if (!body.result) {
    throw new Error(`no result: ${JSON.stringify(body)}`);
  }
  return body.result;
}

const STORED_FILES: JobFileView[] = [
  {
    id: "v_44444444-4444-4444-8444-444444444444",
    name: "amazon-main.jpg",
    channel: "amazon",
    specId: "amazon.main",
    kind: "image",
    bytes: 1000,
    url: null,
    downloadUrl: "https://r2.example/stored",
    shotId: null,
  },
  {
    id: "p_55555555-5555-4555-8555-555555555555",
    name: "amazon.zip",
    channel: "amazon",
    specId: null,
    kind: "zip",
    bytes: 1000,
    url: null,
    downloadUrl: "https://r2.example/stored-zip",
  },
];

/** A finished pack whose files are stored, as on the database services. */
async function storedPack(): Promise<string> {
  const png = (await mainImagePng(1600, 0.8)).toString("base64");
  const created = await call("create_pack", { channels: ["amazon.main"], photos: [{ data: png }] });
  expect(created.isError, created.content[0]?.text).toBe(false);
  const packId = String(created.structuredContent!.pack_id);
  vi.spyOn(fixture.service, "listJobFiles").mockResolvedValue({ jobId: packId, status: "done", files: STORED_FILES });
  vi.spyOn(fixture.service, "getJobFileDownload").mockImplementation(async (_w, _j, fileId) => ({
    url: `${R2_LINK}&f=${fileId.slice(0, 1)}`,
    filename: "file",
  }));
  return packId;
}

async function packFiles(packId: string, caller: ApiCaller | null = null): Promise<PackChat> {
  const got = await call("get_pack", { pack_id: packId, include_files: true }, caller);
  expect(got.isError, got.content[0]?.text).toBe(false);
  return PackChat.parse(got.structuredContent);
}

beforeEach(async () => {
  fixture = demoApiFixture();
  setApiKeyBackendForTests(fixture.backend);
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  clearMcpLinkCacheForTests();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  vi.stubEnv("MCP_OAUTH_ENABLED", "");
  vi.stubEnv("MCP_LINK_KEYS", "");
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
  vi.unstubAllEnvs();
});

describe("get_pack links", () => {
  it("an API key caller keeps its download links when MCP_LINK_KEYS is unset", async () => {
    const packId = await storedPack();
    const view = await packFiles(packId);
    expect(view.images!.map((image) => image.download_url)).toEqual([`${R2_LINK}&f=v`, `${R2_LINK}&f=p`]);
    expect(view.images!.every((image) => image.preview_url === null)).toBe(true);
    // 15 minutes is not a whole number of hours, so only the message says it.
    expect(view).not.toHaveProperty("links_valid_hours");
  });

  it("with the kill switch off, an API key caller gets the links it got before PHASE_19 even with keys set", async () => {
    vi.stubEnv("MCP_LINK_KEYS", KEYS);
    const packId = await storedPack();
    const view = await packFiles(packId);
    expect(view.images!.map((image) => image.download_url)).toEqual([`${R2_LINK}&f=v`, `${R2_LINK}&f=p`]);
  });

  it("with the switch on and keys set, an API key caller gets the lasting curvi.ai links", async () => {
    vi.stubEnv("MCP_LINK_KEYS", KEYS);
    vi.stubEnv("MCP_OAUTH_ENABLED", "1");
    const packId = await storedPack();
    const view = await packFiles(packId);
    expect(view.images![0]!.preview_url).toMatch(/^https:\/\/curvi\.ai\/api\/mcp\/preview\//);
    expect(view.images![0]!.download_url).toMatch(/^https:\/\/curvi\.ai\/api\/mcp\/files\//);
    expect(view.images![1]!.download_url).toMatch(/^https:\/\/curvi\.ai\/api\/mcp\/files\//);
    expect(view.links_valid_hours).toBe(24);
  });

  it("an OAuth caller falls back to the short lived links rather than none when the keys are unset", async () => {
    const packId = await storedPack();
    const oauth: ApiCaller = { ...keyCaller, kind: "oauth", keyId: null, prefix: null, connectionId: "11111111-1111-4111-8111-111111111111", ipExempt: true };
    const view = await packFiles(packId, oauth);
    expect(view.images!.map((image) => image.download_url)).toEqual([`${R2_LINK}&f=v`, `${R2_LINK}&f=p`]);
    vi.stubEnv("MCP_LINK_KEYS", KEYS);
    const lasting = await packFiles(packId, oauth);
    expect(lasting.images![0]!.download_url).toMatch(/^https:\/\/curvi\.ai\/api\/mcp\/files\//);
  });

  it("packLinksFor picks by keys, caller kind and the switch", () => {
    const keys = [{ kid: "k1", secret: "0123456789abcdef0123456789abcdef" }];
    expect(packLinksFor({ kind: "api_key" }, { keys: null, oauthEnabled: true })).toBe(SHORT_LIVED_PACK_LINKS);
    expect(packLinksFor({ kind: "oauth" }, { keys: null, oauthEnabled: true })).toBe(SHORT_LIVED_PACK_LINKS);
    expect(packLinksFor({ kind: "api_key" }, { keys, oauthEnabled: false })).toBe(SHORT_LIVED_PACK_LINKS);
    expect(packLinksFor({ kind: "api_key" }, { keys, oauthEnabled: true })).toBe(LASTING_PACK_LINKS);
    expect(packLinksFor({ kind: "oauth" }, { keys, oauthEnabled: false })).toBe(LASTING_PACK_LINKS);
  });
});
