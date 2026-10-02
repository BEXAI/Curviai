import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as metadataRoot, OPTIONS as metadataRootPreflight } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as metadataPathForm } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { challengeHeader, protectedResourceMetadata, toolChallengeResult, WWW_AUTHENTICATE_META } from "./challenge";
import { mcpOAuthConfig, mcpOAuthEnabled, mcpResourceUrl, parseClientIds, resourceMetadataUrlFor } from "./config";
import { TEST_CONFIG } from "./test-tokens";

// Discovery documents and challenges for the MCP server's sign in
// (docs/phases/PHASE_19.md, "Metadata endpoints", P19-06; docs/
// verification.md, "PHASE_19", O1, O2 and M1).

afterEach(() => {
  vi.unstubAllEnvs();
});

function liveEnv(): void {
  vi.stubEnv("MCP_OAUTH_ENABLED", "1");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://tmwvjmvzjvpeagatjmud.supabase.co");
  vi.stubEnv("MCP_RESOURCE_URL", "");
  vi.stubEnv("SUPABASE_AUTH_ISSUER", "");
  vi.stubEnv("MCP_OAUTH_CLIENT_IDS", " a , ,b ");
}

describe("config", () => {
  it("defaults the resource and issuer from the site and Supabase URLs, byte for byte", () => {
    liveEnv();
    const config = mcpOAuthConfig();
    expect(config.resource).toBe("https://curvi.ai/api/mcp");
    expect(config.issuer).toBe("https://tmwvjmvzjvpeagatjmud.supabase.co/auth/v1");
    expect(config.jwksUrl).toBe("https://tmwvjmvzjvpeagatjmud.supabase.co/auth/v1/.well-known/jwks.json");
    expect(config.resourceMetadataUrl).toBe("https://curvi.ai/.well-known/oauth-protected-resource/api/mcp");
    expect(config.clientIds).toEqual(["a", "b"]);
    expect(config.requiredScopes).toEqual(["openid", "email"]);
  });

  it("takes MCP_RESOURCE_URL and SUPABASE_AUTH_ISSUER as given", () => {
    liveEnv();
    vi.stubEnv("MCP_RESOURCE_URL", "https://curvi.ai/api/mcp");
    vi.stubEnv("SUPABASE_AUTH_ISSUER", "https://auth.example/auth/v1");
    expect(mcpResourceUrl()).toBe("https://curvi.ai/api/mcp");
    expect(mcpOAuthConfig().issuer).toBe("https://auth.example/auth/v1");
  });

  it("is off unless MCP_OAUTH_ENABLED is exactly 1", () => {
    for (const value of ["", "0", "true", "yes", " 1"]) {
      vi.stubEnv("MCP_OAUTH_ENABLED", value);
      expect(mcpOAuthEnabled(), value).toBe(false);
    }
    vi.stubEnv("MCP_OAUTH_ENABLED", "1");
    expect(mcpOAuthEnabled()).toBe(true);
  });

  it("puts the well known prefix before the resource's path (RFC 9728)", () => {
    expect(resourceMetadataUrlFor("https://curvi.ai/api/mcp")).toBe("https://curvi.ai/.well-known/oauth-protected-resource/api/mcp");
    expect(resourceMetadataUrlFor("https://curvi.ai/")).toBe("https://curvi.ai/.well-known/oauth-protected-resource");
    expect(parseClientIds(undefined)).toEqual([]);
  });
});

describe("protected resource metadata", () => {
  it("holds exactly the plan's fields with the configured resource and issuer", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    expect(protectedResourceMetadata(TEST_CONFIG)).toEqual({
      resource: TEST_CONFIG.resource,
      authorization_servers: [TEST_CONFIG.issuer],
      scopes_supported: ["openid", "email"],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://curvi.ai/help#use-curvi-in-chatgpt",
      resource_policy_uri: "https://curvi.ai/privacy",
      resource_tos_uri: "https://curvi.ai/terms",
    });
  });

  it("is served at both paths, public and cacheable, with no offline_access", async () => {
    liveEnv();
    for (const route of [metadataRoot, metadataPathForm]) {
      const response = await route();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.resource).toBe("https://curvi.ai/api/mcp");
      expect(body.authorization_servers).toEqual(["https://tmwvjmvzjvpeagatjmud.supabase.co/auth/v1"]);
      expect(JSON.stringify(body)).not.toContain("offline_access");
    }
    const preflight = await metadataRootPreflight();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  it("answers 404 at both paths while MCP_OAUTH_ENABLED is off", async () => {
    liveEnv();
    vi.stubEnv("MCP_OAUTH_ENABLED", "0");
    expect((await metadataRoot()).status).toBe(404);
    expect((await metadataPathForm()).status).toBe(404);
  });
});

describe("challenges", () => {
  it("builds the 401 challenge, with the error only when a token failed", () => {
    expect(challengeHeader(TEST_CONFIG)).toBe(
      'Bearer resource_metadata="https://curvi.ai/.well-known/oauth-protected-resource/api/mcp", scope="openid email"',
    );
    expect(challengeHeader(TEST_CONFIG, { error: "invalid_token", description: "Connect your Curvi account to use this." })).toBe(
      'Bearer resource_metadata="https://curvi.ai/.well-known/oauth-protected-resource/api/mcp", scope="openid email", error="invalid_token", error_description="Connect your Curvi account to use this."',
    );
    expect(challengeHeader(TEST_CONFIG, { error: "insufficient_scope" })).toBe(
      'Bearer resource_metadata="https://curvi.ai/.well-known/oauth-protected-resource/api/mcp", scope="openid email", error="insufficient_scope"',
    );
  });

  it("keeps quotes, backslashes and non ASCII out of the quoted strings", () => {
    const header = challengeHeader(TEST_CONFIG, { error: "invalid_token", description: 'say "hi" \\ café\n' });
    expect(header).toContain(`error_description="say 'hi' ' caf  "`);
  });

  it("returns the tool level challenge in O1's documented shape", () => {
    expect(toolChallengeResult(TEST_CONFIG, "Connect Curvi again in ChatGPT and choose a workspace.")).toEqual({
      isError: true,
      content: [{ type: "text", text: "Connect Curvi again in ChatGPT and choose a workspace." }],
      _meta: {
        [WWW_AUTHENTICATE_META]: [
          'Bearer resource_metadata="https://curvi.ai/.well-known/oauth-protected-resource/api/mcp", error="invalid_token", error_description="Connect Curvi again in ChatGPT and choose a workspace."',
        ],
      },
    });
    expect(WWW_AUTHENTICATE_META).toBe("mcp/www_authenticate");
  });
});
