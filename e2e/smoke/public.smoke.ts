import { expect, test } from "@playwright/test";
import { smokeSettings } from "./settings";

const settings = smokeSettings(process.env);
test.skip(settings.mode === "synthetic", "The separately gated synthetic run only creates its one pack.");

test("health identifies a ready deployment and the expected commit", async ({ request }) => {
  const response = await request.get("/api/health", { timeout: 90_000 });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.json() as { ok: boolean; status: string; mode: string; commit: string | null };
  expect(body.ok).toBe(true);
  expect(body.status).toBe("ok");
  if (settings.mode === "demo") expect(body.mode).toBe("demo");
  else expect(body.commit).toMatch(/^[a-f0-9]{7,40}$/);
  if (process.env.SMOKE_EXPECTED_SHA) expect(body.commit).toBe(process.env.SMOKE_EXPECTED_SHA.slice(0, 7));
});

test("marketing, status and the staging environment marker render", async ({ page, request }) => {
  for (const path of ["/", "/pricing", "/help", "/privacy", "/status"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("h1")).toBeVisible();
    if (settings.mode === "staging") {
      await expect(page.getByTestId("environment-banner")).toContainText("staging");
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    }
  }
  const status = await request.get("/api/status");
  expect(status.status()).toBe(200);
  expect(["open", "waitlist"]).toContain(((await status.json()) as { acquisition: string }).acquisition);
});

test("MCP initializes, or correctly challenges protected initialization", async ({ request }) => {
  const response = await request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: "smoke-init", method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "curvi-smoke", version: "1.0.0" },
    } },
  });
  if (response.status() === 401) {
    // Public production smoke never signs in. An OAuth-enabled server must
    // challenge initialize; public discovery still proves its transport.
    expect(response.headers()["www-authenticate"]).toContain("resource_metadata=");
    const discovery = await request.post("/api/mcp", {
      headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
      data: { jsonrpc: "2.0", id: "smoke-discover", method: "server/discover", params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      } },
    });
    expect(discovery.status()).toBe(200);
    expect(await discovery.json()).toHaveProperty("result.capabilities.tools");
  } else {
    expect(response.status()).toBe(200);
    expect(await response.json()).toHaveProperty("result.serverInfo.name", "curvi");
  }
});
