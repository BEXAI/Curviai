import { afterEach, describe, expect, it } from "vitest";
import { MCP_LOG_MAX_CHARS, logMcpEvent, mcpLogCounts, redactLogText, setMcpLogSinkForTests, type McpLogEntry } from "./mcp-log";

// The redacting MCP logger (PHASE_19 P19-02): no token, signed link, tool
// result or client _meta hint can reach the sink.

const JWT = "eyJhbGciOiJFUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJ1In0.c2lnbmF0dXJl";
const KEY = `cv_live_000000000000_${"A".repeat(43)}`;

afterEach(() => setMcpLogSinkForTests(null));

describe("redactLogText", () => {
  it("replaces bearer tokens, JWTs, API keys, URLs and signed link paths", () => {
    const text = redactLogText(
      `Bearer ${JWT} then ${JWT} and ${KEY} at https://curvi.ai/api/mcp/files/tok123?x=1 or /api/mcp/preview/tok456`,
    );
    expect(text).not.toContain(JWT);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("tok123");
    expect(text).not.toContain("tok456");
    expect(text).toContain("Bearer [redacted]");
    expect(text).toContain("[api_key]");
    expect(text).toContain("[url]");
    expect(text).toContain("/api/mcp/preview/[token]");
  });

  it("strips control characters and cuts long values", () => {
    expect(redactLogText("a\nb\u0000c")).toBe("a b c");
    expect(redactLogText("x".repeat(500)).length).toBe(MCP_LOG_MAX_CHARS + 3);
  });
});

describe("logMcpEvent", () => {
  it("keeps only the named fields, redacted, and counts by reason", () => {
    const entries: McpLogEntry[] = [];
    setMcpLogSinkForTests((entry) => entries.push(entry));
    const fields = {
      reason: "invalid_token",
      method: "tools/call",
      tool: "create_pack",
      status: 401,
      auth: "oauth",
      // Never logged, even when a caller passes them.
      token: JWT,
      arguments: { images: [{ download_url: "https://files.example/a" }] },
      _meta: { "openai/subject": "anon-1", "openai/userLocation": { city: "Paris" } },
    } as unknown as Parameters<typeof logMcpEvent>[1];
    logMcpEvent("unauthorized", fields, { error: new Error(`token ${JWT} refused at https://curvi.ai/x`) });
    logMcpEvent("unauthorized", { reason: "invalid_token" });
    logMcpEvent("tool_error", { tool: "get_pack" }, { level: "error" });

    expect(entries[0]?.fields).toEqual({
      reason: "invalid_token",
      method: "tools/call",
      tool: "create_pack",
      status: 401,
      auth: "oauth",
    });
    const serialized = JSON.stringify(entries);
    for (const secret of [JWT, "anon-1", "Paris", "files.example", "curvi.ai/x"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(entries[0]?.error?.message).toContain("[jwt]");
    expect(entries[2]?.level).toBe("error");
    expect(mcpLogCounts()).toEqual({ "unauthorized:invalid_token": 2, tool_error: 1 });
  });

  it("never throws when the sink fails", () => {
    setMcpLogSinkForTests(() => {
      throw new Error("sink down");
    });
    expect(() => logMcpEvent("challenge", { reason: "no_connection" })).not.toThrow();
  });
});
