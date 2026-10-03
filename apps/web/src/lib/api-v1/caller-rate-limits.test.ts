import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiCaller } from "@/lib/api-keys/auth";
import { DEMO_OWNER_ID, setApiKeyBackendForTests } from "@/lib/api-keys/backend";
import { overLimit, toolOverLimit } from "@/lib/api-v1/actions";
import { PROTOCOL_VERSION_META, handleMcpPost } from "@/lib/api-v1/mcp";
import { demoApiFixture } from "@/lib/api-v1/test-fixtures";
import {
  MCP_TOOL_RATE_POLICIES,
  MemoryRateLimitStore,
  RATE_LIMIT_POLICIES,
  checkRateLimit,
  rateLimitRule,
  setRateLimitStoreForTests,
} from "@/lib/rate-limit";
import { createFakeServices } from "@/lib/testing/fake-services";

// Rate limits by caller (docs/phases/PHASE_19.md, P19-21): OAuth callers
// skip the IP rule, since every ChatGPT call arrives from OpenAI's shared
// egress addresses, and are counted per user and per workspace; API key
// callers keep the IP and user rules; MCP reads have their own policy.

const IP = "203.0.113.9";
const WS_A = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const WS_B = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

function caller(kind: "oauth" | "api_key", user: string, workspaceId = WS_A): ApiCaller {
  return {
    kind,
    keyId: kind === "api_key" ? "00000000-0000-4000-8000-0000000003a1" : null,
    prefix: kind === "api_key" ? "cv_live_000000000000" : null,
    connectionId: kind === "oauth" ? "00000000-0000-4000-8000-00000000c0c0" : null,
    ipExempt: kind === "oauth",
    scopes: ["packs:write", "packs:read", "checks"],
    principal: { workspaceId, workspaceName: "W", plan: "free", role: "owner", userId: user },
    services: createFakeServices("owner"),
    rateSubject: `user:${user}`,
  };
}

const headers = () => new Headers({ "x-forwarded-for": IP });

async function fill(policy: Parameters<typeof checkRateLimit>[0], scope: "ip" | "user" | "workspace", subject: string) {
  const { limit } = rateLimitRule(policy, scope);
  for (let i = 0; i < limit; i += 1) {
    await checkRateLimit(policy, scope, subject);
  }
}

beforeEach(() => {
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
  setApiKeyBackendForTests(null);
});

describe("overLimit by caller", () => {
  it("never puts OAuth callers in an IP bucket, while API key callers keep the IP rule", async () => {
    await fill("jobs.create", "ip", `ip:${IP}`);
    expect((await overLimit("jobs.create", headers(), caller("api_key", "k1")))?.status).toBe(429);
    expect(await overLimit("jobs.create", headers(), caller("oauth", "o1"))).toBeNull();
    expect(await overLimit("jobs.create", headers(), caller("oauth", "o2", WS_B))).toBeNull();
  });

  it("counts an OAuth caller per user, so one user's calls never block another's", async () => {
    const { limit } = RATE_LIMIT_POLICIES["jobs.create"].user;
    for (let i = 0; i < limit; i += 1) {
      expect(await overLimit("jobs.create", headers(), caller("oauth", "o1"))).toBeNull();
    }
    const refused = await overLimit("jobs.create", headers(), caller("oauth", "o1"));
    expect(refused).toMatchObject({ status: 429, body: { reason: "rate_limited" } });
    expect(refused?.headers?.["Retry-After"]).toBeTruthy();
    expect(await overLimit("jobs.create", headers(), caller("oauth", "o2", WS_B))).toBeNull();
  });

  it("counts OAuth callers per workspace too, with the IP rule's numbers", async () => {
    expect(rateLimitRule("jobs.create", "workspace")).toEqual(RATE_LIMIT_POLICIES["jobs.create"].ip);
    await fill("jobs.create", "workspace", `ws:${WS_A}`);
    expect((await overLimit("jobs.create", headers(), caller("oauth", "o3")))?.status).toBe(429);
    expect(await overLimit("jobs.create", headers(), caller("oauth", "o4", WS_B))).toBeNull();
    // An API key caller is never counted per workspace.
    expect(await overLimit("jobs.create", new Headers(), caller("api_key", "k2"))).toBeNull();
  });

  it("keeps API key callers on today's rules: the IP first, then the user", async () => {
    await fill("jobs.create", "user", "user:k3");
    expect((await overLimit("jobs.create", new Headers(), caller("api_key", "k3")))?.status).toBe(429);
    expect(await overLimit("jobs.create", new Headers(), caller("api_key", "k4"))).toBeNull();
  });
});

describe("toolOverLimit", () => {
  it("maps the reads to mcp.read and estimate_pack to imports.photo, and leaves the rest to their actions", () => {
    expect(MCP_TOOL_RATE_POLICIES).toEqual({
      get_pack: "mcp.read",
      show_pack: "mcp.read",
      list_channels: "mcp.read",
      get_profile: "mcp.read",
      estimate_pack: "imports.photo",
    });
  });

  it("lets a user poll get_pack within the limit, then refuses", async () => {
    const polling = caller("oauth", "poller");
    const { limit } = RATE_LIMIT_POLICIES["mcp.read"].user;
    for (let i = 0; i < limit; i += 1) {
      expect(await toolOverLimit("get_pack", { caller: polling, headers: headers() })).toBeNull();
    }
    expect((await toolOverLimit("get_pack", { caller: polling, headers: headers() }))?.status).toBe(429);
    expect((await toolOverLimit("show_pack", { caller: polling, headers: headers() }))?.status).toBe(429);
    expect(await toolOverLimit("create_pack", { caller: polling, headers: headers() })).toBeNull();
    expect(await toolOverLimit("check_main_image", { caller: polling, headers: headers() })).toBeNull();
    expect(await toolOverLimit("get_pack", { caller: caller("oauth", "other"), headers: headers() })).toBeNull();
  });

  it("refuses a read through tools/call once the caller is over the limit", async () => {
    const fixture = demoApiFixture();
    setApiKeyBackendForTests(fixture.backend);
    // The demo key acts as the demo workspace's owner.
    await fill("mcp.read", "user", `user:${DEMO_OWNER_ID}`);
    const version = "2026-07-28";
    const response = await handleMcpPost(
      new Request("https://curvi.ai/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.key}`,
          "content-type": "application/json",
          "mcp-protocol-version": version,
          "mcp-method": "tools/call",
          "mcp-name": "list_channels",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_channels", arguments: {}, _meta: { [PROTOCOL_VERSION_META]: version } },
        }),
      }),
    );
    const body = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/^You are going a bit fast/);
  });
});
