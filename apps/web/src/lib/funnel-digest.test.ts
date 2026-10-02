/**
 * The weekly funnel email (docs/phases/PHASE_18.md P18-02) against the real
 * migrations: the plan's fixture of 10 confirmed signups, 4 first packs and
 * 1 payment reads as 40 percent activation and 1 first payment, grouped by
 * source; a cron that runs every day of a week sends one email.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordFunnelEvent, type Db } from "@curvi/db";
import { leads, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { composeFunnelDigest, runFunnelDigest, type SendFounderEmail } from "./funnel-digest";
import { funnelDigestDue, gateReadouts, isoWeekKey, isoWeekStart, loadFunnelReport } from "./funnel-report";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
const owner = () => db as unknown as Db;

// Monday 2026-10-12, 09:00 UTC: the last 7 days hold the whole fixture.
const NOW = new Date("2026-10-12T09:00:00.000Z");
const IN_WEEK = (day: number, hour = 10) => new Date(Date.UTC(2026, 9, 5 + day, hour));
const SELF = ["reddit", "reddit", "search", "search", "search", "friend", "ai_assistant", null, null, "reddit"];
const UTM = ["reddit", "reddit", null, null, null, null, null, "newsletter", null, "reddit"];
const PAGE = ["home", "home", "pricing", "home", "help", "share", "home", "home", "pillar", "home"];

const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const [w] = await db.insert(workspaces).values({ name: `seller ${i}` }).returning();
    ids.push(w.id);
    await recordFunnelEvent(owner(), {
      workspaceId: w.id,
      name: "signup_confirmed",
      at: IN_WEEK(i % 6),
      props: { method: "email", source: PAGE[i], self_reported: SELF[i], utm_source: UTM[i] },
    });
  }
  // Four activate; the first finishes a second pack two days later (repeat).
  for (const i of [0, 1, 2, 3]) {
    await recordFunnelEvent(owner(), { workspaceId: ids[i], name: "pack_started", first: true, at: IN_WEEK(i % 6, 11) });
    await recordFunnelEvent(owner(), {
      workspaceId: ids[i],
      name: "pack_done",
      first: true,
      at: IN_WEEK(i % 6, 12),
      props: { job_id: `job-${i}-a`, passed: 6 },
    });
  }
  await recordFunnelEvent(owner(), { workspaceId: ids[0], name: "pack_done", first: true, at: IN_WEEK(2, 12), props: { job_id: "job-0-b" } });
  await recordFunnelEvent(owner(), { workspaceId: ids[0], name: "download", first: true, at: IN_WEEK(0, 13), props: { kind: "zip" } });
  await recordFunnelEvent(owner(), {
    workspaceId: ids[0],
    name: "payment",
    first: true,
    at: IN_WEEK(1, 9),
    props: { kind: "subscription", plan: "starter", amount_usd: 29 },
  });
  await recordFunnelEvent(owner(), { workspaceId: null, name: "lead_captured", at: IN_WEEK(1), props: { source: "main-image-checker" } });
  await db.insert(leads).values([
    { email: "a@example.com", source: "main-image-checker", createdAt: IN_WEEK(1) },
    { email: "b@example.com", source: "main-image-checker", createdAt: IN_WEEK(2) },
    { email: "c@example.com", source: "gallery", createdAt: IN_WEEK(3) },
  ]);
  // Before day 0: never counted.
  const [old] = await db.insert(workspaces).values({ name: "old" }).returning();
  await recordFunnelEvent(owner(), { workspaceId: old.id, name: "signup_confirmed", at: new Date("2026-09-20T10:00:00Z") });
});

afterAll(async () => {
  await client.close();
});

describe("loadFunnelReport", () => {
  it("matches a hand count of the fixture", async () => {
    const report = await loadFunnelReport(owner(), { now: NOW });
    for (const stats of [report.week, report.since]) {
      expect(stats.confirmedSignups).toBe(10);
      expect(stats.activation).toEqual({ hits: 4, of: 10 });
      expect(stats.firstPacksStarted).toBe(4);
      expect(stats.firstPacksDone).toBe(4);
      expect(stats.firstDownloads).toBe(1);
      expect(stats.payments).toBe(1);
      expect(stats.firstPayments).toBe(1);
      expect(stats.paymentsUsd).toBe(29);
      expect(stats.repeat).toEqual({ hits: 1, of: 4 });
      expect(stats.leadsCaptured).toBe(1);
    }
    expect(report.since.bySelfReported).toEqual([
      { label: "reddit", count: 3 },
      { label: "search", count: 3 },
      { label: "not answered", count: 2 },
      { label: "ai_assistant", count: 1 },
      { label: "friend", count: 1 },
    ]);
    expect(report.since.byUtmSource[0]).toEqual({ label: "no utm_source", count: 6 });
    expect(report.since.byUtmSource).toContainEqual({ label: "reddit", count: 3 });
    expect(report.since.byPageSource[0]).toEqual({ label: "home", count: 6 });
    expect(report.since.newLeads).toEqual([
      { label: "main-image-checker", count: 2 },
      { label: "gallery", count: 1 },
    ]);
    expect(report.weekly.at(-2)).toEqual({ week: "2026-10-05", signups: 10, firstPacksDone: 4, firstDownloads: 1, firstPayments: 1 });
    expect(report.weekly.at(-1)?.week).toBe("2026-10-12");
  });

  it("reads the gates against their seeded lines", async () => {
    const report = await loadFunnelReport(owner(), { now: NOW });
    const byKey = Object.fromEntries(report.gates.map((g) => [g.gate.key, g]));
    // 40 percent of 10 signups, but the gate needs 20 signups to be read.
    expect(byKey.day30_activation).toMatchObject({ value: 40, denominator: 10, state: "too_early" });
    expect(byKey.day30_first_payments).toMatchObject({ value: 1, state: "met" });
    expect(byKey.day14_usable).toMatchObject({ value: 0, state: "too_early" });
    expect(byKey.day60_paid_share).toMatchObject({ value: 10, state: "met" });
    expect(byKey.day90_payers).toMatchObject({ value: 1, state: "watch" });
  });

  it("calls a low reading below the doubt line once the sample is big enough", () => {
    const since = {
      activation: { hits: 3, of: 30 },
      feedback: { hits: 2, of: 12 },
      payerRepeat: { hits: 0, of: 0 },
      firstPayments: 0,
    } as never;
    const states = Object.fromEntries(gateReadouts(since).map((g) => [g.gate.key, g.state]));
    expect(states.day30_activation).toBe("doubt");
    expect(states.day14_usable).toBe("doubt");
    expect(states.day60_payer_repeat).toBe("too_early");
  });
});

describe("composeFunnelDigest", () => {
  it("reports activation, first payments and sources in plain text", async () => {
    const email = composeFunnelDigest(await loadFunnelReport(owner(), { now: NOW }));
    expect(email.subject).toBe("Curvi weekly funnel, week of October 12, 2026");
    expect(email.text).toMatch(/Confirmed signups\s+10\s+10/);
    expect(email.text).toMatch(/Activation of these signups\s+40% \(4 of 10\)\s+40% \(4 of 10\)/);
    expect(email.text).toMatch(/First payments\s+1\s+1/);
    expect(email.text).toMatch(/Paid, in US dollars\s+\$29\.00\s+\$29\.00/);
    expect(email.text).toMatch(/reddit\s+3\s+3/);
    expect(email.text).toMatch(/main-image-checker\s+2\s+2/);
    expect(email.text).toContain("Day 30 (Oct 31)");
    expect(email.text).not.toContain("@");
    expect(`${email.subject}\n${email.text}`).not.toMatch(FORBIDDEN_COPY);
  });
});

describe("the send schedule", () => {
  it("is due from Monday 13:00 UTC in each ISO week", () => {
    expect(isoWeekKey(new Date("2026-10-12T00:00:00Z"))).toBe("2026-W42");
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeekStart(new Date("2026-10-18T23:00:00Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(funnelDigestDue(new Date("2026-10-12T12:59:00Z"))).toBe(false);
    expect(funnelDigestDue(new Date("2026-10-12T13:00:00Z"))).toBe(true);
    expect(funnelDigestDue(new Date("2026-10-15T08:00:00Z"))).toBe(true);
  });

  it("sends one email when the cron runs every day of a week, and tries again after a failure", async () => {
    const send = vi.fn<SendFounderEmail>(async () => ({ ok: true }));
    const extraSections = vi.fn(async () => ["Money", "Real metrics", "Operations", "Real counts", "Triggers"]);
    const outcomes: string[] = [];
    for (let day = 0; day < 7; day++) {
      const now = new Date(Date.UTC(2026, 9, 19 + day, 8));
      outcomes.push((await runFunnelDigest(owner(), { now, send, extraSections })).status);
    }
    // Monday 08:00 is before the send time; Tuesday sends; the rest skip.
    expect(outcomes).toEqual(["not_due", "sent", "already_sent", "already_sent", "already_sent", "already_sent", "already_sent"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(extraSections).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].text).toContain("Money\nReal metrics\nOperations\nReal counts\nTriggers");

    const failing = vi.fn<SendFounderEmail>(async () => ({ ok: false, notice: "Resend returned status 500.", retryable: true }));
    const monday = new Date("2026-10-26T13:30:00Z");
    expect((await runFunnelDigest(owner(), { now: monday, send: failing })).status).toBe("send_failed");
    expect((await runFunnelDigest(owner(), { now: monday, send })).status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("composes a dry run at any time without claiming the week", async () => {
    const send = vi.fn<SendFounderEmail>(async () => ({ ok: true }));
    const now = new Date("2026-11-02T09:00:00Z");
    const dry = await runFunnelDigest(owner(), { now, dryRun: true, send });
    expect(dry.status).toBe("dry_run");
    expect(send).not.toHaveBeenCalled();
    expect((await runFunnelDigest(owner(), { now: new Date("2026-11-02T14:00:00Z"), send })).status).toBe("sent");
  });
});

describe("operator workspaces", () => {
  it("are left out of the seller funnel, but their prospect packs still count", async () => {
    // Supabase's auth.users, as far as the report reads it.
    await client.exec("create table if not exists auth.users (id uuid primary key, email text)");
    const operator = "00000000-0000-4000-8000-00000000ab01";
    const [w] = await db.insert(workspaces).values({ name: "founder" }).returning();
    await client.query("insert into auth.users (id, email) values ($1, 'Founder@Curvi.ai')", [operator]);
    await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner')", [w.id, operator]);
    await recordFunnelEvent(owner(), { workspaceId: w.id, name: "signup_confirmed", at: IN_WEEK(4) });
    await recordFunnelEvent(owner(), { workspaceId: w.id, name: "pack_done", first: true, at: IN_WEEK(4, 11), props: { job_id: "f-1" } });
    await recordFunnelEvent(owner(), { workspaceId: w.id, name: "prospect_pack_made", at: IN_WEEK(4, 12) });

    const counted = await loadFunnelReport(owner(), { now: NOW });
    expect(counted.since.confirmedSignups).toBe(11);
    expect(counted.since.prospectPacks).toBe(1);

    const filtered = await loadFunnelReport(owner(), { now: NOW, operatorEmails: ["founder@curvi.ai"] });
    expect(filtered.excludedWorkspaces).toBe(1);
    expect(filtered.since.confirmedSignups).toBe(10);
    expect(filtered.since.firstPacksDone).toBe(4);
    expect(filtered.since.prospectPacks).toBe(1);
  });
});
