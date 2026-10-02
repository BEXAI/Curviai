import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOKEN_PATH_PREFIXES, redactTokenPath, tokenPathPrefix } from "./token-paths";

// docs/phases/PHASE_20.md P20-13: one list of token paths for the Sentry
// scrubber and the request logger.

const APP_DIR = fileURLToPath(new URL("../app", import.meta.url));

/** The URL path before every [token] route folder under app/, with route
 * groups such as (marketing) left out: "/api/mcp/files/". */
function tokenRoutePrefixes(dir: string, segments: string[] = []): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const isGroup = /^\(.*\)$/.test(entry.name);
    if (entry.name === "[token]") {
      found.push(`/${segments.join("/")}${segments.length > 0 ? "/" : ""}`);
    }
    found.push(...tokenRoutePrefixes(join(dir, entry.name), isGroup ? segments : [...segments, entry.name]));
  }
  return found;
}

describe("TOKEN_PATH_PREFIXES", () => {
  it("covers every [token] route folder", () => {
    const uncovered = tokenRoutePrefixes(APP_DIR).filter((prefix) => tokenPathPrefix(`${prefix}x`) === null);
    expect(uncovered).toEqual([]);
  });

  it("finds [token] folders inside route groups and nested routes", () => {
    // The walk itself, on route shapes main does not have yet.
    const root = mkdtempSync(join(tmpdir(), "token-paths-"));
    try {
      mkdirSync(join(root, "(marketing)", "feedback", "[token]"), { recursive: true });
      mkdirSync(join(root, "api", "mcp", "files", "[token]"), { recursive: true });
      mkdirSync(join(root, "api", "jobs", "[id]"), { recursive: true });
      expect(tokenRoutePrefixes(root).sort()).toEqual(["/api/mcp/files/", "/feedback/"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists each prefix once, each starting with a slash", () => {
    expect(new Set(TOKEN_PATH_PREFIXES).size).toBe(TOKEN_PATH_PREFIXES.length);
    for (const prefix of TOKEN_PATH_PREFIXES) {
      expect(prefix.startsWith("/")).toBe(true);
    }
  });
});

describe("redactTokenPath", () => {
  it.each([
    ["/api/mcp/files/tok_123", "/api/mcp/files/[token]"],
    ["/api/mcp/preview/tok_123?w=200", "/api/mcp/preview/[token]"],
    ["/api/claims/0123abcd/takedown", "/api/claims/[token]/takedown"],
    ["/s/abcd2345ef?claim=0123456789abcdef", "/s/[token]"],
    ["/s/abcd2345ef/image/main", "/s/[token]/image/main"],
    ["/feedback/tok#top", "/feedback/[token]"],
    ["/email/unsubscribe?t=secret", "/email/unsubscribe"],
    ["/api/email/unsubscribe?t=secret", "/api/email/unsubscribe"],
    ["/invite/abc", "/invite/[token]"],
    ["https://curvi.ai/api/preview/0b7a4d1e/full?x=1", "https://curvi.ai/api/preview/[token]/full"],
    ["https://curvi.ai/email/unsubscribe?t=secret", "https://curvi.ai/email/unsubscribe"],
  ])("%s becomes %s", (input, output) => {
    expect(redactTokenPath(input)).toBe(output);
  });

  it.each(["/app/jobs/123?tab=files", "/api/preview", "/email/unsubscribed", "/sitemap.xml", "https://curvi.ai/pricing?plan=pro", ""])(
    "leaves %s unchanged",
    (input) => {
      expect(redactTokenPath(input)).toBe(input);
    },
  );
});
