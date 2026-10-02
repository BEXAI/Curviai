import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationJobs, members, packFeedback, products, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, type Db } from "@curvi/db";
import { consentedQuotesForJobs, DbFeedbackStore, loadConsentedQuotes } from "./db-store";
import { feedbackLinkToken } from "./link";
import { resolveFeedbackLink } from "./link-actor";
import type { FeedbackAnswer } from "./types";

// Pack feedback (P18-05) against the real migrations in PGlite: one answer
// per pack and person, only on a finished pack in the actor's workspace,
// the funnel step with the usable answer and no free text, the quotes the
// weekly email and the gallery read, and the signed link's membership check.

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let store: DbFeedbackStore;

const OWNER = "00000000-0000-4000-8000-0000000005a1";
const EDITOR = "00000000-0000-4000-8000-0000000005a2";
const STRANGER = "00000000-0000-4000-8000-0000000005b1";
const SECRET = "s".repeat(40);

const ANSWER: FeedbackAnswer = {
  usable: "yes",
  wouldPay: "maybe",
  comment: "The candle looks like the real one.",
  quoteConsent: true,
  displayName: "Ana, Juniper Candles",
};

async function makeWorkspace(name: string, owner: string, status: "done" | "generating" = "done") {
  const [w] = await db.insert(workspaces).values({ name }).returning();
  await db.insert(members).values({ workspaceId: w.id, userId: owner, role: "owner" });
  const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Candle", mode: "listing" }).returning();
  const [job] = await db.insert(generationJobs).values({ workspaceId: w.id, productId: p.id, status }).returning();
  return { workspaceId: w.id, productId: p.id, jobId: job.id };
}

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  store = new DbFeedbackStore(db as unknown as Db);
});

afterAll(async () => {
  await client.close();
});

async function funnelRows(workspaceId: string) {
  const result = await client.query<{ name: string; props: Record<string, unknown> }>(
    "select name, props from events where workspace_id = $1 and name like 'funnel.%'",
    [workspaceId],
  );
  return result.rows;
}

describe("DbFeedbackStore", () => {
  it("shows the card on a finished pack until the person answers, once", async () => {
    const pack = await makeWorkspace("A", OWNER);
    await db.insert(members).values({ workspaceId: pack.workspaceId, userId: EDITOR, role: "editor" });
    const owner = { workspaceId: pack.workspaceId, userId: OWNER };
    expect(await store.status(owner, pack.jobId)).toEqual({ jobId: pack.jobId, eligible: true, answered: false });

    const saved = await store.submit(owner, pack.jobId, ANSWER, "pack_page");
    expect(saved.outcome).toBe("saved");
    expect(await store.status(owner, pack.jobId)).toMatchObject({ answered: true });
    // Another member still gets asked.
    expect(await store.status({ workspaceId: pack.workspaceId, userId: EDITOR }, pack.jobId)).toMatchObject({
      answered: false,
    });

    const again = await store.submit(owner, pack.jobId, { ...ANSWER, usable: "not_yet" }, "pack_page");
    expect(again.outcome).toBe("already");
    const rows = await db.select().from(packFeedback).where(eq(packFeedback.jobId, pack.jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usable: "yes", wouldPay: "maybe", quoteConsent: true, displayName: "Ana, Juniper Candles" });

    const events = await funnelRows(pack.workspaceId);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("funnel.feedback_submitted");
    expect(events[0].props).toEqual({ usable: "yes", would_pay: "maybe", quote: true, commented: true, via: "pack_page" });
  });

  it("refuses a pack that is not finished or not in the actor's workspace", async () => {
    const running = await makeWorkspace("B", OWNER, "generating");
    const other = await makeWorkspace("C", STRANGER);
    const actor = { workspaceId: running.workspaceId, userId: OWNER };
    expect(await store.status(actor, running.jobId)).toEqual({ jobId: running.jobId, eligible: false, answered: false });
    expect(await store.submit(actor, running.jobId, ANSWER, "pack_page")).toMatchObject({
      outcome: "rejected",
      reason: "not_ready",
    });
    expect(await store.status(actor, other.jobId)).toBeNull();
    expect(await store.submit(actor, other.jobId, ANSWER, "pack_page")).toMatchObject({
      outcome: "rejected",
      reason: "not_found",
    });
    expect(await store.status(actor, "not-a-uuid")).toBeNull();
    expect(await funnelRows(other.workspaceId)).toHaveLength(0);
  });

  it("keeps no name without consent", async () => {
    const pack = await makeWorkspace("D", OWNER);
    await store.submit(
      { workspaceId: pack.workspaceId, userId: OWNER },
      pack.jobId,
      { usable: "some", wouldPay: null, comment: "More scenes please", quoteConsent: false, displayName: "Ana" },
      "email_link",
    );
    const [row] = await db.select().from(packFeedback).where(eq(packFeedback.jobId, pack.jobId));
    expect(row).toMatchObject({ quoteConsent: false, displayName: null, wouldPay: null });
  });
});

describe("consented quotes", () => {
  it("lists only consented quotes in the window, leaving excluded workspaces out", async () => {
    const seller = await makeWorkspace("Seller", "00000000-0000-4000-8000-0000000005c1");
    const operator = await makeWorkspace("Operator", "00000000-0000-4000-8000-0000000005c2");
    const at = new Date("2026-10-06T12:00:00Z");
    await db.insert(packFeedback).values([
      { workspaceId: seller.workspaceId, jobId: seller.jobId, userId: "00000000-0000-4000-8000-0000000005c1", usable: "yes", comment: "Ready to list.", quoteConsent: true, displayName: "Sam", createdAt: at },
      { workspaceId: operator.workspaceId, jobId: operator.jobId, userId: "00000000-0000-4000-8000-0000000005c2", usable: "yes", comment: "Founder test.", quoteConsent: true, createdAt: at },
    ]);
    const window = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-07T00:00:00Z") };
    const quotes = await loadConsentedQuotes(db as unknown as Db, window, {
      excludeWorkspaces: [operator.workspaceId],
      limit: 10,
    });
    expect(quotes.map((quote) => quote.text)).toEqual(["Ready to list."]);
    expect(quotes[0]).toMatchObject({ name: "Sam", usable: "yes" });

    const byJob = await consentedQuotesForJobs(db as unknown as Db, [
      { jobId: seller.jobId, workspaceId: seller.workspaceId },
      { jobId: "00000000-0000-4000-8000-0000000005ff", workspaceId: seller.workspaceId },
    ]);
    expect(byJob.get(seller.jobId)).toEqual({ text: "Ready to list.", name: "Sam" });
    // Another pack of the same seller borrows the seller's newest quote.
    expect(byJob.get("00000000-0000-4000-8000-0000000005ff")).toEqual({ text: "Ready to list.", name: "Sam" });
  });
});

describe("signed feedback links", () => {
  it("answer for the member the link names, and refuse anyone else", async () => {
    const pack = await makeWorkspace("Link", OWNER);
    const now = new Date("2026-10-02T00:00:00Z");
    const token = feedbackLinkToken({ jobId: pack.jobId, userId: OWNER }, { now, secret: SECRET })!;
    const target = await resolveFeedbackLink(token, { db: db as unknown as Db, now, secret: SECRET });
    expect(target?.actor).toEqual({ workspaceId: pack.workspaceId, userId: OWNER });
    expect(target?.jobId).toBe(pack.jobId);

    const outsider = feedbackLinkToken({ jobId: pack.jobId, userId: STRANGER }, { now, secret: SECRET })!;
    expect(await resolveFeedbackLink(outsider, { db: db as unknown as Db, now, secret: SECRET })).toBeNull();
    const wrongSecret = feedbackLinkToken({ jobId: pack.jobId, userId: OWNER }, { now, secret: "t".repeat(40) })!;
    expect(await resolveFeedbackLink(wrongSecret, { db: db as unknown as Db, now, secret: SECRET })).toBeNull();
  });
});
