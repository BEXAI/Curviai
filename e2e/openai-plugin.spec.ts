import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// PHASE_19 P19-25 and P19-26: what the plugin ZIP points at, served by this
// build. The listing URLs and the review test cases' photo come from
// packages/openai-plugin/package/plugin.json, so a page or file the ZIP names
// cannot go missing unnoticed. The suite runs the demo build, where
// MCP_OAUTH_ENABLED is not set: the dark state production starts in.

interface PluginManifest {
  extensions: {
    "com.openai": {
      interface: Record<string, unknown>;
      review: { test_cases: { positive: Array<{ file_attachment_urls?: string[] }> } };
    };
  };
}

const plugin = JSON.parse(
  readFileSync(join(__dirname, "..", "packages", "openai-plugin", "package", "plugin.json"), "utf8"),
) as PluginManifest;
const listing = plugin.extensions["com.openai"].interface;

test("every listing URL in the plugin is a page this site serves", async ({ request }) => {
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    const path = new URL(String(listing[key])).pathname;
    const response = await request.get(path);
    expect(response.status(), `${key} ${path}`).toBe(200);
    expect(response.headers()["content-type"], key).toMatch(/^text\/html/);
  }
});

test("the review test cases' photo is served as a JPEG", async ({ request }) => {
  const paths = new Set(
    plugin.extensions["com.openai"].review.test_cases.positive.flatMap((testCase) =>
      (testCase.file_attachment_urls ?? []).map((url) => new URL(url).pathname),
    ),
  );
  expect(paths.size).toBeGreaterThan(0);
  for (const path of paths) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toMatch(/^image\/jpeg/);
    const body = await response.body();
    expect([body[0], body[1]], path).toEqual([0xff, 0xd8]);
  }
});

test("the MCP endpoint answers ChatGPT's browser preflight and refuses another site", async ({ request }) => {
  const preflight = await request.fetch("/api/mcp", {
    method: "OPTIONS",
    headers: { origin: "https://chatgpt.com", "access-control-request-method": "POST" },
  });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()["access-control-allow-origin"]).toBe("https://chatgpt.com");
  expect(preflight.headers()["access-control-allow-headers"]).toMatch(/Authorization/);

  const refused = await request.post("/api/mcp", {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "ping" },
  });
  expect(refused.status()).toBe(403);
});

test("with the sign in off, the endpoint answers discovery as before and advertises no metadata", async ({ request }) => {
  const version = "2026-07-28";
  const discover = await request.post("/api/mcp", {
    headers: {
      origin: "https://chatgpt.com",
      "content-type": "application/json",
      "mcp-protocol-version": version,
      "mcp-method": "server/discover",
    },
    data: { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { "io.modelcontextprotocol/protocolVersion": version } } },
  });
  expect(discover.status()).toBe(200);
  expect(discover.headers()["access-control-allow-origin"]).toBe("https://chatgpt.com");
  const body = (await discover.json()) as { result: { supportedVersions: string[]; capabilities: Record<string, unknown> } };
  expect(body.result.supportedVersions).toContain(version);
  expect(body.result.capabilities).toHaveProperty("tools");

  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});
