/**
 * What the lasting link routes read on each click (PHASE_19 P19-17, see
 * lib/mcp-links): whether the connection or API key that made a link is
 * still live with its member in the workspace, and the stored file the link
 * points at. Reads go over the server's own database connection after the
 * token's signature holds; no client role is involved.
 *
 * mcp_connections comes from migration 0028 (P19-05). The connection check
 * reads the columns the plan fixes (id, workspace_id, user_id, revoked_at)
 * with SQL. Until that migration is applied the read fails, and a
 * connection's link answers 503, which never serves a file.
 */

import { sql, type Db } from "@curvi/db";
import { isWorkspaceKey } from "@/lib/r2";
import { getServices, isDbMode } from "@/lib/services";
import { getDb, servesFiles } from "@/lib/services/db";
import { isUuid } from "@/lib/validation/ids";
import type { LinkSubject, LinkedFile, McpLinkBackend } from "./mcp-links";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** "v_<asset variant id>" or "p_<pack file id>", as listJobFiles names them. */
function parseFileId(fileId: string): { table: "variant" | "pack"; id: string } | null {
  const match = /^([vp])_(.+)$/.exec(fileId);
  if (!match || !isUuid(match[2])) {
    return null;
  }
  return { table: match[1] === "v" ? "variant" : "pack", id: match[2] as string };
}

class DbMcpLinkBackend implements McpLinkBackend {
  constructor(private readonly db: Db) {}

  async subjectLive(subject: LinkSubject, workspaceId: string): Promise<boolean> {
    if (!isUuid(subject.id) || !isUuid(workspaceId)) {
      return false;
    }
    const result =
      subject.kind === "connection"
        ? await this.db.execute(sql`
            select 1 as live
            from mcp_connections c
            join members m on m.workspace_id = c.workspace_id and m.user_id = c.user_id
            where c.id = ${subject.id} and c.workspace_id = ${workspaceId} and c.revoked_at is null
            limit 1`)
        : await this.db.execute(sql`
            select 1 as live
            from api_keys k
            join members m on m.workspace_id = k.workspace_id and m.user_id = k.created_by
            where k.id = ${subject.id} and k.workspace_id = ${workspaceId} and k.revoked_at is null
            limit 1`);
    return rowsOf(result).length > 0;
  }

  /** The same ownership checks as DbService.getJobFileDownload: the job in
   * the workspace and serving files, the file in that job and workspace,
   * and its key inside the workspace's prefix. */
  async fileOf(workspaceId: string, jobId: string, fileId: string): Promise<LinkedFile | null> {
    const parsed = parseFileId(fileId);
    if (!parsed || !isUuid(jobId) || !isUuid(workspaceId)) {
      return null;
    }
    const job = await this.db.query.generationJobs.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
    });
    if (!job || !servesFiles(job)) {
      return null;
    }
    if (parsed.table === "variant") {
      const variant = await this.db.query.assetVariants.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, parsed.id), eq(t.workspaceId, workspaceId)),
      });
      const asset = variant
        ? await this.db.query.assets.findFirst({
            where: (t, { and, eq }) => and(eq(t.id, variant.assetId), eq(t.jobId, job.id), eq(t.workspaceId, workspaceId)),
          })
        : undefined;
      if (!variant || !asset || !isWorkspaceKey(workspaceId, variant.r2Key)) {
        return null;
      }
      return { key: variant.r2Key, filename: variant.filename, kind: "image" };
    }
    const pack = await this.db.query.packFiles.findFirst({
      where: (t, { and, eq }) => and(eq(t.id, parsed.id), eq(t.jobId, job.id), eq(t.workspaceId, workspaceId)),
    });
    if (!pack || !isWorkspaceKey(workspaceId, pack.r2Key)) {
      return null;
    }
    return { key: pack.r2Key, filename: pack.filename, kind: pack.kind === "report" ? "report" : "zip" };
  }
}

/** The in memory demo stores no files, so it never mints a link and no
 * link resolves. */
const DEMO_BACKEND: McpLinkBackend = {
  subjectLive: async () => false,
  fileOf: async () => null,
};

/** The database backend over a given connection (tests pass their own). */
export function dbMcpLinkBackend(db: Db): McpLinkBackend {
  return new DbMcpLinkBackend(db);
}

const globalScope = globalThis as typeof globalThis & { __curviMcpLinkBackend?: McpLinkBackend };

/** The backend for this server: the database in db mode, else the demo
 * (getServices refuses demo mode in production first, throwing
 * DemoModeRefusedError, which the link routes answer with a 503). */
export function getMcpLinkBackend(): McpLinkBackend {
  if (globalScope.__curviMcpLinkBackend) {
    return globalScope.__curviMcpLinkBackend;
  }
  if (isDbMode()) {
    return new DbMcpLinkBackend(getDb());
  }
  getServices();
  return DEMO_BACKEND;
}

/** Test hook: swap the backend the link routes read (null restores it). */
export function setMcpLinkBackendForTests(backend: McpLinkBackend | null): void {
  globalScope.__curviMcpLinkBackend = backend ?? undefined;
}
