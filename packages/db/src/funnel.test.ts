import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "./client";
import { cleanFunnelProps, recordFunnelEvent, type FunnelEventInput } from "./funnel";
import { events, workspaces } from "./schema";
import { createTestDb, type TestDb } from "./test-helpers";

// Phase 18 contract (P18-02): recordFunnelEvent writes funnel.<name>, the
// first row once per workspace, and never throws. The concurrency test for
// the first row relies on the events_funnel_first_uq index from the
// attribution_and_funnel migration (Lane 1).

let client: PGlite;
let db: TestDb;
let writer: Db;
let wsA: string;
let wsB: string;

const quiet = { log: { error: vi.fn() } };

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  writer = db as unknown as Db;
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  wsB = b.id;
});

afterAll(async () => {
  await client.close();
});

async function namesFor(workspaceId: string | null): Promise<string[]> {
  const rows = await db.select().from(events);
  return rows.filter((row) => row.workspaceId === workspaceId).map((row) => row.name);
}

describe("recordFunnelEvent", () => {
  it("writes funnel.<name> with clean props", async () => {
    const result = await recordFunnelEvent(writer, {
      workspaceId: wsA,
      name: "signup_confirmed",
      props: { method: "email", source: "home" },
    });
    expect(result).toEqual({ recorded: true, firstRecorded: false });
    const rows = (await db.select().from(events)).filter((row) => row.name === "funnel.signup_confirmed");
    expect(rows).toHaveLength(1);
    expect(rows[0].props).toEqual({ method: "email", source: "home" });
  });

  it("writes the first row once per workspace and the plain row every time", async () => {
    const input: FunnelEventInput = { workspaceId: wsA, name: "pack_done", first: true, props: { passed: 6 } };
    expect(await recordFunnelEvent(writer, input)).toEqual({ recorded: true, firstRecorded: true });
    expect(await recordFunnelEvent(writer, input)).toEqual({ recorded: true, firstRecorded: false });
    expect(await recordFunnelEvent(writer, { ...input, workspaceId: wsB })).toEqual({
      recorded: true,
      firstRecorded: true,
    });
    const names = await namesFor(wsA);
    expect(names.filter((name) => name === "funnel.pack_done")).toHaveLength(2);
    expect(names.filter((name) => name === "funnel.first_pack_done")).toHaveLength(1);
    expect((await namesFor(wsB)).filter((name) => name === "funnel.first_pack_done")).toHaveLength(1);
  });

  it("writes the first row once when calls race, and every plain row", async () => {
    const [c] = await db.insert(workspaces).values({ name: "C" }).returning();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        recordFunnelEvent(writer, { workspaceId: c.id, name: "payment", first: true, props: { plan: "starter" } }),
      ),
    );
    expect(results.every((result) => result.recorded)).toBe(true);
    expect(results.filter((result) => result.firstRecorded)).toHaveLength(1);
    const names = await namesFor(c.id);
    expect(names.filter((name) => name === "funnel.payment")).toHaveLength(6);
    expect(names.filter((name) => name === "funnel.first_payment")).toHaveLength(1);
  });

  it("is backed by events_funnel_first_uq, so even a write that skips the check stays single", async () => {
    const [d] = await db.insert(workspaces).values({ name: "D" }).returning();
    await client.query("insert into events (workspace_id, name) values ($1, 'funnel.first_pack_started')", [d.id]);
    const duplicate = await client.query(
      "insert into events (workspace_id, name) values ($1, 'funnel.first_pack_started') on conflict do nothing returning id",
      [d.id],
    );
    expect(duplicate.rows).toHaveLength(0);
    const index = await client.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'events_funnel_first_uq'",
    );
    expect(index.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .*\(workspace_id, name\) WHERE \(name ~~ 'funnel\.first_%'::text\)/);
  });

  it("writes no first row without a workspace", async () => {
    const result = await recordFunnelEvent(writer, { workspaceId: null, name: "download", first: true });
    expect(result).toEqual({ recorded: true, firstRecorded: false });
    expect(await namesFor(null)).not.toContain("funnel.first_download");
  });

  it("never throws when the database fails", async () => {
    const broken = {
      insert: () => {
        throw new Error("connection refused");
      },
      execute: () => Promise.reject(new Error("connection refused")),
    } as unknown as Db;
    const log = { error: vi.fn() };
    const result = await recordFunnelEvent(
      broken,
      { workspaceId: wsA, name: "payment", first: true, props: { plan: "growth_annual_marker" } },
      { log },
    );
    expect(result).toEqual({ recorded: false, firstRecorded: false });
    expect(log.error).toHaveBeenCalledTimes(2);
    // The log names the step and the error, never the props.
    expect(String(log.error.mock.calls[0][0])).toContain("funnel_event_failed");
    expect(log.error.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("growth_annual_marker");
  });

  it("refuses a name outside the list without writing", async () => {
    const before = (await db.select().from(events)).length;
    const result = await recordFunnelEvent(
      writer,
      { workspaceId: wsA, name: "made_up" } as unknown as FunnelEventInput,
      quiet,
    );
    expect(result).toEqual({ recorded: false, firstRecorded: false });
    expect((await db.select().from(events)).length).toBe(before);
  });
});

describe("cleanFunnelProps", () => {
  it("keeps flat values and drops emails, objects, bad keys and non finite numbers", () => {
    expect(
      cleanFunnelProps({
        source: "home",
        credits: 8,
        passed: true,
        promo: null,
        email: "seller@example.com",
        nested: { a: 1 },
        list: [1],
        "Bad-Key": "x",
        ratio: Number.NaN,
      }),
    ).toEqual({ source: "home", credits: 8, passed: true, promo: null });
  });

  it("cuts long strings and caps the number of props", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(cleanFunnelProps(many))).toHaveLength(20);
    expect(cleanFunnelProps({ note: "a".repeat(500) }).note).toHaveLength(200);
    expect(cleanFunnelProps(null)).toEqual({});
    expect(cleanFunnelProps(["a"])).toEqual({});
  });
});
