/**
 * The weekly funnel email counts lifecycle emails by template
 * (docs/phases/PHASE_18.md P18-07 acceptance): every send writes
 * funnel.email_sent { template }, and the report groups them per window.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordFunnelEvent, type Db } from "@curvi/db";
import { workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { composeFunnelDigest } from "./funnel-digest";
import { loadFunnelReport } from "./funnel-report";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const owner = () => db as unknown as Db;

const NOW = new Date("2026-10-12T09:00:00.000Z");
const DAY = (day: number) => new Date(Date.UTC(2026, 9, day, 10));

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const [w] = await db.insert(workspaces).values({ name: "seller" }).returning();
  for (const [template, day] of [
    ["welcome", 2],
    ["welcome", 8],
    ["first_pack_nudge_1", 9],
    ["pack_ready", 10],
  ] as const) {
    await recordFunnelEvent(owner(), { workspaceId: w.id, name: "email_sent", at: DAY(day), props: { template, kind: "transactional" } });
  }
  // A lead's email has no workspace and still counts.
  await recordFunnelEvent(owner(), { workspaceId: null, name: "email_sent", at: DAY(9), props: { template: "lead_results" } });
});

afterAll(async () => {
  await client.close();
});

describe("email_sent in the funnel report", () => {
  it("counts sends by template in each window", async () => {
    const report = await loadFunnelReport(owner(), { now: NOW });
    expect(report.since.emailsSent).toEqual([
      { label: "welcome", count: 2 },
      { label: "first_pack_nudge_1", count: 1 },
      { label: "lead_results", count: 1 },
      { label: "pack_ready", count: 1 },
    ]);
    // The last 7 days start on October 5: the October 2 welcome is outside.
    expect(report.week.emailsSent.find((row) => row.label === "welcome")?.count).toBe(1);
  });

  it("shows them in the weekly email", async () => {
    const email = composeFunnelDigest(await loadFunnelReport(owner(), { now: NOW }));
    expect(email.text).toContain("Lifecycle emails sent by template");
    expect(email.text).toMatch(/welcome\s+1\s+2/);
    expect(email.text).toMatch(/pack_ready\s+1\s+1/);
  });
});
