/**
 * api_keys over the owner connection (migration 0024). The owner connection
 * bypasses RLS, so each workspace scoped method filters by workspace_id
 * here; the settings actions check the caller's role before they reach it.
 * The prefix lookup and the last_used_at write run before any user is
 * known, which is why they cannot go through RLS at all.
 */

import { and, apiKeys, desc, eq, sql, type Db } from "@curvi/db";
import type { ApiKeyRecord, ApiKeyStore, NewApiKeyRecord } from "./store";

type Row = typeof apiKeys.$inferSelect;

function recordOf(row: Row): ApiKeyRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.keyHash,
    scopes: [...row.scopes],
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export class DbApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: Db) {}

  async list(workspaceId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.workspaceId, workspaceId))
      .orderBy(desc(apiKeys.createdAt))
      .limit(200);
    return rows.map(recordOf);
  }

  async countActive(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.workspaceId, workspaceId), sql`${apiKeys.revokedAt} is null`));
    return Number(rows[0]?.n ?? 0);
  }

  async create(input: NewApiKeyRecord): Promise<ApiKeyRecord> {
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        workspaceId: input.workspaceId,
        name: input.name,
        prefix: input.prefix,
        keyHash: input.keyHash,
        scopes: [...input.scopes],
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) {
      throw new Error("api key insert returned no row");
    }
    return recordOf(row);
  }

  async revoke(workspaceId: string, id: string, at: Date): Promise<boolean> {
    const found = await this.db
      .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId)))
      .limit(1);
    const key = found[0];
    if (!key) {
      return false;
    }
    if (!key.revokedAt) {
      await this.db
        .update(apiKeys)
        .set({ revokedAt: at })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId), sql`${apiKeys.revokedAt} is null`));
    }
    return true;
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const rows = await this.db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
  }
}
