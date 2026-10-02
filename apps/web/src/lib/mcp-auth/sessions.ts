/**
 * Is the Supabase session behind an OAuth token still there? (docs/phases/
 * PHASE_19.md, "Token verification" step 3.) Revoking a grant deletes its
 * sessions (Supabase Auth RevokeOAuthSessions, SB4), so checking the session
 * on every call stops a disconnected ChatGPT within the cache minute instead
 * of at token expiry (up to an hour).
 *
 * The check reads auth.sessions over the owner connection. Whether the owner
 * role may read it on hosted Supabase is unverified (P19-12), so when that
 * read is refused or the table is missing, the checker switches for the life
 * of the process to Supabase's own GET /auth/v1/user, which loads the
 * session from the token's session_id and answers 403 session_not_found when
 * it is gone (SB4 internal/api/auth.go). That call sends X-JWT-AUD with the
 * MCP resource, because GET /user refuses a token whose aud differs from the
 * request audience and the hook sets aud to the resource (docs/verification
 * .md, "PHASE_19", the X-JWT-AUD row).
 *
 * Answers are cached 60 seconds per session in a bounded map. The token is
 * sent only to Supabase's Auth API, never logged and never forwarded
 * anywhere else.
 */

import { sql, type Db } from "@curvi/db";

export type SessionState = "alive" | "ended" | "unknown";

export interface SessionChecker {
  /** "alive" while the session exists, "ended" once it is gone, "unknown"
   * when it could not be checked right now. */
  check(sessionId: string, userId: string, token: string): Promise<SessionState>;
}

export const SESSION_CACHE_TTL_MS = 60_000;
export const SESSION_CACHE_MAX_ENTRIES = 5_000;

/** Wraps a checker with a 60 second cache of definite answers ("unknown" is
 * never cached), bounded by evicting the oldest entries. */
export class CachedSessionChecker implements SessionChecker {
  private readonly entries = new Map<string, { state: SessionState; at: number }>();

  constructor(
    private readonly inner: SessionChecker,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SESSION_CACHE_TTL_MS,
    private readonly maxEntries: number = SESSION_CACHE_MAX_ENTRIES,
  ) {}

  async check(sessionId: string, userId: string, token: string): Promise<SessionState> {
    const key = `${userId}:${sessionId}`;
    const hit = this.entries.get(key);
    const now = this.now();
    if (hit && now - hit.at < this.ttlMs) {
      return hit.state;
    }
    const state = await this.inner.check(sessionId, userId, token);
    if (state !== "unknown") {
      this.entries.delete(key);
      this.entries.set(key, { state, at: now });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.entries.delete(oldest);
      }
    }
    return state;
  }

  /** Entries held, for tests. */
  get size(): number {
    return this.entries.size;
  }
}

/** Error codes from Supabase Auth that mean the session or its user is gone
 * (supabase.com/docs/guides/auth/debugging/error-codes). */
const ENDED_CODES = new Set(["session_not_found", "session_expired", "user_not_found", "user_banned"]);

export interface AuthApiSessionCheckerOptions {
  /** Supabase Auth's issuer, such as https://<ref>.supabase.co/auth/v1. */
  issuer: string;
  /** The project's anon key, which Supabase's gateway requires. */
  anonKey: string;
  /** Sent as X-JWT-AUD so GET /user accepts the hook's audience. */
  audience: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The session through Supabase's GET /auth/v1/user. */
export class AuthApiSessionChecker implements SessionChecker {
  constructor(private readonly options: AuthApiSessionCheckerOptions) {}

  async check(_sessionId: string, _userId: string, token: string): Promise<SessionState> {
    const { issuer, anonKey, audience } = this.options;
    if (!issuer || !anonKey) {
      return "unknown";
    }
    try {
      const response = await (this.options.fetch ?? fetch)(`${issuer.replace(/\/+$/, "")}/user`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "X-JWT-AUD": audience },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
        cache: "no-store",
      });
      if (response.ok) {
        return "alive";
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        const body = (await response.json().catch(() => null)) as { error_code?: unknown; code?: unknown } | null;
        const code = typeof body?.error_code === "string" ? body.error_code : typeof body?.code === "string" ? body.code : "";
        return ENDED_CODES.has(code) ? "ended" : "unknown";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }
}

function errorCodeOf(err: unknown): string | undefined {
  for (let current: unknown = err, depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Postgres answers that mean the owner role cannot read auth.sessions:
 * insufficient privilege, no such table, schema or column. */
const NO_ACCESS_CODES = new Set(["42501", "42P01", "3F000", "42703"]);

/** The session through auth.sessions over the owner connection, falling back
 * to the Auth API when that read is not allowed. */
export class DbSessionChecker implements SessionChecker {
  private sqlUsable = true;

  constructor(
    private readonly db: Db,
    private readonly fallback: SessionChecker,
  ) {}

  async check(sessionId: string, userId: string, token: string): Promise<SessionState> {
    if (!this.sqlUsable) {
      return this.fallback.check(sessionId, userId, token);
    }
    try {
      const result = (await this.db.execute(
        sql`select 1 as alive from auth.sessions
            where id = ${sessionId}::uuid and user_id = ${userId}::uuid
              and (not_after is null or not_after > now())
            limit 1`,
      )) as unknown as Array<{ alive: number }> | { rows: Array<{ alive: number }> };
      // postgres-js answers an array; PGlite (tests) a result with rows.
      const rows = Array.isArray(result) ? result : result.rows;
      return rows.length > 0 ? "alive" : "ended";
    } catch (err) {
      const code = errorCodeOf(err);
      if (code && NO_ACCESS_CODES.has(code)) {
        this.sqlUsable = false;
        console.warn(`[mcp-auth] auth.sessions is not readable (${code}); checking sessions through the Auth API`);
        return this.fallback.check(sessionId, userId, token);
      }
      return "unknown";
    }
  }
}

/** Every session counts as live: the in memory demo, which has no Supabase. */
export const DEMO_SESSION_CHECKER: SessionChecker = {
  check: async () => "alive",
};
