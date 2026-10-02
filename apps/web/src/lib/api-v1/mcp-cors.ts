/**
 * Origin and CORS for /api/mcp (docs/phases/PHASE_19.md, P19-20).
 *
 * Streamable HTTP says servers "MUST validate the Origin header" and answer
 * a present, invalid one with 403, without defining a valid origin
 * (docs/verification.md, "PHASE_19", M3), so the server keeps an allowlist:
 * no Origin at all (servers, curl, ChatGPT's backend), this site (its
 * configured origin or the host the request was addressed to, as
 * lib/http/same-origin.ts), and the two OpenAI origins a browser based MCP
 * client of ChatGPT can send. The endpoint uses no cookies, so the CSRF
 * concern behind same-origin.ts does not apply to those two; anything else
 * stays a 403 (L1 found both refused before this).
 *
 * CORS (MDN, docs/verification.md): a preflight from an allowed origin gets
 * the methods and the request headers the transport uses (Authorization,
 * Content-Type and the three mirrored MCP headers), and every answer to an
 * allowed origin echoes it with Vary: Origin and exposes WWW-Authenticate,
 * so a browser client can read the sign in challenge. No credentials are
 * allowed: the endpoint never reads cookies.
 */

import { isSameOrigin } from "@/lib/http/same-origin";

/** Cross site origins allowed to call /api/mcp from a browser. */
export const MCP_CORS_ORIGINS: readonly string[] = ["https://chatgpt.com", "https://platform.openai.com"];

export const MCP_CORS_ALLOW_METHODS = "POST, GET, DELETE, OPTIONS";
export const MCP_CORS_ALLOW_HEADERS = "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name";
export const MCP_CORS_EXPOSE_HEADERS = "WWW-Authenticate";
/** Seconds a browser may cache the preflight answer. */
export const MCP_CORS_MAX_AGE = "600";

/** True when the request carries no Origin, this site's origin, or one of
 * MCP_CORS_ORIGINS (compared exactly, as browsers serialize origins). */
export function isAllowedMcpOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || MCP_CORS_ORIGINS.includes(origin) || isSameOrigin(request);
}

/** The CORS headers for an answer to this request: the echoed origin when
 * it is allowed, nothing when there is no Origin or it is refused. */
export function mcpCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origin === null || !isAllowedMcpOrigin(request)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": MCP_CORS_EXPOSE_HEADERS,
    Vary: "Origin",
  };
}

/** Adds the CORS headers to an answer (the body and status are kept). */
export function withMcpCors(request: Request, response: Response): Response {
  const headers = mcpCorsHeaders(request);
  for (const [name, value] of Object.entries(headers)) {
    if (name === "Vary") {
      const vary = response.headers.get("vary");
      response.headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
    } else {
      response.headers.set(name, value);
    }
  }
  return response;
}

/** OPTIONS /api/mcp: the preflight answer, or 403 for a refused origin. */
export function mcpPreflight(request: Request): Response {
  if (!isAllowedMcpOrigin(request)) {
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { Allow: MCP_CORS_ALLOW_METHODS, "Cache-Control": "no-store" };
  if (origin !== null) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = MCP_CORS_ALLOW_METHODS;
    headers["Access-Control-Allow-Headers"] = MCP_CORS_ALLOW_HEADERS;
    headers["Access-Control-Max-Age"] = MCP_CORS_MAX_AGE;
    headers.Vary = "Origin";
  }
  return new Response(null, { status: 204, headers });
}
