import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiKeys,
  assetVariants,
  assets,
  generationJobs,
  mcpConnections,
  members,
  packFiles,
  products,
  workspaces,
} from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { and, eq, loadChannelSpecs, type Db } from "@curvi/db";
import { dbMcpLinkBackend } from "./mcp-links-backend";
import type { McpLinkBackend } from "./mcp-links";

// What a click on a lasting link reads (PHASE_19 P19-17), against the real
// migrations in PGlite: the connection or key still live with its member in
// the workspace, and the file still in that job and workspace.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let backend: McpLinkBackend;
let userCounter = 500;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await loadChannelSpecs(db as unknown as Db);
  // mcp_connections is the real table from migration 0028 (P19-05).
  backend = dbMcpLinkBackend(db as unknown as Db);
});

afterAll(async () => {
  await client.close();
});

function nextUser(): string {
  userCounter += 1;
  return `00000000-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
}

async function workspaceWithMember(): Promise<{ id: string; user: string; productId: string }> {
  const user = nextUser();
  const [w] = await db.insert(workspaces).values({ name: `WS ${userCounter}`, plan: "free" }).returning();
  await db.insert(members).values({ workspaceId: w!.id, userId: user, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: w!.id, title: "Mug", mode: "listing" }).returning();
  return { id: w!.id, user, productId: p!.id };
}

async function connection(workspaceId: string, userId: string): Promise<string> {
  const [row] = await db
    .insert(mcpConnections)
    .values({ workspaceId, userId, oauthClientId: "chatgpt", clientName: "ChatGPT", profileId: "A".repeat(22) })
    .returning({ id: mcpConnections.id });
  return row!.id;
}

async function deliveredJob(w: { id: string; productId: string }, status: "done" | "generating" = "done") {
  const [job] = await db.insert(generationJobs).values({ workspaceId: w.id, productId: w.productId, status }).returning();
  const [asset] = await db
    .insert(assets)
    .values({ workspaceId: w.id, jobId: job!.id, shotType: "amazon_main", approved: true, qc: {} })
    .returning();
  const [variant] = await db
    .insert(assetVariants)
    .values({
      workspaceId: w.id,
      assetId: asset!.id,
      channelSpecId: "amazon.main",
      r2Key: `ws/${w.id}/jobs/${job!.id}/files/amazon/MUG1.MAIN.jpg`,
      filename: "MUG1.MAIN.jpg",
      bytes: 1234,
    })
    .returning();
  const [report] = await db
    .insert(packFiles)
    .values({
      workspaceId: w.id,
      jobId: job!.id,
      kind: "report",
      filename: "compliance-report.json",
      r2Key: `ws/${w.id}/jobs/${job!.id}/pack/compliance-report.json`,
    })
    .returning();
  return { jobId: job!.id, variant: `v_${variant!.id}`, variantId: variant!.id, report: `p_${report!.id}` };
}

describe("subjectLive", () => {
  it("holds for a live connection whose member is still in the workspace", async () => {
    const w = await workspaceWithMember();
    const id = await connection(w.id, w.user);
    expect(await backend.subjectLive({ kind: "connection", id }, w.id)).toBe(true);
  });

  it("ends when the connection is revoked, the member leaves, or the link names another workspace", async () => {
    const w = await workspaceWithMember();
    const other = await workspaceWithMember();
    const revoked = await connection(w.id, w.user);
    await client.query("update mcp_connections set revoked_at = now() where id = $1", [revoked]);
    expect(await backend.subjectLive({ kind: "connection", id: revoked }, w.id)).toBe(false);

    const live = await connection(w.id, w.user);
    expect(await backend.subjectLive({ kind: "connection", id: live }, other.id)).toBe(false);
    await db.delete(members).where(and(eq(members.workspaceId, w.id), eq(members.userId, w.user)));
    expect(await backend.subjectLive({ kind: "connection", id: live }, w.id)).toBe(false);
    expect(await backend.subjectLive({ kind: "connection", id: "00000000-0000-4000-8000-0000000000ff" }, w.id)).toBe(false);
  });

  it("holds for an unrevoked key while its maker is a member, and ends otherwise", async () => {
    const w = await workspaceWithMember();
    const [key] = await db
      .insert(apiKeys)
      .values({ workspaceId: w.id, name: "k", prefix: `cv_live_${userCounter}`, keyHash: "h", createdBy: w.user })
      .returning();
    expect(await backend.subjectLive({ kind: "key", id: key!.id }, w.id)).toBe(true);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, key!.id));
    expect(await backend.subjectLive({ kind: "key", id: key!.id }, w.id)).toBe(false);

    const [second] = await db
      .insert(apiKeys)
      .values({ workspaceId: w.id, name: "k2", prefix: `cv_live_${userCounter}b`, keyHash: "h", createdBy: w.user })
      .returning();
    await db.delete(members).where(and(eq(members.workspaceId, w.id), eq(members.userId, w.user)));
    expect(await backend.subjectLive({ kind: "key", id: second!.id }, w.id)).toBe(false);
  });
});

describe("fileOf", () => {
  it("finds an image but refuses a report without readable stored checks", async () => {
    const w = await workspaceWithMember();
    const job = await deliveredJob(w);
    expect(await backend.fileOf(w.id, job.jobId, job.variant)).toEqual({
      key: `ws/${w.id}/jobs/${job.jobId}/files/amazon/MUG1.MAIN.jpg`,
      filename: "MUG1.MAIN.jpg",
      kind: "image",
    });
    expect(await backend.fileOf(w.id, job.jobId, job.report)).toBeNull();
  });

  it("refuses a file of another job or workspace, a deleted file and a pack that serves no files", async () => {
    const w = await workspaceWithMember();
    const other = await workspaceWithMember();
    const mine = await deliveredJob(w);
    const second = await deliveredJob(w);
    const theirs = await deliveredJob(other);
    expect(await backend.fileOf(w.id, mine.jobId, second.variant)).toBeNull();
    expect(await backend.fileOf(w.id, mine.jobId, theirs.variant)).toBeNull();
    expect(await backend.fileOf(other.id, mine.jobId, mine.variant)).toBeNull();
    expect(await backend.fileOf(w.id, mine.jobId, "v_nope")).toBeNull();

    await db.delete(assetVariants).where(eq(assetVariants.id, mine.variantId));
    expect(await backend.fileOf(w.id, mine.jobId, mine.variant)).toBeNull();

    const running = await deliveredJob(w, "generating");
    expect(await backend.fileOf(w.id, running.jobId, running.variant)).toBeNull();
  });
});
