/**
 * Assistant connections (mcp_connections, migration 0028; docs/phases/
 * PHASE_19.md, "Workspace scoping"): which workspace an OAuth client such as
 * ChatGPT acts in for a user. One live row per (user, client) (decision 18);
 * a row is revoked, never made live again; profile_id is made once per user
 * and copied into every later row, so get_profile keeps one id across
 * reconnects and workspace changes (OpenAI O1).
 *
 * DbMcpConnectionStore works over the owner connection, which bypasses RLS:
 * callers check the user, the client and the membership first. Writes that
 * pick a profile id or the live row run in a transaction holding an
 * advisory lock on the user, so two first calls at once agree.
 * MemoryMcpConnectionStore backs the in memory demo and the tests.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, mcpConnections, sql, type Db } from "@curvi/db";

export interface McpConnectionRecord {
  id: string;
  workspaceId: string;
  userId: string;
  oauthClientId: string;
  clientName: string | null;
  profileId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface ConnectInput {
  userId: string;
  oauthClientId: string;
  /** The client's display name from Supabase, when known. */
  clientName: string | null;
  workspaceId: string;
}

export interface McpConnectionStore {
  /** The live row for (user, client), or null. */
  findLive(userId: string, oauthClientId: string): Promise<McpConnectionRecord | null>;
  /** A row by id, live or revoked, or null (signed links, P19-17). */
  findById(id: string): Promise<McpConnectionRecord | null>;
  /**
   * The MCP server's only write of a new row ("Workspace scoping"): makes the
   * first row for (user, client) in the given workspace when no row has
   * ever existed for that pair. Returns the live row (made now, or made by a
   * concurrent first call), or null when a row exists that is revoked, which
   * is never recreated silently.
   */
  createFirst(input: ConnectInput, at: Date): Promise<McpConnectionRecord | null>;
  /**
   * The consent page's write (P19-09): the live row for (user, client) in
   * this workspace. A live row in the same workspace is kept (its client
   * name refreshed); a live row in another workspace is revoked and a new
   * row made, so links tied to the old connection stop working.
   */
  connect(input: ConnectInput, at: Date): Promise<McpConnectionRecord>;
  /** Records a use of the connection. */
  touch(id: string, at: Date): Promise<void>;
  /** Sets revoked_at on a live row; a no op on a revoked one. */
  revoke(id: string, at: Date): Promise<void>;
  /** Every row of the user, live and revoked, newest first (the consent
   * page's workspace default and Connected apps, P19-09 and P19-10). */
  listForUser(userId: string): Promise<McpConnectionRecord[]>;
  /** The live rows in a workspace, newest first (Connected apps for owners
   * and admins, P19-10). */
  listLiveInWorkspace(workspaceId: string): Promise<McpConnectionRecord[]>;
}

/** A new profile id: 16 random bytes, base64url (22 characters). Random,
 * never derived from a secret or an id (O1). */
export function newProfileId(): string {
  return randomBytes(16).toString("base64url");
}

type Row = typeof mcpConnections.$inferSelect;

function recordOf(row: Row): McpConnectionRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    oauthClientId: row.oauthClientId,
    clientName: row.clientName,
    profileId: row.profileId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class DbMcpConnectionStore implements McpConnectionStore {
  constructor(private readonly db: Db) {}

  async findLive(userId: string, oauthClientId: string): Promise<McpConnectionRecord | null> {
    return this.liveIn(this.db, userId, oauthClientId);
  }

  async findById(id: string): Promise<McpConnectionRecord | null> {
    const rows = await this.db.select().from(mcpConnections).where(eq(mcpConnections.id, id)).limit(1);
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async createFirst(input: ConnectInput, at: Date): Promise<McpConnectionRecord | null> {
    return this.db.transaction(async (tx) => {
      await this.lockUser(tx, input.userId);
      const live = await this.liveIn(tx, input.userId, input.oauthClientId);
      if (live) {
        return live;
      }
      const any = await tx
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(and(eq(mcpConnections.userId, input.userId), eq(mcpConnections.oauthClientId, input.oauthClientId)))
        .limit(1);
      if (any.length > 0) {
        return null;
      }
      return this.insertIn(tx, input, at);
    });
  }

  async connect(input: ConnectInput, at: Date): Promise<McpConnectionRecord> {
    return this.db.transaction(async (tx) => {
      await this.lockUser(tx, input.userId);
      const live = await this.liveIn(tx, input.userId, input.oauthClientId);
      if (live && live.workspaceId === input.workspaceId) {
        if (input.clientName !== null && input.clientName !== live.clientName) {
          await tx.update(mcpConnections).set({ clientName: input.clientName }).where(eq(mcpConnections.id, live.id));
          return { ...live, clientName: input.clientName };
        }
        return live;
      }
      if (live) {
        await tx
          .update(mcpConnections)
          .set({ revokedAt: at })
          .where(and(eq(mcpConnections.id, live.id), sql`${mcpConnections.revokedAt} is null`));
      }
      return this.insertIn(tx, input, at);
    });
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.update(mcpConnections).set({ lastUsedAt: at }).where(eq(mcpConnections.id, id));
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.db
      .update(mcpConnections)
      .set({ revokedAt: at })
      .where(and(eq(mcpConnections.id, id), sql`${mcpConnections.revokedAt} is null`));
  }

  async listForUser(userId: string): Promise<McpConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.userId, userId))
      .orderBy(desc(mcpConnections.createdAt));
    return rows.map(recordOf);
  }

  async listLiveInWorkspace(workspaceId: string): Promise<McpConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.workspaceId, workspaceId), sql`${mcpConnections.revokedAt} is null`))
      .orderBy(desc(mcpConnections.createdAt));
    return rows.map(recordOf);
  }

  private async liveIn(db: Db | Tx, userId: string, oauthClientId: string): Promise<McpConnectionRecord | null> {
    const rows = await db
      .select()
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.userId, userId),
          eq(mcpConnections.oauthClientId, oauthClientId),
          sql`${mcpConnections.revokedAt} is null`,
        ),
      )
      .limit(1);
    return rows[0] ? recordOf(rows[0]) : null;
  }

  /** Serializes profile id and live row decisions for one user. */
  private async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mcp_connections:${userId}`}, 0))`);
  }

  private async insertIn(tx: Tx, input: ConnectInput, at: Date): Promise<McpConnectionRecord> {
    const existing = await tx
      .select({ profileId: mcpConnections.profileId })
      .from(mcpConnections)
      .where(eq(mcpConnections.userId, input.userId))
      .orderBy(mcpConnections.createdAt)
      .limit(1);
    const [row] = await tx
      .insert(mcpConnections)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        oauthClientId: input.oauthClientId,
        clientName: input.clientName,
        profileId: existing[0]?.profileId ?? newProfileId(),
        createdAt: at,
      })
      .returning();
    if (!row) {
      throw new Error("mcp_connections insert returned no row");
    }
    return recordOf(row);
  }
}

/** Copies, newest first (ties keep insertion order, latest first). */
function newestFirst(rows: McpConnectionRecord[]): McpConnectionRecord[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime() || b.index - a.index)
    .map(({ row }) => ({ ...row }));
}

export class MemoryMcpConnectionStore implements McpConnectionStore {
  readonly rows: McpConnectionRecord[];

  constructor(rows: McpConnectionRecord[] = []) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  async findLive(userId: string, oauthClientId: string): Promise<McpConnectionRecord | null> {
    const row = this.rows.find((r) => r.userId === userId && r.oauthClientId === oauthClientId && !r.revokedAt);
    return row ? { ...row } : null;
  }

  async findById(id: string): Promise<McpConnectionRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  async createFirst(input: ConnectInput, at: Date): Promise<McpConnectionRecord | null> {
    const live = await this.findLive(input.userId, input.oauthClientId);
    if (live) {
      return live;
    }
    if (this.rows.some((r) => r.userId === input.userId && r.oauthClientId === input.oauthClientId)) {
      return null;
    }
    return this.insert(input, at);
  }

  async connect(input: ConnectInput, at: Date): Promise<McpConnectionRecord> {
    const live = this.rows.find((r) => r.userId === input.userId && r.oauthClientId === input.oauthClientId && !r.revokedAt);
    if (live && live.workspaceId === input.workspaceId) {
      if (input.clientName !== null) {
        live.clientName = input.clientName;
      }
      return { ...live };
    }
    if (live) {
      live.revokedAt = at;
    }
    return this.insert(input, at);
  }

  async touch(id: string, at: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.lastUsedAt = at;
    }
  }

  async revoke(id: string, at: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row && !row.revokedAt) {
      row.revokedAt = at;
    }
  }

  async listForUser(userId: string): Promise<McpConnectionRecord[]> {
    return newestFirst(this.rows.filter((r) => r.userId === userId));
  }

  async listLiveInWorkspace(workspaceId: string): Promise<McpConnectionRecord[]> {
    return newestFirst(this.rows.filter((r) => r.workspaceId === workspaceId && !r.revokedAt));
  }

  private insert(input: ConnectInput, at: Date): McpConnectionRecord {
    const profileId =
      [...this.rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).find((r) => r.userId === input.userId)
        ?.profileId ?? newProfileId();
    const row: McpConnectionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      oauthClientId: input.oauthClientId,
      clientName: input.clientName,
      profileId,
      createdAt: at,
      lastUsedAt: null,
      revokedAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }
}
