import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assetVariants, assets, channelSpecs, generationJobs, members, packFeedback, products, sourceMedia, workspaces } from "@curvi/db/schema";
import { actAsAuthenticated, actAsSuperuser, createTestDb, type TestDb } from "@curvi/db/testing";
import { type Db } from "@curvi/db";
import { DbCaseStore } from "@/lib/cases/db-store";
import { operatorCases, updateOperatorCase } from "@/lib/ops/cases";
import { canReopen, createCaseInput, operatorCaseInput } from "@/lib/cases/types";

vi.mock("@/lib/ops", () => ({ opsEmails: () => ["operator@example.com"] }));
const OWNER = "10000000-0000-4000-8000-000000000001", REPORTER = "10000000-0000-4000-8000-000000000002", OTHER = "10000000-0000-4000-8000-000000000003", OPERATOR = "10000000-0000-4000-8000-000000000004";
const OTHER_EDITOR = "10000000-0000-4000-8000-000000000005";
const operator = { userId: OPERATOR, email: "operator@example.com" };
let client: Awaited<ReturnType<typeof createTestDb>>["client"], db: TestDb, store: DbCaseStore;
const input = (extra = {}) => ({ requestId: randomUUID(), category: "fidelity" as const, description: "The label in this pack is hard to read.", ...extra });
async function fixture() {
  const [workspace] = await db.insert(workspaces).values({ name: "Case fixture" }).returning();
  await db.insert(members).values([{ workspaceId: workspace.id, userId: OWNER, role: "owner" }, { workspaceId: workspace.id, userId: REPORTER, role: "editor" }, { workspaceId: workspace.id, userId: OTHER, role: "client" }, { workspaceId: workspace.id, userId: OTHER_EDITOR, role: "editor" }]);
  const [product] = await db.insert(products).values({ workspaceId: workspace.id, title: "Mug", mode: "listing" }).returning();
  const [job] = await db.insert(generationJobs).values({ workspaceId: workspace.id, productId: product.id, status: "done" }).returning();
  return { actor: { workspaceId: workspace.id, userId: REPORTER }, owner: { workspaceId: workspace.id, userId: OWNER }, other: { workspaceId: workspace.id, userId: OTHER }, editor: { workspaceId: workspace.id, userId: OTHER_EDITOR }, workspace, product, job };
}
beforeAll(async () => { const made = await createTestDb(); client = made.client; db = made.db; store = new DbCaseStore(db as unknown as Db); });
afterAll(async () => { await client.close(); });
describe("pack case store", () => {
  it("keeps one intake and timeline across retries, links feedback, and isolates reporter/team/tenant access", async () => {
    const f = await fixture(), other = await fixture(), data = input();
    await db.insert(packFeedback).values({ workspaceId: f.workspace.id, jobId: f.job.id, userId: REPORTER, usable: "not_yet", quoteConsent: false });
    const first = await store.create(f.actor, f.job.id, data);
    expect(first).toMatchObject({ created: true, case: { status: "received", feedbackLinked: true } });
    expect(await store.create(f.actor, f.job.id, data)).toMatchObject({ created: false, case: { id: first.case.id } });
    expect(await store.create(f.actor, f.job.id, input())).toMatchObject({ created: false, case: { id: first.case.id } });
    expect((await store.list(f.actor, f.job.id))?.cases).toHaveLength(1);
    expect((await store.list(f.owner, f.job.id))?.cases).toHaveLength(1);
    expect((await store.list(f.other, f.job.id))?.cases).toEqual([]);
    expect((await store.list(f.editor, f.job.id))?.cases).toEqual([]);
    await expect(store.create(f.other, f.job.id, input())).rejects.toMatchObject({ reason: "open_case" });
    expect(await store.list(other.actor, f.job.id)).toBeNull();
    await expect(store.reply(f.other, f.job.id, first.case.id, { requestId: randomUUID(), message: "Read another teammate's case.", reopen: false })).rejects.toMatchObject({ reason: "not_found" });
    await expect(store.reply(f.editor, f.job.id, first.case.id, { requestId: randomUUID(), message: "Read another editor's case.", reopen: false })).rejects.toMatchObject({ reason: "not_found" });
    await expect(store.create(f.actor, f.job.id, { ...data, description: "A different reused payload" })).rejects.toMatchObject({ reason: "request_reused" });
    expect((await client.query("select * from pack_case_events where case_id=$1", [first.case.id])).rows).toHaveLength(1);
  });
  it("another editor sees only their own case and events through both app and raw PostgREST roles", async () => {
    const f = await fixture();
    const privateCase = await store.create(f.actor, f.job.id, input());
    const own = await store.create(f.editor, f.job.id, input({ category: "other" }));
    expect((await store.list(f.editor, f.job.id))?.cases.map((item) => item.id)).toEqual([own.case.id]);
    expect((await store.list(f.actor, f.job.id))?.cases.map((item) => item.id)).toEqual([privateCase.case.id]);
    try {
      await actAsAuthenticated(client, OTHER_EDITOR);
      expect((await client.query<{ id: string }>("select id from pack_cases where workspace_id=$1", [f.workspace.id])).rows.map((row) => row.id)).toEqual([own.case.id]);
      expect((await client.query<{ case_id: string }>("select case_id from pack_case_events where workspace_id=$1", [f.workspace.id])).rows.map((row) => row.case_id)).toEqual([own.case.id]);
    } finally { await actAsSuperuser(client); }
  });
  it("separates private notes, audits public updates, and idempotent resolution never changes credits", async () => {
    const f = await fixture(), opened = await store.create(f.actor, f.job.id, input());
    await updateOperatorCase(db as unknown as Db, operator, opened.case.id, { requestId: randomUUID(), private: true, message: "PRIVATE OPERATOR CONTENT" });
    const resolution = { requestId: randomUUID(), private: false, status: "resolved" as const, message: "Please upload a sharper source photo for the next pack." };
    await Promise.all([updateOperatorCase(db as unknown as Db, operator, opened.case.id, resolution), updateOperatorCase(db as unknown as Db, operator, opened.case.id, resolution)]);
    const publicView = await store.list(f.actor, f.job.id);
    expect(publicView?.cases[0]).toMatchObject({ status: "resolved", canReopen: true });
    expect(publicView?.cases[0]?.events).toHaveLength(2);
    expect(JSON.stringify(publicView)).not.toContain("PRIVATE OPERATOR CONTENT");
    expect(JSON.stringify(publicView)).not.toContain(OPERATOR);
    expect((await operatorCases(db as unknown as Db, operator, opened.case.id))[0]?.notes[0]?.message).toBe("PRIVATE OPERATOR CONTENT");
    expect((await client.query("select * from credit_ledger where workspace_id=$1", [f.workspace.id])).rows).toEqual([]);
    expect((await client.query("select * from ops_audit where target_id=$1", [opened.case.id])).rows).toHaveLength(2);
    await expect(updateOperatorCase(db as unknown as Db, { userId: REPORTER, email: "seller@example.com" }, opened.case.id, resolution)).rejects.toMatchObject({ reason: "not_operator" });
  });
  it("requires explicit timely reopening, preserves history, and deduplicates seller replies", async () => {
    const f = await fixture(), opened = await store.create(f.actor, f.job.id, input());
    await updateOperatorCase(db as unknown as Db, operator, opened.case.id, { requestId: randomUUID(), private: false, status: "resolved", message: "Please try a clearer source photo." });
    const reply = { requestId: randomUUID(), message: "The source photo was already sharp.", reopen: false };
    await expect(store.reply(f.actor, f.job.id, opened.case.id, reply)).rejects.toMatchObject({ reason: "resolved" });
    const reopened = await store.reply(f.actor, f.job.id, opened.case.id, { ...reply, reopen: true });
    expect(reopened.status).toBe("received"); expect(reopened.events).toHaveLength(3);
    expect((await store.reply(f.actor, f.job.id, opened.case.id, { ...reply, reopen: true })).events).toHaveLength(3);
    await updateOperatorCase(db as unknown as Db, operator, opened.case.id, { requestId: randomUUID(), private: false, status: "resolved", message: "The available output matches the source." });
    const later = new DbCaseStore(db as unknown as Db, () => new Date(Date.now() + 31 * 86_400_000));
    await expect(later.reply(f.actor, f.job.id, opened.case.id, { ...reply, requestId: randomUUID(), reopen: true })).rejects.toMatchObject({ reason: "reopen_expired" });
    expect((await later.list(f.actor, f.job.id))?.cases[0]?.canReopen).toBe(false);
  });
  it("refuses foreign output references and detects missing original sources even after a new upload", async () => {
    const f = await fixture();
    await expect(store.create(f.actor, f.job.id, input({ shotId: "not-this-shot" }))).rejects.toMatchObject({ reason: "invalid_reference" });
    await expect(store.create(f.actor, f.job.id, input({ versionId: randomUUID() }))).rejects.toMatchObject({ reason: "invalid_reference" });
    await db.insert(sourceMedia).values({ workspaceId: f.workspace.id, productId: f.product.id, r2Key: `ws/${f.workspace.id}/src/new`, sha256: "a".repeat(64) });
    await db.insert(assets).values({ workspaceId: f.workspace.id, jobId: f.job.id, shotType: "main", qc: { shotId: "main", shot: { sourceMediaId: `ws/${f.workspace.id}/src/expired` } } });
    expect((await store.list(f.actor, f.job.id))?.sourceUnavailable).toBe(true);
    expect(await store.create(f.actor, f.job.id, input({ shotId: "main" }))).toMatchObject({ created: true, case: { shotId: "main" } });
    expect((await client.query("select * from source_media where workspace_id=$1", [f.workspace.id])).rows).toHaveLength(1);
  });
  it("validates exact file and shot correspondence without exposing output URLs", async () => {
    const f = await fixture(), another = await fixture();
    await db.insert(channelSpecs).values({ id: "case.test", version: 1, spec: {} }).onConflictDoNothing();
    const [asset] = await db.insert(assets).values({ workspaceId: f.workspace.id, jobId: f.job.id, shotType: "lifestyle", qc: { shotId: "scene_v2" } }).returning();
    const [variant] = await db.insert(assetVariants).values({ workspaceId: f.workspace.id, assetId: asset.id, channelSpecId: "case.test", filename: "scene-v2.jpg", r2Key: `ws/${f.workspace.id}/out/secret-file-key` }).returning();
    await expect(store.create(another.actor, another.job.id, input({ versionId: variant.id }))).rejects.toMatchObject({ reason: "invalid_reference" });
    await expect(store.create(f.actor, f.job.id, input({ versionId: variant.id, shotId: "wrong_scene" }))).rejects.toMatchObject({ reason: "invalid_reference" });
    const saved = await store.create(f.actor, f.job.id, input({ versionId: variant.id, shotId: "scene_v2" }));
    expect(saved.case).toMatchObject({ versionId: variant.id, shotId: "scene_v2" });
    expect(JSON.stringify(saved)).not.toContain("secret-file-key");
  });
  it("treats purge-eligible source rows as unavailable even before scheduled deletion", async () => {
    const f = await fixture();
    const key = `ws/${f.workspace.id}/src/original`;
    await db.insert(sourceMedia).values({ workspaceId: f.workspace.id, productId: f.product.id, r2Key: key, sha256: "b".repeat(64) });
    await db.insert(assets).values({ workspaceId: f.workspace.id, jobId: f.job.id, shotType: "main", qc: { shotId: "main", shot: { sourceMediaId: key } } });
    expect((await store.list(f.actor, f.job.id))?.sourceUnavailable).toBe(false);
    const later = new DbCaseStore(db as unknown as Db, () => new Date(Date.now() + 31 * 86_400_000));
    expect((await later.list(f.actor, f.job.id))?.sourceUnavailable).toBe(true);
    expect((await client.query("select * from source_media where workspace_id=$1", [f.workspace.id])).rows).toHaveLength(1);
  });
  it("validates bounded plain text and deterministic reopening boundaries", () => {
    expect(createCaseInput.safeParse(input({ description: "a".repeat(2001) })).success).toBe(false);
    expect(createCaseInput.safeParse(input({ description: "Invalid \u0000 control text" })).success).toBe(false);
    expect(operatorCaseInput.safeParse({ requestId: randomUUID(), message: "Explain the next step", status: "refunded" }).success).toBe(false);
    const date = new Date("2026-10-01T00:00:00Z");
    expect(canReopen(date, new Date("2026-10-31T00:00:00Z"))).toBe(true);
    expect(canReopen(date, new Date("2026-10-31T00:00:00.001Z"))).toBe(false);
  });
});
