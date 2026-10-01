/**
 * The redacting MCP logger (PHASE_19 P19-02; P19-08 adds the events). OpenAI
 * asks for "logs and metrics for failed initialization and tool calls" while
 * making sure "logs do not contain access tokens or sensitive tool results"
 * (docs/verification.md, "PHASE_19: ChatGPT and Codex plugin", O7), and the
 * plan's security checklist adds signed links and the client's _meta hints.
 *
 * So an entry carries only the short fields McpLogFields names, every string
 * goes through redactLogText (bearer tokens, JWTs, Curvi API keys, URLs and
 * signed link paths are replaced, control characters removed, length cut),
 * and an error is reduced to its name and redacted message. Tool arguments,
 * tool results and hints such as openai/subject or openai/userLocation have
 * no field, so they cannot be logged through it. Counts per event and
 * reason are kept in memory for the metrics.
 *
 * Sentry is not installed yet (docs/verification.md, Sentry row), so the
 * default sink writes one JSON line to the console.
 */

export type McpLogEvent =
  | "transport_refused"
  | "initialize_failed"
  | "discover_failed"
  | "unauthorized"
  | "challenge"
  | "tool_error";

export type McpLogLevel = "info" | "warn" | "error";

export interface McpLogFields {
  /** A short machine reason, such as invalid_token or rate_limited. */
  reason?: string;
  /** The JSON-RPC method. */
  method?: string;
  /** The tool name of a tools/call. */
  tool?: string;
  /** The HTTP status answered. */
  status?: number;
  /** How the caller signed in. */
  auth?: "api_key" | "oauth" | "none";
  /** The protocol revision the request named. */
  protocol?: string;
}

export interface McpLogEntry {
  event: McpLogEvent;
  level: McpLogLevel;
  fields: Record<string, string | number>;
  error?: { name: string; message: string };
}

export type McpLogSink = (entry: McpLogEntry) => void;

const FIELD_NAMES = ["reason", "method", "tool", "status", "auth", "protocol"] as const;

/** Longest string an entry keeps. */
export const MCP_LOG_MAX_CHARS = 200;

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  // An Authorization header value, whatever the token.
  [/\bBearer\s+\S+/gi, "Bearer [redacted]"],
  // JWTs: three base64url parts, the first a JSON header.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[jwt]"],
  // Curvi API keys (cv_live_...).
  [/\bcv_[a-z]+_[A-Za-z0-9_-]+/g, "[api_key]"],
  // Any absolute URL: signed links, attachment download links, previews.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url]"],
  // Signed link paths without a host.
  [/\/api\/mcp\/(files|preview)\/[^\s"'<>?]+/g, "/api/mcp/$1/[token]"],
];

/** A string with every secret shaped part replaced, safe to log. */
export function redactLogText(text: string): string {
  let out = text.replace(/\p{Cc}+/gu, " ");
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > MCP_LOG_MAX_CHARS ? `${out.slice(0, MCP_LOG_MAX_CHARS)}...` : out;
}

const consoleSink: McpLogSink = (entry) => {
  const line = `[mcp] ${JSON.stringify(entry)}`;
  if (entry.level === "error") {
    console.error(line);
  } else if (entry.level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
};

let sink: McpLogSink = consoleSink;
const counts = new Map<string, number>();

/** Replaces the sink in tests; null restores the console. */
export function setMcpLogSinkForTests(next: McpLogSink | null): void {
  sink = next ?? consoleSink;
  counts.clear();
}

/** Entries logged since start (or the last setMcpLogSinkForTests), by
 * "event" or "event:reason". */
export function mcpLogCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

/** Logs one MCP event with only its allowed fields, redacted. Never throws. */
export function logMcpEvent(
  event: McpLogEvent,
  fields: McpLogFields = {},
  options: { level?: McpLogLevel; error?: unknown } = {},
): void {
  try {
    const kept: Record<string, string | number> = {};
    for (const name of FIELD_NAMES) {
      const value = (fields as Record<string, unknown>)[name];
      if (typeof value === "number" && Number.isFinite(value)) {
        kept[name] = value;
      } else if (typeof value === "string") {
        kept[name] = redactLogText(value);
      }
    }
    const entry: McpLogEntry = { event, level: options.level ?? "warn", fields: kept };
    if (options.error !== undefined) {
      const err = options.error;
      entry.error =
        err instanceof Error
          ? { name: redactLogText(err.name), message: redactLogText(err.message) }
          : { name: "unknown", message: "" };
    }
    const key = typeof kept.reason === "string" ? `${event}:${kept.reason}` : event;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    sink(entry);
  } catch {
    // Logging must never break a request.
  }
}
