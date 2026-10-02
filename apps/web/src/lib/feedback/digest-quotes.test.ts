/**
 * P18-05, "Founder view": the weekly funnel email lists the usable share
 * (from funnel.feedback_submitted, P18-02) and the new consented quotes in
 * the seller's own words, leaving private answers out.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@curvi/db";
import { generationJobs, members, products, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { composeFunnelDigest } from "@/lib/funnel-digest";
import { loadFunnelReport } from "@/lib/funnel-report";
import { DbFeedbackStore } from "./db-store";

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;

const NOW = new Date("2026-10-12T09:00:00.000Z");
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  const store = new DbFeedbackStore(db as unknown as Db);
  const people = [
    { user: "00000000-0000-4000-8000-0000000007a1", usable: "yes", comment: "Ready to list as they are.", consent: true, name: "Sam, Oak Soap" },
    { user: "00000000-0000-4000-8000-0000000007a2", usable: "some", comment: "Private thought.", consent: false, name: null },
    { user: "00000000-0000-4000-8000-0000000007a3", usable: "not_yet", comment: null, consent: false, name: null },
  ] as const;
  for (const person of people) {
    const [w] = await db.insert(workspaces).values({ name: person.user }).returning();
    await db.insert(members).values({ workspaceId: w.id, userId: person.user, role: "owner" });
    const [p] = await db.insert(products).values({ workspaceId: w.id, title: "Soap", mode: "listing" }).returning();
    const [job] = await db.insert(generationJobs).values({ workspaceId: w.id, productId: p.id, status: "done" }).returning();
    await store.submit(
      { workspaceId: w.id, userId: person.user },
      job.id,
      { usable: person.usable, wouldPay: null, comment: person.comment, quoteConsent: person.consent, displayName: person.name },
      "pack_page",
    );
  }
  // Answers are stamped now; move them into the report's week.
  await client.query("update pack_feedback set created_at = $1", ["2026-10-10T10:00:00Z"]);
  await client.query("update events set at = $1 where name = 'funnel.feedback_submitted'", ["2026-10-10T10:00:00Z"]);
});

afterAll(async () => {
  await client.close();
});

describe("the weekly email's feedback lines", () => {
  it("show the usable share and only the consented quote", async () => {
    const report = await loadFunnelReport(db as unknown as Db, { now: NOW });
    expect(report.quotes?.map((quote) => quote.text)).toEqual(["Ready to list as they are."]);
    const email = composeFunnelDigest(report);
    expect(email.text).toMatch(/Feedback: usable as they are\s+33\.3% \(1 of 3\)/);
    expect(email.text).toContain('"Ready to list as they are." (Sam, Oak Soap; usable: yes)');
    expect(email.text).not.toContain("Private thought.");
    expect(email.text).not.toMatch(FORBIDDEN_COPY);
  });

  it("says when there is no new quote", async () => {
    const report = await loadFunnelReport(db as unknown as Db, { now: new Date("2026-11-30T09:00:00.000Z") });
    expect(composeFunnelDigest(report).text).toContain("New quotes you may use on curvi.ai only, last 7 days: none yet.");
  });
});
