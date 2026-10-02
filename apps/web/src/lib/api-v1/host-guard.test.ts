import { afterEach, describe, expect, it, vi } from "vitest";
import { authorize } from "./http";
import { handleMcpPost } from "./mcp";

afterEach(() => vi.unstubAllEnvs());

describe("the API and MCP production host boundary", () => {
  it("rejects the direct service host before checking credentials or reading the body", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    vi.stubEnv("MCP_OAUTH_ENABLED", "1");
    for (const host of ["curvi.onrender.com", "other.example"]) {
      const request = new Request(`https://${host}/api/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_pack" } }),
      });
      expect((await handleMcpPost(request)).status).toBe(403);
      expect(request.bodyUsed).toBe(false);
      const api = await authorize(request, "packs:write");
      expect("response" in api && api.response.status).toBe(403);
      expect(request.bodyUsed).toBe(false);
    }
  });

  it("accepts public discovery on the configured host", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    vi.stubEnv("MCP_OAUTH_ENABLED", "1");
    const response = await handleMcpPost(new Request("https://curvi.ai/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
  });
});
