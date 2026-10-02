import { siteUrl } from "@/lib/env";

/**
 * Setup facts the help center, llms.txt and the API keys page share
 * (PHASE_19 P19-24). The MCP URL never changes once the plugin is listed
 * (PHASE_19 decision 9).
 */

/** The hosted MCP server on this site, for example https://curvi.ai/api/mcp. */
export function mcpServerUrl(): string {
  return new URL("/api/mcp", siteUrl()).toString();
}

/** The environment variable the Codex snippet reads the API key from. */
export const CODEX_KEY_ENV = "CURVI_API_KEY";

/**
 * Codex config.toml for the hosted MCP server with an API key
 * (docs/verification.md, PHASE_19 O16: `url` and `bearer_token_env_var`
 * under `[mcp_servers.<name>]`).
 */
export function codexConfigToml(): string {
  return ["[mcp_servers.curvi]", `url = "${mcpServerUrl()}"`, `bearer_token_env_var = "${CODEX_KEY_ENV}"`].join("\n");
}
