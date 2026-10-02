import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, dynamic } from "./.well-known/mcp-registry-auth/route";

const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");
const PROOF = `v=MCPv1; k=ed25519; p=${PUBLIC_KEY}`;

describe("GET /.well-known/mcp-registry-auth", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stays unavailable until a public proof is configured", async () => {
    for (const value of ["", "   "]) {
      vi.stubEnv("MCP_REGISTRY_AUTH", value);
      const response = GET();
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  it("serves the raw public key proof as plain text without reading an OAuth token or private key", async () => {
    vi.stubEnv("MCP_REGISTRY_AUTH", ` ${PROOF}\n`);
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PROOF);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not expose malformed values or private-key encodings", async () => {
    for (const value of [
      "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----",
      "a".repeat(64),
      `v=MCPv1; k=rsa; p=${PUBLIC_KEY}`,
      `v=MCPv1; k=ed25519; p=${Buffer.alloc(31, 7).toString("base64")}`,
      `v=MCPv1; k=ed25519; p=${Buffer.alloc(33, 7).toString("base64")}`,
      `v=MCPv1; k=ed25519; p=${"A".repeat(42)}B=`,
      `${PROOF}\nextra data`,
    ]) {
      vi.stubEnv("MCP_REGISTRY_AUTH", value);
      const response = GET();
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  it("reads the proof on each request so removal and rotation take effect without rebuilding", async () => {
    expect(dynamic).toBe("force-dynamic");
    vi.stubEnv("MCP_REGISTRY_AUTH", PROOF);
    expect(await GET().text()).toBe(PROOF);
    const rotated = `v=MCPv1; k=ed25519; p=${Buffer.alloc(32, 9).toString("base64")}`;
    vi.stubEnv("MCP_REGISTRY_AUTH", rotated);
    expect(await GET().text()).toBe(rotated);
    vi.stubEnv("MCP_REGISTRY_AUTH", "");
    expect(GET().status).toBe(404);
  });
});
