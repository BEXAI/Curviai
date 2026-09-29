/**
 * Storage for workspace API keys. DbApiKeyStore (./db-store) reads and
 * writes api_keys over the owner connection, which bypasses RLS, so every
 * method that names a workspace filters by it here; the prefix lookup is the
 * one read across workspaces, because a key arrives before its workspace is
 * known. MemoryApiKeyStore backs the in memory demo server and the tests.
 */

import type { ApiScope } from "./format";

export interface ApiKeyRecord {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

/** What the settings page lists: never the hash. */
export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface NewApiKeyRecord {
  workspaceId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: ApiScope[];
  createdBy: string | null;
}

export interface ApiKeyStore {
  /** Every key of the workspace, newest first, revoked ones included. */
  list(workspaceId: string): Promise<ApiKeyRecord[]>;
  /** Keys of the workspace that are not revoked. */
  countActive(workspaceId: string): Promise<number>;
  create(input: NewApiKeyRecord): Promise<ApiKeyRecord>;
  /** Sets revoked_at on a key of this workspace. False when there is no
   * such key; true when it is revoked now or already was. */
  revoke(workspaceId: string, id: string, at: Date): Promise<boolean>;
  /** The key with this prefix in any workspace, or null. */
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  /** Records a use of the key. */
  touch(id: string, at: Date): Promise<void>;
}

export function apiKeyViewOf(record: ApiKeyRecord): ApiKeyView {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: [...record.scopes],
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

export class MemoryApiKeyStore implements ApiKeyStore {
  private readonly rows = new Map<string, ApiKeyRecord>();
  private seq = 0;

  constructor(seed: readonly ApiKeyRecord[] = []) {
    for (const row of seed) {
      this.rows.set(row.id, { ...row });
    }
  }

  async list(workspaceId: string): Promise<ApiKeyRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({ ...row }));
  }

  async countActive(workspaceId: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId && !row.revokedAt).length;
  }

  async create(input: NewApiKeyRecord): Promise<ApiKeyRecord> {
    if ([...this.rows.values()].some((row) => row.prefix === input.prefix)) {
      throw new Error("duplicate api key prefix");
    }
    this.seq += 1;
    const id = `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
    const record: ApiKeyRecord = {
      id,
      ...input,
      scopes: [...input.scopes],
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(Date.now() + this.seq),
    };
    this.rows.set(id, record);
    return { ...record };
  }

  async revoke(workspaceId: string, id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId) {
      return false;
    }
    row.revokedAt ??= at;
    return true;
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const row = [...this.rows.values()].find((r) => r.prefix === prefix);
    return row ? { ...row } : null;
  }

  async touch(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.lastUsedAt = at;
    }
  }
}
