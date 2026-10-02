import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@curvi/db/testing";
import { type Db } from "@curvi/db";
import { queueView } from "./queue-view";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { fixture = await createTestDb(); });
afterAll(async () => { await fixture.client.close(); });
afterEach(() => vi.unstubAllEnvs());
describe("global queue estimate", () => {
  it("uses the seeded fallback, then a median of completed durations, exposing only counts", async () => {
    vi.stubEnv("CURVI_INLINE_PACK_CONCURRENCY", "2");
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await fixture.client.query("insert into workspaces (id,name) values ($1,'a'),($2,'b')", [a, b]);
    await fixture.client.query("insert into products (id,workspace_id,title,mode) values ($1,$1,'a','listing'),($2,$2,'b','listing')", [a, b]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const row = await fixture.client.query<{ id: string }>("insert into generation_jobs (workspace_id,product_id,status,created_at) values ($1,$1,'queued',$2) returning id", [i === 1 ? b : a, new Date(Date.UTC(2026, 9, 1, 0, 0, i))]);
      ids.push(row.rows[0].id);
    }
    expect(await queueView(fixture.db as unknown as Db, ids[2])).toEqual({ position: 3, etaSeconds: 480 });
    for (const seconds of [60, 180, 600]) await fixture.client.query("insert into generation_jobs (workspace_id,product_id,status,started_at,finished_at) values ($1,$1,'done',$2,$3)", [b, new Date("2026-10-01T00:00:00Z"), new Date(Date.UTC(2026, 9, 1, 0, 0, seconds))]);
    expect(await queueView(fixture.db as unknown as Db, ids[0])).toEqual({ position: 1, etaSeconds: 180 });
    expect(await queueView(fixture.db as unknown as Db, ids[2])).toEqual({ position: 3, etaSeconds: 360 });
  });
});
