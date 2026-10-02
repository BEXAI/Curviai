/**
 * What an OAuth connection acts as (docs/phases/PHASE_19.md, "Workspace
 * scoping"). In db mode the connection rows live in mcp_connections and a
 * connection acts as its user in its workspace: every call re-reads the
 * membership and the workspace, as the API key backend does for a key's
 * maker, so a member who leaves or a role change applies at once, and the
 * calls run through a DbService whose user is that member. In demo mode the
 * rows live in memory next to the shared DemoService, whose owner seat is
 * the only member.
 */

import type { Db } from "@curvi/db";
import { optionalEnv } from "@/lib/env";
import { DEMO_OWNER_ID, type ApiPrincipal } from "@/lib/api-keys/backend";
import type { WorkspaceRole } from "@/lib/services/types";
import { isDbMode, getServices, type Services } from "@/lib/services";
import { DbService, getDb } from "@/lib/services/db";
import { DEMO_TIER, DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME } from "@/lib/services/demo";
import { mcpOAuthConfig } from "./config";
import { DbMcpConnectionStore, MemoryMcpConnectionStore, type McpConnectionStore } from "./connections";
import {
  AuthApiSessionChecker,
  CachedSessionChecker,
  DEMO_SESSION_CHECKER,
  DbSessionChecker,
  type SessionChecker,
} from "./sessions";

export interface McpAuthBackend {
  readonly mode: "db" | "demo";
  readonly connections: McpConnectionStore;
  readonly sessions: SessionChecker;
  /** The workspaces the user belongs to. */
  workspacesOf(userId: string): Promise<string[]>;
  /** The workspace and the user's seat there today, or null when the user
   * is not a member or the workspace is gone. */
  principal(userId: string, workspaceId: string): Promise<ApiPrincipal | null>;
  /** The services a call through this connection runs with. */
  servicesFor(principal: ApiPrincipal, email: string | null): Services;
}

const globalScope = globalThis as typeof globalThis & {
  __curviMcpAuthBackend?: McpAuthBackend;
  __curviMcpSessionChecker?: SessionChecker;
  __curviDemoMcpConnections?: MemoryMcpConnectionStore;
};

/** One cached session checker per process, so its 60 second cache is shared
 * by every request. */
function dbSessionChecker(db: Db): SessionChecker {
  if (!globalScope.__curviMcpSessionChecker) {
    const config = mcpOAuthConfig();
    globalScope.__curviMcpSessionChecker = new CachedSessionChecker(
      new DbSessionChecker(
        db,
        new AuthApiSessionChecker({
          issuer: config.issuer,
          anonKey: optionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY") ?? "",
          audience: config.resource,
        }),
      ),
    );
  }
  return globalScope.__curviMcpSessionChecker;
}

class DbMcpAuthBackend implements McpAuthBackend {
  readonly mode = "db" as const;
  readonly connections: McpConnectionStore;
  readonly sessions: SessionChecker;

  constructor(
    private readonly db: Db = getDb(),
    sessions?: SessionChecker,
  ) {
    this.connections = new DbMcpConnectionStore(db);
    this.sessions = sessions ?? dbSessionChecker(db);
  }

  async workspacesOf(userId: string): Promise<string[]> {
    const rows = await this.db.query.members.findMany({
      where: (t, { eq }) => eq(t.userId, userId),
      columns: { workspaceId: true },
    });
    return rows.map((row) => row.workspaceId);
  }

  async principal(userId: string, workspaceId: string): Promise<ApiPrincipal | null> {
    const [membership, workspace] = await Promise.all([
      this.db.query.members.findFirst({
        where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.userId, userId)),
      }),
      this.db.query.workspaces.findFirst({ where: (t, { eq }) => eq(t.id, workspaceId) }),
    ]);
    if (!membership || !workspace) {
      return null;
    }
    return { workspaceId: workspace.id, workspaceName: workspace.name, plan: workspace.plan, role: membership.role, userId };
  }

  servicesFor(principal: ApiPrincipal, email: string | null): Services {
    return new DbService({
      db: this.db,
      getUserId: async () => principal.userId,
      getUserEmail: async () => email,
      getSupabase: async () => null,
    });
  }
}

/** A seat in the memory backend. */
export interface MemoryMembership {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  plan: string;
  role: WorkspaceRole;
}

export interface MemoryMcpAuthBackendOptions {
  /** Seats, read on every call: tests remove one to see the effect. */
  memberships: MemoryMembership[];
  connections?: McpConnectionStore;
  sessions?: SessionChecker;
  services?: () => Services;
}

class MemoryMcpAuthBackend implements McpAuthBackend {
  readonly mode = "demo" as const;
  readonly connections: McpConnectionStore;
  readonly sessions: SessionChecker;
  private readonly services: () => Services;

  constructor(private readonly options: MemoryMcpAuthBackendOptions) {
    this.connections = options.connections ?? new MemoryMcpConnectionStore();
    this.sessions = options.sessions ?? DEMO_SESSION_CHECKER;
    this.services = options.services ?? getServices;
  }

  async workspacesOf(userId: string): Promise<string[]> {
    return this.options.memberships.filter((m) => m.userId === userId).map((m) => m.workspaceId);
  }

  async principal(userId: string, workspaceId: string): Promise<ApiPrincipal | null> {
    const seat = this.options.memberships.find((m) => m.userId === userId && m.workspaceId === workspaceId);
    return seat
      ? { workspaceId: seat.workspaceId, workspaceName: seat.workspaceName, plan: seat.plan, role: seat.role, userId }
      : null;
  }

  servicesFor(): Services {
    return this.services();
  }
}

/** The database backend over a given connection (tests pass their own). */
export function dbMcpAuthBackend(db: Db, sessions?: SessionChecker): McpAuthBackend {
  return new DbMcpAuthBackend(db, sessions);
}

/** Test and demo seam: a backend over seats held in memory. */
export function memoryMcpAuthBackend(options: MemoryMcpAuthBackendOptions): McpAuthBackend {
  return new MemoryMcpAuthBackend(options);
}

/** The demo workspace's owner seat, the only member of the in memory demo. */
export const DEMO_MCP_MEMBERSHIP: MemoryMembership = {
  userId: DEMO_OWNER_ID,
  workspaceId: DEMO_WORKSPACE_ID,
  workspaceName: DEMO_WORKSPACE_NAME,
  plan: DEMO_TIER,
  role: "owner",
};

/** The in memory demo's connection rows, one store per process, shared by
 * the MCP server, the consent page and Connected apps (P19-09, P19-10). */
export function demoMcpConnectionStore(): MemoryMcpConnectionStore {
  globalScope.__curviDemoMcpConnections ??= new MemoryMcpConnectionStore();
  return globalScope.__curviDemoMcpConnections;
}

/** The backend for this server: db mode reads mcp_connections, anything
 * less is the demo (getServices() refuses demo mode in production first,
 * throwing DemoModeRefusedError, which the caller answers with a 503). */
export function getMcpAuthBackend(): McpAuthBackend {
  if (globalScope.__curviMcpAuthBackend) {
    return globalScope.__curviMcpAuthBackend;
  }
  if (isDbMode()) {
    return new DbMcpAuthBackend();
  }
  getServices();
  return new MemoryMcpAuthBackend({ memberships: [DEMO_MCP_MEMBERSHIP], connections: demoMcpConnectionStore() });
}

/** Test hook: swap the backend (null returns to the env default). */
export function setMcpAuthBackendForTests(backend: McpAuthBackend | null): void {
  globalScope.__curviMcpAuthBackend = backend ?? undefined;
}
