import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_URL } from "./limits";

// P19-28: pin the registry artifact to its verified remote-server contract
// and to the plugin users install. No registry request or publication runs
// in the build or tests. Official docs checked 2026-10-02:
// https://modelcontextprotocol.io/registry/remote-servers
// https://modelcontextprotocol.io/registry/authentication
const server = JSON.parse(readFileSync(new URL("../registry/server.json", import.meta.url), "utf8"));
const plugin = JSON.parse(readFileSync(new URL("../package/plugin.json", import.meta.url), "utf8"));
const mcp = JSON.parse(readFileSync(new URL("../package/mcp.json", import.meta.url), "utf8"));

describe("the unpublished MCP Registry manifest", () => {
  it("uses the verified schema and the namespace proved by curvi.ai", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe("ai.curvi/curvi");
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.name.length).toBeGreaterThanOrEqual(3);
    expect(server.name.length).toBeLessThanOrEqual(200);
    const namespace = server.name.split("/")[0].split(".").reverse().join(".");
    expect(new URL(server.websiteUrl).hostname).toBe(namespace);
    expect(server.websiteUrl).toBe(plugin.homepage);
  });

  it("keeps the public listing within the Registry limits and in step with the plugin version", () => {
    expect(server.title).toBe("Curvi");
    for (const text of [server.title, server.description]) {
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThanOrEqual(1);
      expect(text.length).toBeLessThanOrEqual(100);
    }
    expect(server.version).toBe(plugin.version);
    expect(server.version.length).toBeGreaterThan(0);
    expect(server.version.length).toBeLessThanOrEqual(255);
    expect(server.version).not.toMatch(/[<>=*^~|\s]/);
  });

  it("advertises only the same public remote endpoint as the plugin, without credentials or local packages", () => {
    expect(server.remotes).toEqual([{ type: "streamable-http", url: MCP_URL }]);
    expect(server.remotes).toEqual(Object.values(mcp.mcpServers));
    const endpoint = new URL(server.remotes[0].url);
    expect(endpoint.protocol).toBe("https:");
    expect(endpoint.username).toBe("");
    expect(endpoint.password).toBe("");
    expect(endpoint.search).toBe("");
    expect(server.packages).toBeUndefined();
    expect(Object.keys(server).sort()).toEqual([
      "$schema", "description", "name", "remotes", "title", "version", "websiteUrl",
    ]);
  });
});
