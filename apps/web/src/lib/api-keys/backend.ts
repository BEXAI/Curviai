/**
 * Where API keys live and what a key acts as. In db mode keys are rows of
 * api_keys and a key acts as the member who made it: its calls run through
 * a DbService whose user is that member, so every role check the web form
 * meets (client seats cannot start packs, a member who left the workspace
 * reaches nothing) applies to the key too. In demo mode keys live in memory
 * next to the shared DemoService, with one fixed key (DEMO_API_KEY) so the
 * CLI and the MCP tests can run against a server with no database.
 */

import type { Db } from "@curvi/db";
import type { WorkspaceRole } from "@/lib/services/types";
import { isDbMode, getServices, type Services } from "@/lib/services";
import { DbService, getDb } from "@/lib/services/db";
import { DEMO_TIER, DEMO_WORKSPACE_ID, DEMO_WORKSPACE_NAME } from "@/lib/services/demo";
import { DbApiKeyStore } from "./db-store";
import { API_SCOPES, DEMO_KEY_TAG, hashApiKey } from "./format";
import { MemoryApiKeyStore, type ApiKeyRecord, type ApiKeyStore } from "./store";

/** The owner seat of the demo workspace (DEMO_MEMBERS in lib/services/demo). */
export const DEMO_OWNER_ID = "00000000-0000-4000-8000-000000000201";

/** The demo server's fixed key. It only opens the shared demo workspace of
 * an in memory server; the database backend refuses its tag. */
export const DEMO_API_KEY = `${DEMO_KEY_TAG}000000000000_${"DemoKeyForTheInMemoryServerOnly".padEnd(43, "0")}`;

/** Who a key acts as, read fresh on every call. */
export interface ApiPrincipal {
  workspaceId: string;
  workspaceName: string;
  /** workspaces.plan, the tier key. */
  plan: string;
  /** The key creator's role in the workspace today. */
  role: WorkspaceRole;
  userId: string;
}

export interface ApiKeyBackend {
  readonly mode: "db" | "demo";
  readonly store: ApiKeyStore;
  /** The workspace and the creator's current seat, or null when the
   * creator left the workspace (or is unknown) or the workspace is gone. */
  principal(record: ApiKeyRecord): Promise<ApiPrincipal | null>;
  /** The services a call made with this key runs through. */
  servicesFor(principal: ApiPrincipal): Services;
  /** True when this backend honors keys with the given prefix. */
  acceptsPrefix(prefix: string): boolean;
}

class DbApiKeyBackend implements ApiKeyBackend {
  readonly mode = "db" as const;
  readonly store: ApiKeyStore;

  constructor(private readonly db: Db = getDb()) {
    this.store = new DbApiKeyStore(db);
  }

  acceptsPrefix(prefix: string): boolean {
    return !prefix.startsWith(DEMO_KEY_TAG);
  }

  async principal(record: ApiKeyRecord): Promise<ApiPrincipal | null> {
    const userId = record.createdBy;
    if (!userId) {
      return null;
    }
    const [membership, workspace] = await Promise.all([
      this.db.query.members.findFirst({
        where: (t, { and, eq }) => and(eq(t.workspaceId, record.workspaceId), eq(t.userId, userId)),
      }),
      this.db.query.workspaces.findFirst({ where: (t, { eq }) => eq(t.id, record.workspaceId) }),
    ]);
    if (!membership || !workspace) {
      return null;
    }
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      plan: workspace.plan,
      role: membership.role,
      userId,
    };
  }

  servicesFor(principal: ApiPrincipal): Services {
    return new DbService({
      db: this.db,
      getUserId: async () => principal.userId,
      getUserEmail: async () => null,
      getSupabase: async () => null,
    });
  }
}

const globalScope = globalThis as typeof globalThis & {
  __curviDemoApiKeys?: MemoryApiKeyStore;
  __curviApiKeyBackend?: ApiKeyBackend;
};

function demoStore(): MemoryApiKeyStore {
  globalScope.__curviDemoApiKeys ??= new MemoryApiKeyStore([
    {
      id: "00000000-0000-4000-8000-0000000003a1",
      workspaceId: DEMO_WORKSPACE_ID,
      name: "Demo key",
      prefix: `${DEMO_KEY_TAG}000000000000`,
      keyHash: hashApiKey(DEMO_API_KEY),
      scopes: [...API_SCOPES],
      lastUsedAt: null,
      revokedAt: null,
      createdBy: DEMO_OWNER_ID,
      createdAt: new Date("2026-09-29T00:00:00.000Z"),
    },
  ]);
  return globalScope.__curviDemoApiKeys;
}

class DemoApiKeyBackend implements ApiKeyBackend {
  readonly mode = "demo" as const;

  constructor(
    readonly store: ApiKeyStore = demoStore(),
    private readonly services: () => Services = getServices,
  ) {}

  acceptsPrefix(): boolean {
    return true;
  }

  async principal(record: ApiKeyRecord): Promise<ApiPrincipal | null> {
    if (record.workspaceId !== DEMO_WORKSPACE_ID) {
      return null;
    }
    return {
      workspaceId: DEMO_WORKSPACE_ID,
      workspaceName: DEMO_WORKSPACE_NAME,
      plan: DEMO_TIER,
      role: "owner",
      userId: record.createdBy ?? DEMO_OWNER_ID,
    };
  }

  servicesFor(): Services {
    return this.services();
  }
}

/** The database backend over a given connection (tests pass their own). */
export function dbApiKeyBackend(db: Db): ApiKeyBackend {
  return new DbApiKeyBackend(db);
}

/** Test and demo seam: a backend over any store and services. */
export function demoApiKeyBackend(store?: ApiKeyStore, services?: () => Services): ApiKeyBackend {
  return new DemoApiKeyBackend(store, services);
}

/** The backend for this server: db mode reads api_keys, anything less is
 * the demo (getServices() refuses demo mode in production first, throwing
 * DemoModeRefusedError, which callers answer with a 503). */
export function getApiKeyBackend(): ApiKeyBackend {
  if (globalScope.__curviApiKeyBackend) {
    return globalScope.__curviApiKeyBackend;
  }
  if (isDbMode()) {
    return new DbApiKeyBackend();
  }
  getServices();
  return new DemoApiKeyBackend();
}

/** Test hook: swap the backend (null returns to the env default). */
export function setApiKeyBackendForTests(backend: ApiKeyBackend | null): void {
  globalScope.__curviApiKeyBackend = backend ?? undefined;
}
