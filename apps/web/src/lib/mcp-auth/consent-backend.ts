/**
 * What the consent page (P19-09) and Connected apps (P19-10) read and write
 * (docs/phases/PHASE_19.md, "Consent page", "Sign up inside the flow" and
 * "Revocation").
 *
 * In db mode the signed in user is the web session, the authorization
 * request is Supabase's OAuth server (supabase.auth.oauth, auth-js 2.117.2),
 * and connection rows, memberships and workspaces are read over the owner
 * connection, which bypasses RLS: the logic in ./consent and ./connected-apps
 * checks the user, the client and the membership before any write.
 *
 * The consented path: when the user consented to the client before,
 * Supabase approves at once and answers only redirect_url (docs/verification
 * .md, "PHASE_19", SB4 authorize.go). The client id then comes from
 * auth.oauth_authorizations, read over the owner connection by the
 * authorization id and the user (SB4 migration 20250804100000). Whether the
 * owner role may read that table on hosted Supabase is checked in P19-12;
 * when it cannot, the page fails closed and follows no link.
 *
 * In demo mode (no Supabase) a MemoryConsentBackend serves three fixed
 * authorization requests and three demo people chosen by a cookie, so the
 * e2e suite runs the page without Supabase. getConsentBackend calls
 * getServices() first, which throws DemoModeRefusedError in production, so
 * the demo never answers a real request.
 */

import { and, eq, inArray, members, sql, workspaces, type Db } from "@curvi/db";
import { DEMO_OWNER_ID } from "@/lib/api-keys/backend";
import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME } from "@/lib/services/demo";
import type { WorkspaceRole } from "@/lib/services/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recordTermsAcceptanceSafely } from "@/lib/trust/terms";
import { demoMcpConnectionStore } from "./backend";
import { mcpOAuthConfig, mcpOAuthEnabled } from "./config";
import { DbMcpConnectionStore, type McpConnectionStore } from "./connections";

export interface ConsentUser {
  id: string;
  email: string | null;
}

export interface ConsentMembership {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  /** When the user joined the workspace (members.created_at). */
  joinedAt: Date;
}

/** What Supabase answered for an authorization request. */
export type AuthorizationLookup =
  /** The user has not consented to this client: show the consent page. */
  | { kind: "details"; clientId: string; clientName: string | null; scopes: string[] }
  /** The user consented before: Supabase approved and answered the link
   * back to the client, with a code that lasts 10 minutes. */
  | { kind: "consented"; redirectUrl: string }
  | { kind: "signed_out" }
  /** Unknown, expired, or no longer pending. */
  | { kind: "expired" }
  | { kind: "unavailable" };

/** An approved authorization read from auth.oauth_authorizations. */
export interface StoredAuthorization {
  clientId: string;
  clientName: string | null;
  scopes: string[];
  /** The client's registered redirect URI the code is sent to. */
  redirectUri: string;
}

export type ConsentDecision = { ok: true; redirectUrl: string } | { ok: false; reason: "expired" | "unavailable" | "signed_out" };

export interface ConsentBackend {
  readonly mode: "db" | "demo";
  readonly connections: McpConnectionStore;
  /** False while the kill switch is off (MCP_OAUTH_ENABLED): the consent
   * page then approves nothing and writes no connection. */
  signInEnabled(): boolean;
  /** The Supabase OAuth client ids Curvi works with (MCP_OAUTH_CLIENT_IDS). */
  allowedClientIds(): readonly string[];
  /** The signed in user of this browser, or null. */
  currentUser(): Promise<ConsentUser | null>;
  /** A first visit after signup: the user's first workspace (with the free
   * signup grant) and the server side terms record, as /app does. Best
   * effort; never throws. */
  prepareUser(user: ConsentUser, headers: Headers): Promise<void>;
  getAuthorization(authorizationId: string): Promise<AuthorizationLookup>;
  /** The approved authorization of this user, null when there is none (or
   * it is older than the code's 10 minutes), "unavailable" when it could not
   * be read. */
  storedAuthorization(authorizationId: string, userId: string): Promise<StoredAuthorization | null | "unavailable">;
  approve(authorizationId: string): Promise<ConsentDecision>;
  deny(authorizationId: string): Promise<ConsentDecision>;
  /** The user's workspaces, oldest membership first. */
  listMemberships(userId: string): Promise<ConsentMembership[]>;
  /** The user's role in the workspace today, or null. */
  role(userId: string, workspaceId: string): Promise<WorkspaceRole | null>;
  /** Workspace names by id (missing ids are left out). */
  workspaceNames(ids: readonly string[]): Promise<Map<string, string>>;
  /** Revokes the signed in user's own grant to the client with their web
   * session (Supabase revokes the consent and deletes that client's sessions
   * and refresh tokens). True when Supabase confirmed it. */
  revokeOwnGrant(clientId: string): Promise<boolean>;
  /** Deletes the user's sessions for the client over the owner connection,
   * so their tokens fail the session check within a minute. True when the
   * delete ran. */
  endSessions(userId: string, clientId: string): Promise<boolean>;
  /** Signs this browser out, and only this browser (scope local): a global
   * sign out would also end every ChatGPT session of the user. */
  signOutHere(): Promise<void>;
}

/** Supabase authorization ids are 32 letters and digits (SB4
 * models/oauth_authorization.go). auth-js puts the id into the request path
 * unescaped, so anything else is refused before it reaches Supabase. */
const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function parseAuthorizationId(raw: unknown): string | null {
  return typeof raw === "string" && AUTHORIZATION_ID.test(raw) ? raw : null;
}

/** Space separated scopes, de-duplicated, in order. */
export function parseScopes(scope: unknown): string[] {
  if (typeof scope !== "string") {
    return [];
  }
  return [...new Set(scope.split(/\s+/).filter((s) => s.length > 0))];
}

/** The authorization code lasts 10 minutes from approval (SB1). */
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

// Database backend

type SupabaseServer = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

interface AuthErrorLike {
  name?: unknown;
  status?: unknown;
  code?: unknown;
}

/** Error codes that mean this browser's own session is gone. */
const SIGNED_OUT_CODES = new Set(["session_not_found", "session_expired", "bad_jwt", "no_authorization", "user_not_found"]);

function failureOf(error: unknown): "signed_out" | "expired" | "unavailable" {
  const e = (error ?? {}) as AuthErrorLike;
  if (e.name === "AuthSessionMissingError") {
    return "signed_out";
  }
  const status = typeof e.status === "number" ? e.status : 0;
  const code = typeof e.code === "string" ? e.code : "";
  if (status === 401 || SIGNED_OUT_CODES.has(code)) {
    return "signed_out";
  }
  // 404 not found or expired, 400 no longer pending (SB4 authorize.go).
  if (status >= 400 && status < 500) {
    return "expired";
  }
  return "unavailable";
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

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

/** Postgres answers that mean the owner role cannot read Supabase's auth
 * tables: insufficient privilege, no such table, schema or column. */
const NO_ACCESS_CODES = new Set(["42501", "42P01", "3F000", "42703"]);

class DbConsentBackend implements ConsentBackend {
  readonly mode = "db" as const;
  readonly connections: McpConnectionStore;

  constructor(
    private readonly db: Db,
    private readonly supabase: () => Promise<SupabaseServer | null> = createSupabaseServerClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.connections = new DbMcpConnectionStore(db);
  }

  signInEnabled(): boolean {
    return mcpOAuthEnabled();
  }

  allowedClientIds(): readonly string[] {
    return mcpOAuthConfig().clientIds;
  }

  async currentUser(): Promise<ConsentUser | null> {
    const supabase = await this.supabase();
    if (!supabase) {
      return null;
    }
    try {
      const { data } = await supabase.auth.getUser();
      return data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
    } catch {
      return null;
    }
  }

  async prepareUser(user: ConsentUser, headers: Headers): Promise<void> {
    try {
      // Provisions the first workspace when the signup trigger could not,
      // and settles a signup grant the confirmation trigger could not pay
      // (DbService.getCurrentWorkspace, migration 0012).
      await getServices().ensureWorkspace();
    } catch (err) {
      console.error("[consent] could not prepare the workspace", err instanceof Error ? err.name : "error");
    }
    await recordTermsAcceptanceSafely(this.db, { userId: user.id, source: "assistant_consent", headers });
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationLookup> {
    const supabase = await this.supabase();
    if (!supabase) {
      return { kind: "unavailable" };
    }
    try {
      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (error || !data) {
        return { kind: error ? failureOf(error) : "unavailable" };
      }
      if ("authorization_id" in data) {
        return {
          kind: "details",
          clientId: data.client.id,
          clientName: data.client.name || null,
          scopes: parseScopes(data.scope),
        };
      }
      return typeof data.redirect_url === "string" ? { kind: "consented", redirectUrl: data.redirect_url } : { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async storedAuthorization(authorizationId: string, userId: string): Promise<StoredAuthorization | null | "unavailable"> {
    try {
      const result = await this.db.execute(sql`
        select a.client_id::text as client_id, a.scope, a.redirect_uri, a.status::text as status,
               a.approved_at, c.client_name
        from auth.oauth_authorizations a
        left join auth.oauth_clients c on c.id = a.client_id
        where a.authorization_id = ${authorizationId} and a.user_id = ${userId}::uuid
        limit 1
      `);
      const row = rowsOf<{
        client_id: string;
        scope: string;
        redirect_uri: string;
        status: string;
        approved_at: Date | string | null;
        client_name: string | null;
      }>(result)[0];
      if (!row || row.status !== "approved" || !row.approved_at) {
        return null;
      }
      const approvedAt = new Date(row.approved_at).getTime();
      if (!Number.isFinite(approvedAt) || this.now().getTime() - approvedAt > AUTHORIZATION_CODE_TTL_MS) {
        return null;
      }
      return {
        clientId: row.client_id,
        clientName: row.client_name || null,
        scopes: parseScopes(row.scope),
        redirectUri: row.redirect_uri,
      };
    } catch (err) {
      const code = errorCodeOf(err);
      console.warn(
        code && NO_ACCESS_CODES.has(code)
          ? `[consent] auth.oauth_authorizations is not readable (${code}); the consented path cannot check the client`
          : "[consent] could not read the authorization",
      );
      return "unavailable";
    }
  }

  async approve(authorizationId: string): Promise<ConsentDecision> {
    return this.decide(authorizationId, "approve");
  }

  async deny(authorizationId: string): Promise<ConsentDecision> {
    return this.decide(authorizationId, "deny");
  }

  private async decide(authorizationId: string, action: "approve" | "deny"): Promise<ConsentDecision> {
    const supabase = await this.supabase();
    if (!supabase) {
      return { ok: false, reason: "unavailable" };
    }
    try {
      const { data, error } =
        action === "approve"
          ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
          : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (error || !data?.redirect_url) {
        return { ok: false, reason: error ? failureOf(error) : "unavailable" };
      }
      return { ok: true, redirectUrl: data.redirect_url };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  async listMemberships(userId: string): Promise<ConsentMembership[]> {
    const rows = await this.db
      .select({
        workspaceId: members.workspaceId,
        role: members.role,
        joinedAt: members.createdAt,
        workspaceName: workspaces.name,
      })
      .from(members)
      .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
      .where(eq(members.userId, userId))
      .orderBy(members.createdAt, members.workspaceId);
    return rows.map((row) => ({ ...row, role: row.role as WorkspaceRole }));
  }

  async role(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const rows = await this.db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.userId, userId), eq(members.workspaceId, workspaceId)))
      .limit(1);
    return (rows[0]?.role as WorkspaceRole | undefined) ?? null;
  }

  async workspaceNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(inArray(workspaces.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async revokeOwnGrant(clientId: string): Promise<boolean> {
    const supabase = await this.supabase();
    if (!supabase) {
      return false;
    }
    try {
      const { error } = await supabase.auth.oauth.revokeGrant({ clientId });
      return !error;
    } catch {
      return false;
    }
  }

  async endSessions(userId: string, clientId: string): Promise<boolean> {
    try {
      await this.db.execute(
        sql`delete from auth.sessions where user_id = ${userId}::uuid and oauth_client_id = ${clientId}::uuid`,
      );
      return true;
    } catch (err) {
      const code = errorCodeOf(err);
      console.warn(`[connected-apps] could not end the client's sessions (${code ?? "error"}); the revoked row still stops every call`);
      return false;
    }
  }

  async signOutHere(): Promise<void> {
    const supabase = await this.supabase();
    try {
      await supabase?.auth.signOut({ scope: "local" });
    } catch {
      // The page shows the sign in form either way.
    }
  }
}

/** The database backend over a given connection (tests pass their own). */
export function dbConsentBackend(
  db: Db,
  supabase?: () => Promise<SupabaseServer | null>,
  now?: () => Date,
): ConsentBackend {
  return new DbConsentBackend(db, supabase, now);
}

// Memory backend (demo and tests)

/** An authorization request held in memory. */
export interface MemoryAuthorization {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  redirectUri: string;
  /** pending asks for consent; consented means the user consented to the
   * client before, so a lookup approves at once as Supabase does. */
  state: "pending" | "consented" | "approved" | "denied" | "expired";
  /** The user the request belongs to once someone signed in looked at it. */
  userId?: string | null;
}

/** A seat in the memory backend. */
export interface MemoryConsentSeat extends ConsentMembership {
  userId: string;
}

export interface MemoryConsentBackendOptions {
  user: ConsentUser | null;
  seats: MemoryConsentSeat[];
  authorizations?: MemoryAuthorization[];
  connections: McpConnectionStore;
  clientIds: readonly string[];
  /** Answers "unavailable" for storedAuthorization (an unreadable table). */
  storedUnavailable?: boolean;
  /** Answers revokeOwnGrant with false (the OAuth server is off). */
  grantRevokeFails?: boolean;
  /** false acts as MCP_OAUTH_ENABLED off; unset is on. */
  signInEnabled?: boolean;
}

/** What a MemoryConsentBackend was asked to do, for tests. */
export interface MemoryConsentCalls {
  prepared: string[];
  approved: string[];
  denied: string[];
  revokedGrants: Array<{ userId: string | null; clientId: string }>;
  endedSessions: Array<{ userId: string; clientId: string }>;
  signedOut: number;
}

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export class MemoryConsentBackend implements ConsentBackend {
  readonly mode = "demo" as const;
  readonly connections: McpConnectionStore;
  readonly calls: MemoryConsentCalls = {
    prepared: [],
    approved: [],
    denied: [],
    revokedGrants: [],
    endedSessions: [],
    signedOut: 0,
  };
  private readonly authorizations: Map<string, MemoryAuthorization>;

  constructor(private readonly options: MemoryConsentBackendOptions) {
    this.connections = options.connections;
    this.authorizations = new Map((options.authorizations ?? []).map((a) => [a.id, { ...a, scopes: [...a.scopes] }]));
  }

  /** The state of a request, for tests. */
  authorization(id: string): MemoryAuthorization | undefined {
    return this.authorizations.get(id);
  }

  /** The demo stays on whatever the switch says: it never runs in
   * production (DemoModeRefusedError), and the e2e suite runs the endpoint
   * dark beside the consent page. */
  signInEnabled(): boolean {
    return this.options.signInEnabled ?? true;
  }

  allowedClientIds(): readonly string[] {
    return this.options.clientIds;
  }

  async currentUser(): Promise<ConsentUser | null> {
    return this.options.user;
  }

  async prepareUser(user: ConsentUser): Promise<void> {
    this.calls.prepared.push(user.id);
  }

  private redirectFor(auth: MemoryAuthorization, approved: boolean): string {
    return approved
      ? withQuery(auth.redirectUri, { code: `memory-code-${auth.id}`, state: "memory-state" })
      : withQuery(auth.redirectUri, { error: "access_denied", state: "memory-state" });
  }

  /** The request as the signed in user sees it: it binds to the first user
   * who looks at it, and another user gets not found (SB4 authorize.go). */
  private requestFor(id: string): MemoryAuthorization | "signed_out" | null {
    const user = this.options.user;
    if (!user) {
      return "signed_out";
    }
    const auth = this.authorizations.get(id);
    if (!auth) {
      return null;
    }
    if (auth.userId && auth.userId !== user.id) {
      return null;
    }
    auth.userId = user.id;
    return auth;
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationLookup> {
    const auth = this.requestFor(authorizationId);
    if (auth === "signed_out") {
      return { kind: "signed_out" };
    }
    if (!auth) {
      return { kind: "expired" };
    }
    if (auth.state === "pending") {
      return { kind: "details", clientId: auth.clientId, clientName: auth.clientName, scopes: [...auth.scopes] };
    }
    if (auth.state === "consented") {
      auth.state = "approved";
      return { kind: "consented", redirectUrl: this.redirectFor(auth, true) };
    }
    return { kind: "expired" };
  }

  async storedAuthorization(authorizationId: string, userId: string): Promise<StoredAuthorization | null | "unavailable"> {
    if (this.options.storedUnavailable) {
      return "unavailable";
    }
    const auth = this.authorizations.get(authorizationId);
    if (!auth || auth.userId !== userId || (auth.state !== "approved" && auth.state !== "consented")) {
      return null;
    }
    return { clientId: auth.clientId, clientName: auth.clientName, scopes: [...auth.scopes], redirectUri: auth.redirectUri };
  }

  async approve(authorizationId: string): Promise<ConsentDecision> {
    return this.decide(authorizationId, true);
  }

  async deny(authorizationId: string): Promise<ConsentDecision> {
    return this.decide(authorizationId, false);
  }

  private async decide(authorizationId: string, approve: boolean): Promise<ConsentDecision> {
    const auth = this.requestFor(authorizationId);
    if (auth === "signed_out") {
      return { ok: false, reason: "signed_out" };
    }
    if (!auth || auth.state !== "pending") {
      return { ok: false, reason: "expired" };
    }
    auth.state = approve ? "approved" : "denied";
    (approve ? this.calls.approved : this.calls.denied).push(authorizationId);
    return { ok: true, redirectUrl: this.redirectFor(auth, approve) };
  }

  async listMemberships(userId: string): Promise<ConsentMembership[]> {
    return this.options.seats
      .filter((seat) => seat.userId === userId)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
      .map(({ workspaceId, workspaceName, role, joinedAt }) => ({ workspaceId, workspaceName, role, joinedAt }));
  }

  async role(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    return this.options.seats.find((seat) => seat.userId === userId && seat.workspaceId === workspaceId)?.role ?? null;
  }

  async workspaceNames(ids: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const seat of this.options.seats) {
      if (ids.includes(seat.workspaceId)) {
        names.set(seat.workspaceId, seat.workspaceName);
      }
    }
    return names;
  }

  async revokeOwnGrant(clientId: string): Promise<boolean> {
    this.calls.revokedGrants.push({ userId: this.options.user?.id ?? null, clientId });
    return !this.options.grantRevokeFails;
  }

  async endSessions(userId: string, clientId: string): Promise<boolean> {
    this.calls.endedSessions.push({ userId, clientId });
    return true;
  }

  async signOutHere(): Promise<void> {
    this.calls.signedOut += 1;
  }
}

// Demo fixtures (no Supabase): the e2e suite and local runs.

/** The demo's ChatGPT client, allowlisted in demo mode only. */
export const DEMO_CONSENT_CLIENT_ID = "00000000-0000-4000-8000-00000000c001";
/** A client Curvi does not work with. */
export const DEMO_UNKNOWN_CLIENT_ID = "00000000-0000-4000-8000-00000000c002";
/** Where the demo's requests send the browser back; e2e stubs this host. */
export const DEMO_CONSENT_REDIRECT_URI = "https://chatgpt.com/connector/oauth/demo-callback";
/** Fixed demo requests. Any other id reads as expired. */
export const DEMO_AUTHORIZATION_IDS = {
  fresh: "demo-fresh",
  consented: "demo-consented",
  unknownClient: "demo-unknown-client",
} as const;
/** The cookie that picks the demo person; unset is the demo owner. */
export const DEMO_CONSENT_USER_COOKIE = "curvi_demo_consent_user";

export type DemoConsentPerson = "owner" | "teammate" | "signed_out";

/** The demo teammate (DEMO_MEMBERS in lib/services/demo), who also owns a
 * second workspace, so the picker shows. */
export const DEMO_TEAMMATE_ID = "00000000-0000-4000-8000-000000000202";
export const DEMO_SECOND_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000b2";
export const DEMO_SECOND_WORKSPACE_NAME = "Teammate Studio";

const DEMO_SEATS: MemoryConsentSeat[] = [
  {
    userId: DEMO_OWNER_ID,
    workspaceId: DEMO_WORKSPACE_ID,
    workspaceName: DEMO_WORKSPACE_NAME,
    role: "owner",
    joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    userId: DEMO_TEAMMATE_ID,
    workspaceId: DEMO_WORKSPACE_ID,
    workspaceName: DEMO_WORKSPACE_NAME,
    role: "editor",
    joinedAt: new Date("2026-02-01T00:00:00.000Z"),
  },
  {
    userId: DEMO_TEAMMATE_ID,
    workspaceId: DEMO_SECOND_WORKSPACE_ID,
    workspaceName: DEMO_SECOND_WORKSPACE_NAME,
    role: "owner",
    joinedAt: new Date("2026-03-01T00:00:00.000Z"),
  },
];

const DEMO_PEOPLE: Record<Exclude<DemoConsentPerson, "signed_out">, ConsentUser> = {
  owner: { id: DEMO_OWNER_ID, email: "owner@example.com" },
  teammate: { id: DEMO_TEAMMATE_ID, email: "teammate@example.com" },
};

/** ChatGPT asks for every scope Supabase advertises (O1, L1). */
const DEMO_SCOPES = ["openid", "email", "profile", "phone", "offline_access"];

function demoAuthorizations(): MemoryAuthorization[] {
  const base = { clientName: "ChatGPT", scopes: DEMO_SCOPES, redirectUri: DEMO_CONSENT_REDIRECT_URI };
  return [
    { ...base, id: DEMO_AUTHORIZATION_IDS.fresh, clientId: DEMO_CONSENT_CLIENT_ID, state: "pending" },
    { ...base, id: DEMO_AUTHORIZATION_IDS.consented, clientId: DEMO_CONSENT_CLIENT_ID, state: "consented" },
    {
      ...base,
      id: DEMO_AUTHORIZATION_IDS.unknownClient,
      clientId: DEMO_UNKNOWN_CLIENT_ID,
      clientName: "Another app",
      state: "pending",
    },
  ];
}

export function demoConsentPerson(cookie: string | null | undefined): DemoConsentPerson {
  return cookie === "signed_out" || cookie === "teammate" ? cookie : "owner";
}

/** The demo backend: fresh authorization requests on every call (so the
 * fixed ids never run out), the process wide demo connection rows. */
export function demoConsentBackend(person: DemoConsentPerson = "owner"): MemoryConsentBackend {
  return new MemoryConsentBackend({
    user: person === "signed_out" ? null : DEMO_PEOPLE[person],
    seats: DEMO_SEATS,
    authorizations: demoAuthorizations(),
    connections: demoMcpConnectionStore(),
    clientIds: [DEMO_CONSENT_CLIENT_ID, ...mcpOAuthConfig().clientIds],
  });
}

/**
 * The backend for this request. Db mode reads Supabase and the database;
 * anything less is the demo, after getServices() refused it in production
 * (DemoModeRefusedError, which the page and actions answer with the
 * unavailable copy). demoPerson is the demo cookie, ignored in db mode.
 */
export function getConsentBackend(options: { demoPerson?: string | null } = {}): ConsentBackend {
  if (isDbMode()) {
    return new DbConsentBackend(getDb());
  }
  getServices();
  return demoConsentBackend(demoConsentPerson(options.demoPerson));
}
